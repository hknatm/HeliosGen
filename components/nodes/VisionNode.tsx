"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import GenerateButton from "@/components/nodes/GenerateButton";
import CornerResizer from "./CornerResizer";
import TypedHandle from "./TypedHandle";
import NodeStatusBadge from "./NodeStatusBadge";
import NodeActionBar from "./NodeActionBar";
import NodeSection from "./NodeSection";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";
import { customModelId, customModelSupportsVision, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { MULTIMODAL_AGENT_MODEL, resolveReferenceImages } from "@/lib/referenceBundle";
import { resolveInputs } from "@/lib/executor";
import { VISION_PRESETS, runVisionAssessment, visionModelReady, type VisionOutputMode } from "@/lib/vision";
import { loadSystemPromptSettings, type SystemPromptPreset } from "@/lib/systemPrompt";

type VisionNodeType = Node<NodeData, "visionNode">;

export default function VisionNode({ id, data, selected }: NodeProps<VisionNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const kieKeySet = useWorkflowStore((s) => s.kieKeySet);

  const cardRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [customModels, setCustomModels] = useState(() => loadCustomProviderModels());
  const [libraryPrompts, setLibraryPrompts] = useState<SystemPromptPreset[]>(() => loadSystemPromptSettings().presets);

  const status = (data.status as string) ?? "idle";
  const outputText = (data.outputText as string) ?? "";
  const model = (data.visionModel as string) ?? MULTIMODAL_AGENT_MODEL;
  const preset = (data.visionPreset as string) ?? "describe";
  const promptId = typeof data.visionPromptId === "string" ? data.visionPromptId : "";
  const promptMissing = !!promptId && !libraryPrompts.some((p) => p.id === promptId);
  const outputMode: VisionOutputMode = data.visionOutput === "json" ? "json" : "text";
  const question = (data.localPrompt as string) ?? "";
  const busy = loading || status === "running";

  useGeneratingBorderAnimation(cardRef, busy);

  useEffect(() => {
    const refresh = () => setCustomModels(loadCustomProviderModels());
    window.addEventListener("aiui-custom-provider-models-changed", refresh);
    window.addEventListener("aiui-custom-provider-config-changed", refresh);
    return () => {
      window.removeEventListener("aiui-custom-provider-models-changed", refresh);
      window.removeEventListener("aiui-custom-provider-config-changed", refresh);
    };
  }, []);

  useEffect(() => {
    const refresh = () => setLibraryPrompts(loadSystemPromptSettings().presets);
    window.addEventListener("aiui-system-prompts-changed", refresh);
    return () => window.removeEventListener("aiui-system-prompts-changed", refresh);
  }, []);

  const modelOptions = useMemo(() => [
    { id: MULTIMODAL_AGENT_MODEL, label: "GPT 5.2 · Vision" },
    ...customModels
      .filter((m) => m.enabled !== false && customModelSupportsVision(customModelId(m.id)))
      .map((m) => ({ id: customModelId(m.id), label: `${m.name} · Vision` })),
  ], [customModels]);

  const connectedText = useMemo(() => resolveInputs(id, nodes, edges).prompt ?? "", [edges, id, nodes]);
  const resolution = useMemo(() => resolveReferenceImages(id, nodes, edges, "references"), [edges, id, nodes]);
  const references = resolution.references;
  const modelReady = visionModelReady(model);
  const providerReady = !model.startsWith("custom:") || !!loadCustomProviderConfig().baseUrl.trim();
  const keyReady = model.startsWith("custom:") || kieKeySet !== false;
  const canRun = references.length > 0 && modelReady && providerReady && keyReady && !resolution.error;
  const warnings = [
    ...(references.length === 0 ? ["Connect at least one image"] : []),
    ...(!modelReady ? ["Select a Vision-capable model"] : []),
    ...(!providerReady ? ["Configure the custom provider"] : []),
    ...(!keyReady ? ["Add a Kie.ai API key in Settings"] : []),
    ...(resolution.error ? [resolution.error] : []),
  ];

  const handleRun = useCallback(async () => {
    if (busy || !canRun) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    updateNodeData(id, { status: "running", outputText: "", errorMsg: undefined });
    try {
      const { data: { session } } = await createClient().auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      const text = await runVisionAssessment({
        model, presetId: preset, promptId, outputMode, question, connectedText, references, headers,
        signal: controller.signal,
        onDelta: (acc) => updateNodeData(id, { outputText: acc }),
      });
      updateNodeData(id, { status: "done", outputText: text });
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") updateNodeData(id, { status: "idle", outputText: "" });
      else updateNodeData(id, { status: "error", errorMsg: e instanceof Error ? e.message : String(e), outputText: "" });
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [busy, canRun, id, model, preset, promptId, outputMode, question, connectedText, references, updateNodeData]);

  const runRef = useRef(handleRun);
  useEffect(() => { runRef.current = handleRun; }, [handleRun]);
  useEffect(() => {
    if (!data.pendingGenerate) return;
    updateNodeData(id, { pendingGenerate: false });
    runRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.pendingGenerate]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    updateNodeData(id, { status: "idle" });
  }, [id, updateNodeData]);

  const addNode = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const handleDuplicate = useCallback(() => {
    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    onNodesChange([{ type: "select", id, selected: false }]);
    addNode({ ...src, id: newId, position: { x: src.position.x + 20, y: src.position.y + 20 }, selected: true, data: { ...src.data, status: "idle" as const, outputText: undefined } });
    state.edges
      .filter((e) => e.target === id && e.deletable !== false)
      .forEach((e) => insertEdge({ ...e, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), target: newId }));
  }, [id, addNode, insertEdge, onNodesChange]);

  const patch = (p: Partial<NodeData>) => updateNodeData(id, { ...p, outputText: "", status: "idle" });

  const selectCls = "w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50";

  return (
    <div ref={cardRef} className={`node-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`} style={{ minWidth: 280 }}>
      <CornerResizer minWidth={260} minHeight={260} />
      <span className="node-above-label">{data.label as string}</span>
      <NodeStatusBadge status={status} className="absolute -top-[22px] right-0" />
      <NodeActionBar visible={!!selected && !readOnly} hasContent={false} onDelete={() => onNodesChange([{ type: "remove", id }])} onDuplicate={handleDuplicate} />

      <div className="flex-1 min-h-0 flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
          <label className="flex-1 min-w-0">
            <span className="sr-only">Assessment type</span>
            <select
              aria-label="Assessment type"
              className={selectCls}
              value={promptId ? `lib:${promptId}` : preset}
              disabled={readOnly || busy}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith("lib:")) patch({ visionPromptId: v.slice(4) });
                else patch({ visionPreset: v, visionPromptId: undefined });
              }}
            >
              <optgroup label="Built-in">
                {VISION_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </optgroup>
              {(libraryPrompts.length > 0 || promptMissing) && (
                <optgroup label="Prompt library">
                  {promptMissing && <option value={`lib:${promptId}`}>Missing preset · using built-in</option>}
                  {libraryPrompts.map((p) => <option key={p.id} value={`lib:${p.id}`}>{p.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          <div role="group" aria-label="Output format" className="flex shrink-0 rounded-md border border-white/10 overflow-hidden">
            {(["text", "json"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={outputMode === mode} disabled={readOnly || busy}
                onClick={(e) => { e.stopPropagation(); patch({ visionOutput: mode }); }}
                className={`px-2 py-1 text-[10px] uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] ${outputMode === mode ? "bg-white/15 text-foreground" : "text-muted-foreground"}`}>
                {mode}
              </button>
            ))}
          </div>
        </div>

        {references.length > 0 && (
          <div aria-label="Images to assess" className="flex gap-1 overflow-x-auto shrink-0" onMouseDown={(e) => e.stopPropagation()}>
            {references.map((ref, i) => (
              <span key={ref.id} title={ref.usageNote || ref.name} className="shrink-0 rounded border border-orange-400/30 bg-orange-400/10 px-1.5 py-0.5 text-[9px] text-orange-200">{i + 1} · {ref.name}</span>
            ))}
          </div>
        )}

        <label className="shrink-0">
          <span className="sr-only">Question or brief</span>
          <textarea aria-label="Question or brief" rows={2} readOnly={readOnly} value={question}
            placeholder={preset === "brief" ? "Paste or connect the brief to check against…" : "Optional: what should be assessed?"}
            onChange={(e) => updateNodeData(id, { localPrompt: e.target.value })}
            onMouseDown={(e) => { if (selected) e.stopPropagation(); }}
            className="w-full resize-none rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[12px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]" />
        </label>

        <div role="status" aria-live="polite" onMouseDown={(e) => { if (selected) e.stopPropagation(); }}
          className="flex-1 min-h-[60px] overflow-y-auto rounded-md bg-black/20 px-2 py-1.5 text-[12px] leading-[1.55] text-foreground select-text"
          style={{ whiteSpace: "pre-wrap", overscrollBehavior: "contain", fontFamily: outputMode === "json" ? "monospace" : undefined }}>
          {outputText || (status === "error" ? <span className="text-red-400">{(data.errorMsg as string) ?? "Assessment failed"}</span> : <span className="text-muted-foreground">The assessment will appear here.</span>)}
        </div>

        <NodeSection title="Advanced" summary={outputMode === "json" ? "JSON output" : undefined}>
          <label className="block">
            <span className="sr-only">Vision model</span>
            <select aria-label="Vision model" className={selectCls} value={model} disabled={readOnly || busy} onChange={(e) => patch({ visionModel: e.target.value })}>
              {!modelOptions.some((m) => m.id === model) && <option value={model}>{model} (not vision-enabled)</option>}
              {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </NodeSection>

        <div className="flex items-center justify-between gap-2 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--ui-text-faint)]" title={model}>{modelOptions.find((m) => m.id === model)?.label ?? model}</span>
          {!readOnly && (busy ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); handleStop(); }} className="px-2 py-1 rounded-md text-[10px] border border-white/15 text-muted-foreground hover:bg-white/5">Stop</button>
          ) : (
            <GenerateButton onClick={handleRun} disabled={!canRun} warningMessages={warnings} />
          ))}
        </div>
      </div>

      <TypedHandle id="references" kind="images" side="left" top={38} title="Images to assess" connected={references.length > 0} />
      <TypedHandle id="prompt" kind="prompt" side="left" top={60} label="BRIEF" title="Optional brief or question text" connected={!!connectedText} />
      <TypedHandle id="textOut" kind="report" side="right" top={50} label="REPORT" title="Assessment output" connected={edges.some((e) => e.source === id)} />
    </div>
  );
}
