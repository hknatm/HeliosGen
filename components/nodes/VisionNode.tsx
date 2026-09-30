"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import GenerateButton from "@/components/nodes/GenerateButton";
import CornerResizer from "./CornerResizer";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";
import { customModelId, customModelSupportsVision, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { MULTIMODAL_AGENT_MODEL, resolveReferenceImages } from "@/lib/referenceBundle";
import { resolveInputs } from "@/lib/executor";
import { VISION_PRESETS, runVisionAssessment, visionModelReady, type VisionOutputMode } from "@/lib/vision";

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

  const status = (data.status as string) ?? "idle";
  const outputText = (data.outputText as string) ?? "";
  const model = (data.visionModel as string) ?? MULTIMODAL_AGENT_MODEL;
  const preset = (data.visionPreset as string) ?? "describe";
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
        model, presetId: preset, outputMode, question, connectedText, references, headers,
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
  }, [busy, canRun, id, model, preset, outputMode, question, connectedText, references, updateNodeData]);

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

  const patch = (p: Partial<NodeData>) => updateNodeData(id, { ...p, outputText: "", status: "idle" });

  const selectCls = "w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50";

  return (
    <div ref={cardRef} className={`node-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`} style={{ minWidth: 280 }}>
      <CornerResizer minWidth={260} minHeight={260} />
      <span className="node-above-label">{data.label as string}</span>

      <div className="flex-1 min-h-0 flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
          <label className="flex-1 min-w-0">
            <span className="sr-only">Assessment type</span>
            <select aria-label="Assessment type" className={selectCls} value={preset} disabled={readOnly || busy} onChange={(e) => patch({ visionPreset: e.target.value })}>
              {VISION_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
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

        <div className="flex items-center justify-between gap-2 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Vision model</span>
            <select aria-label="Vision model" className={selectCls} value={model} disabled={readOnly || busy} onChange={(e) => patch({ visionModel: e.target.value })}>
              {!modelOptions.some((m) => m.id === model) && <option value={model}>{model} (not vision-enabled)</option>}
              {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          {!readOnly && (busy ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); handleStop(); }} className="px-2 py-1 rounded-md text-[10px] border border-white/15 text-muted-foreground hover:bg-white/5">Stop</button>
          ) : (
            <GenerateButton onClick={handleRun} disabled={!canRun} warningMessages={warnings} />
          ))}
        </div>
      </div>

      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(38% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700 }}>IMAGES</span>
      <Handle type="target" position={Position.Left} id="references" title="Images to assess" style={{ top: "38%", background: "#fb923c", border: "2px solid #171923", width: 10, height: 10 }} />
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(60% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700 }}>BRIEF</span>
      <Handle type="target" position={Position.Left} id="prompt" title="Optional brief or question text" style={{ top: "60%", background: "#2DD4BF", border: "2px solid #171923", width: 10, height: 10 }} />
      <span aria-hidden="true" style={{ position: "absolute", right: 13, top: "calc(50% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700 }}>REPORT</span>
      <Handle type="source" position={Position.Right} id="textOut" title="Assessment output" style={{ top: "50%", background: "#FBBF24", border: "2px solid #171923", width: 10, height: 10 }} />
      <button type="button" aria-label="Delete node" tabIndex={selected ? 0 : -1} onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onNodesChange([{ type: "remove", id }]); }}
        className="absolute -top-7 right-0 text-[10px] text-muted-foreground hover:text-red-400 transition-opacity" style={{ opacity: selected ? 1 : 0 }}>Delete</button>
    </div>
  );
}
