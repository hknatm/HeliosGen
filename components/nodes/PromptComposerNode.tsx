"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { buildComposerContext, buildComposerPrompt, buildComposerTargetMedia, resolveComposerConnections } from "@/lib/composerSources";
import { customModelId, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { buildAgentSystemPrompt, COMPOSER_OUTPUT_CONTRACT } from "@/lib/systemPrompt";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";

type PromptComposerNodeType = Node<NodeData, "promptComposerNode">;

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const NAMESPACE_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  variables: { label: "VARIABLES", color: "#ddd6fe", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.24)" },
  style:     { label: "STYLE",     color: "#7dd3fc", bg: "rgba(56,189,248,0.12)", border: "rgba(56,189,248,0.24)" },
  brand:     { label: "BRAND",     color: "#5eead4", bg: "rgba(45,212,191,0.12)", border: "rgba(45,212,191,0.24)" },
};

/** Truncate a value safely for display without ever showing raw JSON blobs. */
function truncateValue(value: string, max = 40): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export default function PromptComposerNode({ id, data, selected }: NodeProps<PromptComposerNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const cardRef = useRef<HTMLDivElement>(null);
  const modelBarRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const model = (data.composerModel as string | undefined) ?? "claude-sonnet-4-6";

  const [aiBusy, setAiBusy] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [customModels, setCustomModels] = useState(() => loadCustomProviderModels());
  const busy = aiBusy || data.status === "running";

  useGeneratingBorderAnimation(cardRef, busy);

  useEffect(() => {
    const refresh = () => setCustomModels(loadCustomProviderModels());
    window.addEventListener("aiui-custom-provider-models-changed", refresh);
    return () => window.removeEventListener("aiui-custom-provider-models-changed", refresh);
  }, []);

  const modelOptions = [
    ...MODELS,
    ...customModels.filter((m) => m.enabled !== false).map((item) => ({ id: customModelId(item.id), label: item.name })),
  ];

  // Connected structured context (Variables / Style / Brand) — the only source
  // data the Composer sends to the model.
  const connectedValues = useMemo(
    () => resolveComposerConnections(id, nodes, edges),
    [edges, id, nodes],
  );

  // Show only valid, non-empty, unambiguous key/value pairs — exactly the
  // structured context that will be sent to the model.
  const composerContext = useMemo(() => buildComposerContext(connectedValues), [connectedValues]);
  const connectedKeys = useMemo(() => (
    (["variables", "style", "brand"] as const).flatMap((namespace) =>
      Object.entries(composerContext[namespace]).map(([key, value]) => ({ namespace, key, value })),
    )
  ), [composerContext]);
  const hasComposerContext = connectedKeys.length > 0;
  const targetMedia = useMemo(() => buildComposerTargetMedia(id, nodes, edges), [edges, id, nodes]);

  useEffect(() => {
    if (!selected || !cardRef.current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      onNodesChange([{ type: "remove", id }]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, onNodesChange, selected]);

  // Outside-click close for the model dropdown
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelBarRef.current && !modelBarRef.current.contains(e.target as unknown as globalThis.Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen]);

  // Internal scroll (connected-keys list + final-prompt output) must not pan the
  // canvas. Mirror VariableNode/ProfileDataNode: stop wheel propagation only when
  // the wheel target sits inside a scrollable region that can actually scroll.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let el = event.target as HTMLElement | null;
      while (el && el !== card) {
        const style = getComputedStyle(el);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        ) {
          event.stopPropagation();
          event.stopImmediatePropagation();
          return;
        }
        el = el.parentElement;
      }
    };
    card.addEventListener("wheel", onWheel, { passive: true });
    return () => card.removeEventListener("wheel", onWheel);
  }, []);

  const handleProcessAI = useCallback(async () => {
    if (busy || readOnly || !hasComposerContext) return;
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAiBusy(true);
    // Clear any previous result up front so a stale/older output can never leak.
    updateNodeData(id, { status: "running", errorMsg: undefined, resolvedPrompt: "", prompt: "" });

    try {
      const { data: { session } } = await createClient().auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: buildComposerPrompt(connectedValues, targetMedia),
          model,
          systemPrompt: buildAgentSystemPrompt(COMPOSER_OUTPUT_CONTRACT),
          ...(model.startsWith("custom:") ? { customProvider: loadCustomProviderConfig() } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "AI composing failed" }));
        throw new Error(err.error ?? "AI composing failed");
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
              // Only the newest request may write output.
              if (requestSeqRef.current === seq) updateNodeData(id, { resolvedPrompt: accumulated, prompt: accumulated });
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      if (requestSeqRef.current === seq) {
        updateNodeData(id, { status: "done", resolvedPrompt: accumulated, prompt: accumulated });
      }
    } catch (e: unknown) {
      // AI failure: never send raw JSON or stale/garbled template downstream.
      // Clear the final prompt so downstream generators skip because prompt is empty.
      if (requestSeqRef.current === seq) {
        updateNodeData(id, {
          status: "error",
          errorMsg: e instanceof Error ? e.message : String(e),
          resolvedPrompt: "",
          prompt: "",
        });
      }
    } finally {
      if (requestSeqRef.current === seq) {
        setAiBusy(false);
        abortRef.current = null;
      }
    }
  }, [busy, connectedValues, hasComposerContext, id, model, readOnly, targetMedia, updateNodeData]);

  const handleCancel = useCallback(() => {
    // Bump the sequence so the aborted stream cannot write a final output.
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    setAiBusy(false);
    updateNodeData(id, { status: "idle", errorMsg: undefined });
  }, [id, updateNodeData]);

  const displayedPrompt = (data.resolvedPrompt as string | undefined) ?? "";
  const errorMsg = data.errorMsg as string | undefined;

  const buttonMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div ref={cardRef} className={`node-card node-data-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`} style={{ minWidth: 320, overflow: "visible" }}>
      <CornerResizer minWidth={300} minHeight={250} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, fontWeight: 600 }}>Prompt Composer</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>AI composes a native visual prompt from connected context</div>
            {targetMedia && <div style={{ color: "rgba(249,168,212,0.72)", fontSize: 9, marginTop: 3 }}>{targetMedia.type === "video" ? "Video" : "Image"} target · {targetMedia.aspectRatio}</div>}
          </div>

          {/* Model selector */}
          <div ref={modelBarRef} style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <button
                type="button"
                disabled={busy}
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setModelOpen(false); } }}
                onMouseDown={buttonMouseDown}
                onClick={(e) => { e.stopPropagation(); if (!busy) setModelOpen((o) => !o); }}
                style={{ display: "flex", alignItems: "center", gap: 3, border: "1px solid rgba(244,114,182,0.24)", background: "rgba(244,114,182,0.12)", color: "#f9a8d4", padding: "3px 7px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: busy ? "default" : "pointer" }}
              >
                {modelOptions.find((m) => m.id === model)?.label ?? model}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ transform: modelOpen ? "rotate(180deg)" : undefined }}>
                  <path d="M1 2.5 4 5.5 7 2.5" />
                </svg>
              </button>
              {modelOpen && (
                <div role="listbox" aria-label="Prompt Composer model" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setModelOpen(false); } }} style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: "170px", background: "#111622", border: "1px solid #1E2840", borderRadius: "8px", overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)", zIndex: 1001 }}>
                  {modelOptions.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={model === m.id}
                      onMouseDown={buttonMouseDown}
                      onClick={(e) => { e.stopPropagation(); updateNodeData(id, { composerModel: m.id }); setModelOpen(false); }}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "transparent", fontSize: 11, color: model === m.id ? "#fff" : "rgba(255,255,255,0.6)", cursor: "pointer" }}
                    >{m.label}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Connected Keys view */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1, minHeight: 0 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>CONNECTED KEYS</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, overflow: "auto", minHeight: 0 }} aria-label="Connected keys">
            {connectedKeys.length ? (
              (["variables", "style", "brand"] as const).map((ns) => {
                const group = connectedKeys.filter((k) => k.namespace === ns);
                if (!group.length) return null;
                const meta = NAMESPACE_META[ns];
                return (
                  <div key={ns} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em" }}>{meta.label}</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {group.map((k) => (
                        <span
                          key={`${k.namespace}.${k.key}`}
                          title={`${k.namespace}.${k.key} = ${k.value}`}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, color: meta.color, background: meta.bg, border: `1px solid ${meta.border}`, padding: "2px 6px", borderRadius: 4, fontSize: 10, fontFamily: "monospace", maxWidth: "100%" }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.key}</span>
                          <span style={{ color: "rgba(255,255,255,0.4)", fontWeight: 400 }}>·</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "rgba(255,255,255,0.6)", maxWidth: 90 }}>{truncateValue(k.value)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>Connect a Variables, Brand Context, or Image Style Profile node to add context.</span>
            )}
          </div>
        </div>

        {/* Process / status */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 7, background: "rgba(244,114,182,0.06)", border: "1px solid rgba(244,114,182,0.2)" }}>
          <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, flex: 1, lineHeight: 1.4 }}>
            {busy ? "Composing…" : "Compose a final prompt from connected context."}
          </span>
          {!readOnly && (busy ? (
            <button
              type="button"
              onMouseDown={buttonMouseDown}
              onClick={(e) => { e.stopPropagation(); handleCancel(); }}
              style={{ border: "1px solid #333", color: "#888", background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: "4px 8px", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
            >Stop</button>
          ) : (
            <button
              id={`composer-process-ai-${id}`}
              type="button"
              disabled={!hasComposerContext}
              onMouseDown={buttonMouseDown}
              onClick={(e) => { e.stopPropagation(); handleProcessAI(); }}
              style={{ border: "1px solid rgba(244,114,182,0.4)", background: "rgba(244,114,182,0.18)", color: "#f9a8d4", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 600, cursor: hasComposerContext ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
            >Process with AI</button>
          ))}
        </div>

        {/* Output panel */}
        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(255,255,255,0.035)", border: `1px solid ${busy ? "rgba(244,114,182,0.4)" : errorMsg ? "rgba(248,113,113,0.4)" : "rgba(255,255,255,0.08)"}` }}>
          <div style={{ color: busy ? "#f9a8d4" : errorMsg ? "#f87171" : "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 4 }}>
            {busy ? "COMPOSING…" : errorMsg ? "COMPOSE FAILED" : "FINAL PROMPT"}
          </div>
          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", maxHeight: 68, overflow: "auto" }}>
            {displayedPrompt || (errorMsg ? "No prompt was produced. Downstream nodes will be skipped." : "Your composed prompt will appear here.")}
          </div>
          {errorMsg && (
            <div style={{ marginTop: 4, color: "#f87171", fontSize: 10 }}>{errorMsg.slice(0, 120)}</div>
          )}
        </div>
      </div>
      <Handle type="target" position={Position.Left} id="variables" style={{ top: "50%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} id="textOut" style={{ background: "#f472b6", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
