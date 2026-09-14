"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GenerateButton from "@/components/nodes/GenerateButton";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useAnimatedPopup } from "@/lib/useAnimatedPopup";
import CornerResizer from "./CornerResizer";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";
import { useReadOnly } from "@/lib/readOnlyContext";
import { customModelId, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { buildAgentSystemPrompt, COMPOSER_OUTPUT_CONTRACT, getSystemPrompt } from "@/lib/systemPrompt";
import { resolveComposerConnections, buildComposerContext, buildComposerPrompt } from "@/lib/composerSources";
import { resolveInputs } from "@/lib/executor";

type AssistantNodeType = Node<NodeData, "assistantNode">;

const NAMESPACE_META: Record<string, { color: string; bg: string; border: string }> = {
  variables: { color: "#ddd6fe", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.24)" },
  style:     { color: "#7dd3fc", bg: "rgba(56,189,248,0.12)", border: "rgba(56,189,248,0.24)" },
  brand:     { color: "#5eead4", bg: "rgba(45,212,191,0.12)", border: "rgba(45,212,191,0.24)" },
};

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export default function AssistantNode({ id, data, selected }: NodeProps<AssistantNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const addNode = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);
  const edges = useWorkflowStore((s) => s.edges);
  const nodes = useWorkflowStore((s) => s.nodes);
  const kieKeySet = useWorkflowStore((s) => s.kieKeySet);

  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const prevSelectedRef = useRef(selected);
  const abortRef = useRef<AbortController | null>(null);

  // Instant handle hide on deselect
  useEffect(() => {
    const was = prevSelectedRef.current;
    prevSelectedRef.current = selected;
    if (was && !selected && cardRef.current) {
      const el = cardRef.current;
      el.classList.add("handles-no-delay");
      const t = setTimeout(() => el.classList.remove("handles-no-delay"), 200);
      return () => { clearTimeout(t); el.classList.remove("handles-no-delay"); };
    }
  }, [selected]);

  const status = (data.status as string) ?? "idle";
  const outputText = (data.outputText as string) ?? "";
  const localPrompt = (data.localPrompt as string) ?? "";
  const connectedPrompt = useMemo(() => resolveInputs(id, nodes, edges).prompt ?? "", [edges, id, nodes]);
  const model = (data.model as string) ?? "claude-sonnet-4-6";

  // Connected structured context (Variables / Style / Brand) — the AI Agent
  // accepts BOTH an ordinary editable text prompt AND structured context.
  const connectedValues = useMemo(() => resolveComposerConnections(id, nodes, edges), [edges, id, nodes]);
  const hasContext = connectedValues.length > 0;
  const structuredContext = useMemo(() => buildComposerContext(connectedValues), [connectedValues]);
  const connectedKeys = useMemo(() => (
    (["variables", "style", "brand"] as const).flatMap((namespace) =>
      Object.entries(structuredContext[namespace])
        .filter(([, value]) => value.trim().length > 0)
        .map(([key, value]) => ({ namespace, key, value })),
    )
  ), [structuredContext]);
  const [customModels, setCustomModels] = useState(() => loadCustomProviderModels());
  const modelOptions = [
    ...MODELS,
    ...customModels.filter((m) => m.enabled !== false).map((item) => ({ id: customModelId(item.id), label: item.name })),
  ];

  useEffect(() => {
    const refresh = () => setCustomModels(loadCustomProviderModels());
    window.addEventListener("aiui-custom-provider-models-changed", refresh);
    return () => window.removeEventListener("aiui-custom-provider-models-changed", refresh);
  }, []);

  const [viewMode, setViewMode] = useState<"input" | "output">("input");
  const [loading, setLoading] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const modelPopup = useAnimatedPopup(modelOpen);
  const modelBarRef = useRef<HTMLDivElement>(null);

  // ── Elevate the RF node z-index while the menu is open ───────────────────
  useEffect(() => {
    const rfNode = cardRef.current?.closest<HTMLElement>(".react-flow__node");
    if (!rfNode) return;
    if (modelOpen) {
      rfNode.style.zIndex = "10000";
    } else {
      rfNode.style.zIndex = "";
    }
    return () => { rfNode.style.zIndex = ""; };
  }, [modelOpen]);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelBarRef.current && !modelBarRef.current.contains(e.target as unknown as globalThis.Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen]);

  const busy = loading || status === "running";
  const customProviderReady = !model.startsWith("custom:") || !!loadCustomProviderConfig().baseUrl.trim();
  const canGenerate = customProviderReady && (model.startsWith("custom:") || kieKeySet !== false);

  useGeneratingBorderAnimation(cardRef, busy);

  const hasOutput = !!outputText;
  // The AI Agent can run from structured context (Variables/Style/Brand) alone;
  // an ordinary text prompt is optional.
  const hasPrompt = !!localPrompt.trim() || !!connectedPrompt.trim() || hasContext;
  const sourceConnected = edges.some((e) => e.source === id);

  // Keep textarea in sync with store
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && ta.value !== localPrompt) ta.value = localPrompt;
  }, [localPrompt]);


  const handleDelete = useCallback(() => {
    onNodesChange([{ type: "remove", id }]);
  }, [id, onNodesChange]);

  const handleDuplicate = useCallback(() => {
    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === id);
    if (!src) return;
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    onNodesChange([{ type: "select", id, selected: false }]);
    addNode({
      ...src,
      id: newId,
      position: { x: src.position.x + 20, y: src.position.y + 20 },
      selected: true,
      data: { ...src.data, status: "idle" as const, outputText: undefined },
    });
    state.edges
      .filter((e) => (e.source === id || e.target === id) && e.deletable !== false)
      .forEach((e) => insertEdge({
        ...e,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        source: e.source === id ? newId : e.source,
        target: e.target === id ? newId : e.target,
      }));
  }, [id, addNode, insertEdge, onNodesChange]);

  const handleGenerate = useCallback(async () => {
    if (busy || !hasPrompt || !canGenerate) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setViewMode("output");
    updateNodeData(id, { status: "running", outputText: "", errorMsg: undefined });

    try {
      const { data: { session } } = await createClient().auth.getSession();
      const assistantHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) assistantHeaders["Authorization"] = `Bearer ${session.access_token}`;
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: assistantHeaders,
        body: JSON.stringify({
          prompt: buildAgentPrompt(localPrompt, connectedPrompt, connectedValues),
          model,
          systemPrompt: hasContext ? buildAgentSystemPrompt(COMPOSER_OUTPUT_CONTRACT) : getSystemPrompt("agent"),
          ...(model.startsWith("custom:") ? { customProvider: loadCustomProviderConfig() } : {}),
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Generation failed" }));
        throw new Error(err.error ?? "Generation failed");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break outer;
          try {
            const parsed = JSON.parse(payload);
            const delta =
              (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta"
                ? parsed.delta.text
                : null) ??
              parsed.choices?.[0]?.delta?.content ??
              "";
            if (delta) {
              accumulated += delta;
              updateNodeData(id, { outputText: accumulated });
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      updateNodeData(id, { status: "done", outputText: accumulated });
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") {
        updateNodeData(id, { status: "idle" });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        updateNodeData(id, { status: "error", errorMsg: msg });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [busy, canGenerate, hasPrompt, localPrompt, connectedPrompt, id, updateNodeData, model, hasContext, connectedValues]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    updateNodeData(id, { status: "idle" });
  }, [id, updateNodeData]);

  return (
    <div
      ref={cardRef}
      className={`node-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`}
      style={{ minWidth: 260 }}
    >
      <CornerResizer minWidth={200} minHeight={120} />

      <span className="node-above-label">{data.label as string}</span>

      {/* ── Action bar ─────────────────────────────────────────────────── */}
      <div
        className="absolute z-50 flex items-center gap-0.5 px-1.5 py-1"
        style={{
          bottom: "calc(100% + 28px)", left: "50%",
          borderRadius: 999,
          background: "rgba(16,16,16,0.96)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.07)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.65), 0 1px 4px rgba(0,0,0,0.4)",
          transform: `translateX(-50%) translateY(${selected ? "0px" : "6px"})`,
          opacity: selected ? 1 : 0,
          transition: "opacity 180ms ease, transform 180ms ease",
          pointerEvents: selected ? "auto" : "none",
          whiteSpace: "nowrap",
        }}
      >
        <button tabIndex={selected ? 0 : -1} aria-label="Duplicate node" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleDuplicate(); }} title="Duplicate node"
          className="w-7 h-7 flex items-center justify-center rounded-full text-[#777] hover:text-white hover:bg-white/10 transition-colors duration-150">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <span className="w-px h-4 bg-white/[0.08] mx-0.5 shrink-0" />
        <button tabIndex={selected ? 0 : -1} aria-label="Delete node" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleDelete(); }} title="Delete node"
          className="w-7 h-7 flex items-center justify-center rounded-full text-[#777] hover:text-red-400 hover:bg-red-400/10 transition-colors duration-150">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" />
          </svg>
        </button>
      </div>

      {/* ── Toggle switch — absolute on card, truly top-left ───────────── */}
      <div
        className="absolute top-1.5 left-1.5 z-30 flex items-center p-1 rounded-full gap-0.5"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Sliding indicator */}
        <div style={{
          position: "absolute",
          top: 4, left: 4,
          width: 28, height: 28,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.18)",
          border: "1.5px solid rgba(255,255,255,0.45)",
          transform: `translateX(${viewMode === "output" ? 30 : 0}px)`,
          transition: "transform 220ms cubic-bezier(0.34,1.56,0.64,1)",
          pointerEvents: "none",
          zIndex: 20,
        }} />

        {/* Input — text lines icon */}
        <button
          aria-label="Show input"
          aria-pressed={viewMode === "input"}
          onClick={(e) => { e.stopPropagation(); setViewMode("input"); }}
          className="w-7 h-7 rounded-full flex items-center justify-center relative z-10"
          title="Show input"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            style={{ color: viewMode === "input" ? "white" : "rgba(255,255,255,0.35)", transition: "color 220ms" }}>
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="15" y2="18" />
          </svg>
        </button>

        {/* Output — text lines + sparkle icon; disabled until output exists */}
        <button
          aria-label="Show output"
          aria-pressed={viewMode === "output"}
          onClick={(e) => { e.stopPropagation(); if (hasOutput) setViewMode("output"); }}
          disabled={!hasOutput}
          className="w-7 h-7 rounded-full flex items-center justify-center relative z-10 disabled:cursor-not-allowed"
          title={hasOutput ? "Show output" : "Generate first to see output"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeLinecap="round"
            style={{
              color: !hasOutput ? "rgba(255,255,255,0.18)" : viewMode === "output" ? "white" : "rgba(255,255,255,0.35)",
              transition: "color 220ms",
            }}>
            <line x1="3" y1="8" x2="16" y2="8" stroke="currentColor" strokeWidth="2" />
            <line x1="3" y1="13" x2="13" y2="13" stroke="currentColor" strokeWidth="2" />
            {/* Sparkle */}
            <path d="M19 2 L19.7 4.3 L22 5 L19.7 5.7 L19 8 L18.3 5.7 L16 5 L18.3 4.3 Z"
              fill="currentColor" stroke="none" />
            <path d="M21 13 L21.4 14.4 L23 15 L21.4 15.6 L21 17 L20.6 15.6 L19 15 L20.6 14.4 Z"
              fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="flex-1 p-2.5 min-h-0">
        <div className="relative h-full rounded-[7px] overflow-hidden">

          {/* Output display — nowheel tells React Flow to skip its scroll-to-pan handler */}
          <div
            ref={outputRef}
            className="nowheel absolute inset-0 px-3 pt-10 pb-10 text-[13px] text-white leading-[1.6] overflow-y-auto select-text"
            style={{ whiteSpace: "pre-wrap", overscrollBehavior: "contain", display: viewMode === "output" ? undefined : "none" }}
            onMouseDown={(e) => { if (selected) e.stopPropagation(); }}
          >
            {outputText}
            {busy && (
              <span className="inline-flex items-center gap-0.5 ml-1 align-middle">
                {[0, 120, 240].map((d) => (
                  <span key={d} className="w-[3px] h-[3px] rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
            )}
          </div>

          {/* Editable textarea — input mode */}
          {viewMode === "input" && (
            <>
              {hasContext && connectedKeys.length > 0 && (
                <div
                  onMouseDown={(e) => { if (selected) e.stopPropagation(); }}
                  style={{ position: "absolute", top: 2, left: 2, right: 2, zIndex: 20, display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 4px 0", maxHeight: 72, overflowY: "auto" }}
                >
                  {connectedKeys.map((k) => (
                    <span
                      key={`${k.namespace}.${k.key}`}
                      title={`${k.namespace}.${k.key} = ${k.value}`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, color: NAMESPACE_META[k.namespace].color, background: NAMESPACE_META[k.namespace].bg, border: `1px solid ${NAMESPACE_META[k.namespace].border}`, padding: "1px 5px", borderRadius: 4, fontSize: 9, fontFamily: "monospace", maxWidth: "100%" }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.key}</span>
                    </span>
                  ))}
                </div>
              )}
              {!localPrompt && !hasContext && (
                <div
                  aria-hidden
                  className="absolute inset-0 px-3 pt-10 pb-10 text-[13px] text-[#3A4055] leading-[1.6] pointer-events-none select-none"
                >
                  Describe what you want to generate…
                </div>
              )}
              {!localPrompt && hasContext && (
                <div
                  aria-hidden
                  className="absolute inset-0 px-3 pt-[78px] pb-10 text-[13px] text-[#3A4055] leading-[1.6] pointer-events-none select-none"
                >
                  Optionally describe what you want… otherwise the agent composes from connected context.
                </div>
              )}
              <textarea
                ref={textareaRef}
                aria-label="AI Agent prompt"
                className="relative w-full h-full px-3 pb-10 bg-transparent text-[13px] text-white leading-[1.6] resize-none overflow-y-auto z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-amber-300"
                style={{ caretColor: "white", overscrollBehavior: "contain", paddingTop: hasContext ? 78 : 40 }}
                defaultValue={localPrompt}
                readOnly={readOnly}
                onChange={(e) => updateNodeData(id, { localPrompt: e.target.value })}
                onMouseDown={(e) => { if (selected) e.stopPropagation(); else e.preventDefault(); }}
              />
            </>
          )}

          {/* Error */}
          {status === "error" && (
            <div role="status" aria-live="polite" className="absolute inset-x-0 bottom-12 flex justify-center pointer-events-none">
              <span className="text-[10px] text-red-400 px-2 py-0.5 rounded bg-red-900/30">
                {(data.errorMsg as string) ?? "Generation failed"}
              </span>
            </div>
          )}

          {/* ── Bottom controls ────────────────────────────────────────── */}
          <div
            ref={modelBarRef}
            className="absolute bottom-0 inset-x-0 px-2.5 pb-1.5 pt-1 flex items-center justify-between z-[1001]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Model dropdown */}
            <div className="relative">
              <button
                aria-haspopup="menu"
                aria-expanded={modelOpen}
                aria-label="Select AI Agent model"
                onKeyDown={(e) => { if (e.key === "Escape") setModelOpen(false); }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); if (!busy) setModelOpen((o) => !o); }}
                className="flex items-center gap-1"
              >
                <span className="text-[11px] text-[#A0A0A0] hover:text-white transition-colors">
                  {modelOptions.find((m) => m.id === model)?.label ?? model}
                </span>
                <ChevronIcon open={modelOpen} />
              </button>

              {modelPopup.visible && (
                <div role="menu" aria-label="AI Agent models" onKeyDown={(e) => { if (e.key === "Escape") setModelOpen(false); }} className={`absolute bottom-full left-0 mb-2 w-44 bg-[#111622] border border-[#1E2840] rounded-md overflow-hidden z-[1002] shadow-2xl ${modelPopup.className}`}>
                  {modelOptions.map((m) => (
                    <button
                      key={m.id}
                      role="menuitemradio"
                      aria-checked={model === m.id}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); updateNodeData(id, { model: m.id }); setModelOpen(false); }}
                      className={`w-full text-left px-3 py-[7px] text-[11px] hover:bg-[#141C28] transition-colors ${model === m.id ? "text-white" : "text-[#A0A0A0]"}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Generate / Stop */}
            {!readOnly && (busy ? (
              <button
                onClick={(e) => { e.stopPropagation(); handleCancel(); }}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium hover:bg-white/5 transition-colors"
                style={{ border: "1px solid #333", color: "#888", background: "rgba(255,255,255,0.04)" }}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><rect width="8" height="8" rx="1.5" /></svg>
                Stop
              </button>
            ) : (
              <GenerateButton
                onClick={handleGenerate}
                disabled={!hasPrompt || !canGenerate}
                warningMessages={[
                  ...(!hasPrompt ? ["Enter or connect a prompt or structured context"] : []),
                  ...(!canGenerate ? [model.startsWith("custom:") ? "Configure the custom provider" : "Add a Kie.ai API key in Settings"] : []),
                ]}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Assistant output handle ───────────────────────────────────── */}
      <Handle
        type="source"
        position={Position.Right}
        id="textOut"
        style={{ top: "50%" }}
        className={`node-handle-icon node-handle-icon-out-text node-handle-icon-out-assistant${sourceConnected ? " node-handle-connected" : ""}`}
        title="Assistant output"
      >
        <BrainIcon />
      </Handle>

      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(62% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>PROMPT</span>
      <Handle
        type="target"
        position={Position.Left}
        id="prompt"
        title="Optional: Text, Variable, or another AI Agent output"
        style={{ top: "62%", background: "#2DD4BF", border: "2px solid #171923", width: 10, height: 10 }}
      />

      {/* ── Structured context input handle (Variables / Style / Brand) ── */}
      {hasContext && (
        <span
          aria-hidden="true"
          style={{ position: "absolute", left: 13, top: "calc(26% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}
        >
          CONTEXT
        </span>
      )}
      <Handle
        type="target"
        position={Position.Left}
        id="variables"
        title="Optional: Variables, Brand Context, or Image Style Profile"
        style={{ top: "26%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }}
      />
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
      stroke="#5A5A55" strokeWidth="1.5" strokeLinecap="round"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}
    >
      <path d="M1 2.5 4 5.5 7 2.5" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  );
}

export function buildAgentPrompt(
  local: string,
  connected: string,
  connectedValues: ReturnType<typeof resolveComposerConnections>,
): string {
  const authored = [connected.trim(), local.trim()].filter(Boolean).join("\n\n");
  return connectedValues.length ? buildComposerPrompt(connectedValues, undefined, authored) : authored;
}
