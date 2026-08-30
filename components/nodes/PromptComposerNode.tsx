"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { buildComposerPrompt, resolveComposerTemplate } from "@/lib/composerSources";
import { customModelId, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { getSystemPrompt } from "@/lib/systemPrompt";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";

type PromptComposerNodeType = Node<NodeData, "promptComposerNode">;

type ComposerMode = "template" | "ai";

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export default function PromptComposerNode({ id, data, selected }: NodeProps<PromptComposerNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelBarRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const template = (data.template ?? data.prompt ?? "") as string;
  const mode: ComposerMode = data.composerMode === "ai" ? "ai" : "template";
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

  // ── Shared source/token resolution (same helper the canvas Run All uses) ──
  const { connectedValues, resolved, missingKeys, duplicateKeys } = useMemo(
    () => resolveComposerTemplate(id, nodes, edges),
    [edges, id, nodes],
  );

  // Mode-aware deterministic resolution. In template mode we always mirror the
  // deterministic template into resolvedPrompt/prompt (the downstream contract).
  // In AI mode we must NOT auto-resolve over an existing AI result.
  useEffect(() => {
    if (mode === "ai") return;
    if (data.resolvedPrompt !== resolved || data.prompt !== resolved) {
      updateNodeData(id, { resolvedPrompt: resolved, prompt: resolved });
    }
  }, [data.prompt, data.resolvedPrompt, id, mode, resolved, updateNodeData]);

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

  // Keep mode / model in sync with the store as they change
  const setMode = useCallback((next: ComposerMode) => {
    updateNodeData(id, { composerMode: next });
  }, [id, updateNodeData]);

  const insertToken = useCallback((key: string, dropOffset?: number) => {
    if (readOnly) return;
    const textarea = textareaRef.current;
    const start = dropOffset ?? textarea?.selectionStart ?? template.length;
    const end = dropOffset ?? textarea?.selectionEnd ?? start;
    const token = `{{${key}}}`;
    const next = `${template.slice(0, start)}${token}${template.slice(end)}`;
    updateNodeData(id, { template: next });
    requestAnimationFrame(() => {
      textarea?.focus();
      const cursor = start + token.length;
      textarea?.setSelectionRange(cursor, cursor);
    });
  }, [id, readOnly, template, updateNodeData]);

  const handleProcessAI = useCallback(async () => {
    if (busy || readOnly) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAiBusy(true);
    updateNodeData(id, { status: "running", errorMsg: undefined });

    try {
      const { data: { session } } = await createClient().auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: buildComposerPrompt(connectedValues, resolved, template),
          model,
          systemPrompt: getSystemPrompt("promptComposer"),
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
              updateNodeData(id, { resolvedPrompt: accumulated, prompt: accumulated });
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      updateNodeData(id, { status: "done", resolvedPrompt: accumulated, prompt: accumulated });
    } catch (e: unknown) {
      // Deterministic fallback: keep the resolved template so downstream never breaks.
      updateNodeData(id, {
        status: "error",
        errorMsg: e instanceof Error ? e.message : String(e),
        resolvedPrompt: resolved,
        prompt: resolved,
      });
    } finally {
      setAiBusy(false);
      abortRef.current = null;
    }
  }, [busy, connectedValues, id, model, readOnly, resolved, template, updateNodeData]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setAiBusy(false);
    updateNodeData(id, { status: "idle" });
  }, [id, updateNodeData]);

  const chipKeys = [...new Set(connectedValues.map((variable) => variable.key))].sort();
  const displayedPrompt = mode === "ai"
    ? ((data.resolvedPrompt as string | undefined) ?? resolved)
    : resolved;
  const missingMessage = duplicateKeys.length
    ? `DUPLICATE KEYS: ${duplicateKeys.join(", ")}`
    : missingKeys.length ? `MISSING: ${missingKeys.join(", ")}` : null;

  // Stick-to-cursor guards
  const fieldMouseDown = useCallback((e: React.MouseEvent) => {
    if (selected) e.stopPropagation(); else e.preventDefault();
  }, [selected]);
  const buttonMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div ref={cardRef} className={`node-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`} style={{ minWidth: 320, overflow: "visible" }}>
      <CornerResizer minWidth={300} minHeight={250} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, fontWeight: 600 }}>Prompt Composer</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Drag a connected key into your template</div>
          </div>

          {/* Mode + model controls */}
          <div ref={modelBarRef} style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", padding: 2, borderRadius: 6, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <button
                type="button"
                disabled={readOnly}
                onMouseDown={buttonMouseDown}
                onClick={(e) => { e.stopPropagation(); setMode("template"); }}
                style={{ padding: "3px 7px", borderRadius: 4, border: "none", cursor: readOnly ? "default" : "pointer", fontSize: 10, fontWeight: 600, background: mode === "template" ? "rgba(255,255,255,0.14)" : "transparent", color: mode === "template" ? "#fff" : "rgba(255,255,255,0.4)" }}
              >Template</button>
              <button
                type="button"
                disabled={readOnly}
                onMouseDown={buttonMouseDown}
                onClick={(e) => { e.stopPropagation(); setMode("ai"); }}
                style={{ padding: "3px 7px", borderRadius: 4, border: "none", cursor: readOnly ? "default" : "pointer", fontSize: 10, fontWeight: 600, background: mode === "ai" ? "rgba(244,114,182,0.22)" : "transparent", color: mode === "ai" ? "#f9a8d4" : "rgba(255,255,255,0.4)" }}
              >AI</button>
            </div>

            {mode === "ai" && (
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <button
                  type="button"
                  disabled={busy}
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
                  <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: "170px", background: "#111622", border: "1px solid #1E2840", borderRadius: "8px", overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)", zIndex: 1001 }}>
                    {modelOptions.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onMouseDown={buttonMouseDown}
                        onClick={(e) => { e.stopPropagation(); updateNodeData(id, { composerModel: m.id }); setModelOpen(false); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "transparent", fontSize: 11, color: model === m.id ? "#fff" : "rgba(255,255,255,0.6)", cursor: "pointer" }}
                      >{m.label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>AVAILABLE KEYS</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 24 }} aria-label="Connected variable keys">
            {chipKeys.length ? chipKeys.map((key) => (
              <button
                key={key}
                type="button"
                draggable={!readOnly}
                title={`Click or drag ${key} into the template`}
                onMouseDown={buttonMouseDown}
                onClick={() => insertToken(key)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData("text/plain", key);
                }}
                style={{ color: "#ddd6fe", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.24)", padding: "3px 7px", borderRadius: 4, fontSize: 10, fontFamily: "monospace", cursor: readOnly ? "default" : "grab" }}
              >{key}</button>
            )) : <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>Connect a Variables, Brand Context, or Image Style Profile node to add keys.</span>}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>TEMPLATE</span>
          <textarea
            ref={textareaRef}
            value={template}
            disabled={readOnly}
            aria-label="Prompt template"
            placeholder="Studio product photo of …"
            onMouseDown={fieldMouseDown}
            className="nodrag"
            onChange={(event) => updateNodeData(id, { template: event.target.value })}
            onDragOver={(event) => { if (!readOnly) event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              const key = event.dataTransfer.getData("text/plain");
              if (!chipKeys.includes(key)) return;
              const target = event.currentTarget;
              target.focus();
              insertToken(key, target.selectionStart ?? template.length);
            }}
            style={{ width: "100%", minHeight: 74, flex: 1, resize: "none", boxSizing: "border-box", borderRadius: 7, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "8px 9px", fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, outline: "none" }}
          />
        </label>

        {mode === "ai" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 7, background: "rgba(244,114,182,0.06)", border: "1px solid rgba(244,114,182,0.2)" }}>
            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, flex: 1, lineHeight: 1.4 }}>
              {busy ? "AI composing…" : "AI mode uses your resolved context + template."}
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
                disabled={!resolved.trim()}
                onMouseDown={buttonMouseDown}
                onClick={(e) => { e.stopPropagation(); handleProcessAI(); }}
                style={{ border: "1px solid rgba(244,114,182,0.4)", background: "rgba(244,114,182,0.18)", color: "#f9a8d4", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 600, cursor: resolved.trim() ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
              >Process with AI</button>
            ))}
          </div>
        )}

        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(255,255,255,0.035)", border: `1px solid ${busy ? "rgba(244,114,182,0.4)" : missingMessage ? "rgba(251,191,36,0.35)" : "rgba(255,255,255,0.08)"}` }}>
          <div style={{ color: busy ? "#f9a8d4" : missingMessage ? "#fcd34d" : "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 4 }}>{busy ? "COMPOSING…" : missingMessage ?? (mode === "ai" ? "AI PROMPT OUTPUT" : "RESOLVED PROMPT")}</div>
          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", maxHeight: 68, overflow: "auto" }}>{displayedPrompt || "Your resolved prompt will appear here."}</div>
          {data.status === "error" && (data.errorMsg as string) && (
            <div style={{ marginTop: 4, color: "#f87171", fontSize: 10 }}>{(data.errorMsg as string)?.slice(0, 120)} — kept deterministic result.</div>
          )}
        </div>
      </div>
      <Handle type="target" position={Position.Left} id="variables" style={{ top: "50%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} id="textOut" style={{ background: "#f472b6", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
