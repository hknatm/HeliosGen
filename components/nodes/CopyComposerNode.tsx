"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, TextContent, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import {
  buildCopyComposerPrompt,
  hasRefinedCopy,
  mergeRefinedCopy,
  parseCopyJson,
  copyDraftMatchesSource,
  rawCopySignature,
  resolveCopyComposerInputs,
  validateRefinedCopy,
} from "@/lib/copyComposer";
import { customModelId, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { buildAgentSystemPrompt, COPY_OUTPUT_CONTRACT } from "@/lib/systemPrompt";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";

type CopyComposerNodeType = Node<NodeData, "copyComposerNode">;

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const NAMESPACE_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  variables: { label: "VARIABLES", color: "#ddd6fe", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.24)" },
  brand:     { label: "BRAND",     color: "#5eead4", bg: "rgba(45,212,191,0.12)", border: "rgba(45,212,191,0.24)" },
};

/** Truncate a value safely for display without ever showing raw JSON blobs. */
function truncateValue(value: string, max = 40): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function copyBlocks(content: TextContent | undefined): number {
  if (!content) return 0;
  return [content.eyebrow, content.title, content.subtitle, content.cta, ...content.bullets]
    .filter((item) => item.trim()).length;
}

export default function CopyComposerNode({ id, data, selected }: NodeProps<CopyComposerNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const cardRef = useRef<HTMLDivElement>(null);
  const modelBarRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const model = (data.copyModel as string | undefined) ?? "claude-sonnet-4-6";

  const [aiBusy, setAiBusy] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
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

  // Deliberately typed inputs: one Text Content (required) + optional
  // Variables / Brand Context. Image Style Profiles are excluded.
  const inputs = useMemo(() => resolveCopyComposerInputs(id, nodes, edges), [edges, id, nodes]);
  const raw = inputs.raw;
  const hasRaw = !!raw && copyBlocks(raw) > 0;

  // Connected Variables / Brand keys — the only optional context sent to the model.
  const connectedKeys = useMemo(() => {
    const out: Array<{ namespace: "variables" | "brand"; key: string; value: string }> = [];
    for (const v of inputs.connectedValues) {
      if (v.key.startsWith("brand.")) out.push({ namespace: "brand", key: v.key.slice("brand.".length), value: v.value });
      else out.push({ namespace: "variables", key: v.key, value: v.value });
    }
    return out;
  }, [inputs.connectedValues]);

  const refined = data.refinedTextContent as TextContent | undefined;
  const accepted = data.copyAccepted === true;
  const errorMsg = data.errorMsg as string | undefined;
  const staleNote = data.staleCopyNote as string | undefined;

  // Signatures of the authored source at draft/accept time. If the connected
  // Text Content changes afterwards, the draft and/or acceptance are stale and
  // must be invalidated — a proposal derived from old copy can never reach the
  // Text Renderer (the renderer gate enforces this too; the UI explains why).
  const rawSig = useMemo(() => rawCopySignature(raw), [raw]);
  const draftSig = data.copyDraftRawSignature as string | undefined;
  const acceptedSig = data.copyAcceptedRawSignature as string | undefined;
  const draftIsCurrent = copyDraftMatchesSource(raw, draftSig);

  useEffect(() => {
    if (!rawSig) return;
    if (accepted && acceptedSig && acceptedSig !== rawSig) {
      updateNodeData(id, {
        copyAccepted: false,
        copyAcceptedRawSignature: undefined,
        staleCopyNote: "Source text changed after approval — re-run to refresh the draft.",
      });
    } else if (refined && draftSig && draftSig !== rawSig) {
      updateNodeData(id, {
        refinedTextContent: undefined,
        copyJson: "",
        copyAccepted: false,
        copyAcceptedRawSignature: undefined,
        staleCopyNote: "Source text changed — re-run to refresh the draft.",
      });
    }
  }, [accepted, acceptedSig, draftSig, id, rawSig, refined, updateNodeData]);

  const changedBlocks = useMemo(() => {
    if (!raw || !refined) return 0;
    let count = 0;
    for (const field of ["eyebrow", "title", "subtitle", "cta"] as const) {
      if ((raw[field] ?? "") !== (refined[field] ?? "")) count++;
    }
    if (JSON.stringify(raw.bullets) !== JSON.stringify(refined.bullets)) count++;
    return count;
  }, [raw, refined]);

  useEffect(() => {
    if (!selected || !cardRef.current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (readOnly || (event.key !== "Delete" && event.key !== "Backspace")) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      onNodesChange([{ type: "remove", id }]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, onNodesChange, readOnly, selected]);

  // Outside-click close for the model dropdown
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelBarRef.current && !modelBarRef.current.contains(e.target as unknown as globalThis.Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen]);

  // Internal scroll must not pan the canvas. Mirror PromptComposerNode: stop
  // wheel propagation only when the wheel target sits inside a scrollable region.
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
    if (busy || readOnly || !hasRaw) return;
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAiBusy(true);
    setShowOriginal(false);
    // Clear any previous result up front so a stale/older output can never leak.
    updateNodeData(id, {
      status: "running",
      errorMsg: undefined,
      copyJson: "",
      refinedTextContent: undefined,
      copyAccepted: false,
      copyDraftRawSignature: undefined,
      copyAcceptedRawSignature: undefined,
      staleCopyNote: undefined,
    });

    try {
      const { data: { session } } = await createClient().auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: buildCopyComposerPrompt(inputs),
          model,
          systemPrompt: buildAgentSystemPrompt(COPY_OUTPUT_CONTRACT),
          ...(model.startsWith("custom:") ? { customProvider: loadCustomProviderConfig() } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "AI copy composing failed" }));
        throw new Error(err.error ?? "AI copy composing failed");
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
              if (requestSeqRef.current === seq) updateNodeData(id, { copyJson: accumulated });
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      if (requestSeqRef.current !== seq) return;

      // Parse the strict structured-copy JSON. A malformed response never leaks
      // downstream — the proposal is simply rejected with a clear error.
      const refinedFields = parseCopyJson(accumulated);
      if (!refinedFields || !raw) {
        updateNodeData(id, {
          status: "error",
          errorMsg: "The model did not return valid structured copy JSON. No copy was produced.",
          copyJson: accumulated,
          refinedTextContent: undefined,
          copyAccepted: false,
        });
        return;
      }

      const validation = validateRefinedCopy(raw, refinedFields);
      if (!validation.ok) {
        updateNodeData(id, {
          status: "error",
          errorMsg: validation.warnings.join(" "),
          copyJson: accumulated,
          refinedTextContent: undefined,
          copyAccepted: false,
        });
        return;
      }
      const merged = mergeRefinedCopy(raw, refinedFields);
      updateNodeData(id, {
        status: "done",
        copyJson: accumulated,
        refinedTextContent: merged,
        copyAccepted: false,
        copyDraftRawSignature: rawCopySignature(raw),
        copySourceId: inputs.textSourceId,
        errorMsg: undefined,
      });
    } catch (e: unknown) {
      // AI failure: never send raw JSON or stale/garbled copy downstream.
      if (requestSeqRef.current === seq) {
        updateNodeData(id, {
          status: "error",
          errorMsg: e instanceof Error ? e.message : String(e),
          copyJson: "",
          refinedTextContent: undefined,
          copyAccepted: false,
        });
      }
    } finally {
      if (requestSeqRef.current === seq) {
        setAiBusy(false);
        abortRef.current = null;
      }
    }
  }, [busy, hasRaw, id, inputs, model, readOnly, raw, updateNodeData]);

  const handleCancel = useCallback(() => {
    // Bump the sequence so the aborted stream cannot write a final output.
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    setAiBusy(false);
    updateNodeData(id, { status: "idle", errorMsg: undefined });
  }, [id, updateNodeData]);

  const handleAccept = useCallback(() => {
    const currentRawSignature = rawCopySignature(raw);
    if (!refined || !hasRefinedCopy(refined) || readOnly || !currentRawSignature) return;
    // A draft is reviewable only against the exact source that produced it.
    // Never let re-approval relabel stale copy as if it came from new source text.
    if (!copyDraftMatchesSource(raw, draftSig)) {
      updateNodeData(id, {
        copyAccepted: false,
        copyAcceptedRawSignature: undefined,
        staleCopyNote: "Source text changed — re-run to refresh the draft before approving it.",
      });
      return;
    }
    updateNodeData(id, { copyAccepted: true, copyAcceptedRawSignature: currentRawSignature, staleCopyNote: undefined });
  }, [draftSig, id, raw, readOnly, refined, updateNodeData]);

  const handleReject = useCallback(() => {
    if (readOnly) return;
    updateNodeData(id, { copyAccepted: false });
  }, [id, readOnly, updateNodeData]);

  const buttonMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const proposedBlocks = copyBlocks(refined);

  return (
    <div ref={cardRef} className={`node-card node-data-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`} style={{ minWidth: 320, overflow: "visible" }}>
      <CornerResizer minWidth={300} minHeight={300} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, fontWeight: 600 }}>Text Refiner</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Improves your text without changing its facts</div>
          </div>

          {/* Model selector */}
          <div ref={modelBarRef} style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <button
                type="button"
                disabled={busy || readOnly}
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setModelOpen(false); } }}
                onMouseDown={buttonMouseDown}
                onClick={(e) => { e.stopPropagation(); if (!busy && !readOnly) setModelOpen((o) => !o); }}
                style={{ display: "flex", alignItems: "center", gap: 3, border: "1px solid rgba(167,139,250,0.24)", background: "rgba(167,139,250,0.12)", color: "#c4b5fd", padding: "3px 7px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: busy || readOnly ? "default" : "pointer" }}
              >
                {modelOptions.find((m) => m.id === model)?.label ?? model}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ transform: modelOpen ? "rotate(180deg)" : undefined }}>
                  <path d="M1 2.5 4 5.5 7 2.5" />
                </svg>
              </button>
              {modelOpen && (
                <div role="listbox" aria-label="Copy Composer model" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setModelOpen(false); } }} style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: "170px", background: "#111622", border: "1px solid #1E2840", borderRadius: "8px", overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)", zIndex: 1001 }}>
                  {modelOptions.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={model === m.id}
                      onMouseDown={buttonMouseDown}
                      onClick={(e) => { e.stopPropagation(); updateNodeData(id, { copyModel: m.id }); setModelOpen(false); }}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "transparent", fontSize: 11, color: model === m.id ? "#fff" : "rgba(255,255,255,0.6)", cursor: "pointer" }}
                    >{m.label}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Raw text preview — preserved verbatim */}
        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)" }}>
          <div style={{ color: "rgba(252,211,77,0.76)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 3 }}>INPUT TEXT · {hasRaw ? `${copyBlocks(raw)} blocks` : "REQUIRED"}</div>
          <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 10, lineHeight: 1.4, whiteSpace: "pre-wrap", maxHeight: 46, overflow: "auto" }}>
            {hasRaw
              ? [raw!.eyebrow, raw!.title, raw!.subtitle, ...raw!.bullets, raw!.cta].filter((v) => v.trim()).join("\n")
              : "Connect a Text Content node to refine its text."}
          </div>
        </div>

        {/* Connected Variables / Brand view */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1, minHeight: 0 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>CONNECTED CONTEXT</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, overflow: "auto", minHeight: 0 }} aria-label="Connected context">
            {connectedKeys.length ? (
              (["variables", "brand"] as const).map((ns) => {
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
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>Optional — connect a Variables or Brand Context node for tone and voice.</span>
            )}
          </div>
        </div>

        {/* Process / status */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 7, background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)" }}>
          <span role="status" aria-live="polite" style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, flex: 1, lineHeight: 1.4 }}>
            {busy ? "Improving text…" : accepted ? "Approved text is ready for the Text Renderer." : "Create a draft, review it, then approve it for rendering."}
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
              id={`copy-composer-process-ai-${id}`}
              type="button"
              disabled={!hasRaw}
              onMouseDown={buttonMouseDown}
              onClick={(e) => { e.stopPropagation(); handleProcessAI(); }}
              style={{ border: "1px solid rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.18)", color: "#c4b5fd", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 600, cursor: hasRaw ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
            >Improve with AI</button>
          ))}
        </div>

        {/* Output panel */}
        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(255,255,255,0.035)", border: `1px solid ${busy ? "rgba(167,139,250,0.4)" : errorMsg ? "rgba(248,113,113,0.4)" : accepted ? "rgba(74,222,128,0.4)" : "rgba(255,255,255,0.08)"}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 4 }}>
            <span style={{ color: busy ? "#c4b5fd" : errorMsg ? "#f87171" : accepted ? "#86efac" : "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>
              {busy ? "IMPROVING…" : errorMsg ? "TEXT REFINEMENT FAILED" : accepted ? "APPROVED TEXT" : "DRAFT TEXT"}
            </span>
            {refined && hasRefinedCopy(refined) && !busy && !errorMsg && (
              <button
                type="button"
                onMouseDown={buttonMouseDown}
                onClick={(e) => { e.stopPropagation(); setShowOriginal((v) => !v); }}
                style={{ border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", color: showOriginal ? "#c4b5fd" : "rgba(255,255,255,0.55)", borderRadius: 5, padding: "2px 7px", fontSize: 9, fontWeight: 600, cursor: "pointer" }}
              >{showOriginal ? "Show draft" : "Compare with original"}</button>
            )}
          </div>
          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", maxHeight: 64, overflow: "auto" }}>
            {refined && hasRefinedCopy(refined)
              ? (showOriginal
                  ? [raw?.eyebrow, raw?.title, raw?.subtitle, ...(raw?.bullets ?? []), raw?.cta].filter((v) => v?.trim()).join("\n")
                  : [refined.eyebrow, refined.title, refined.subtitle, ...refined.bullets, refined.cta].filter((v) => v.trim()).join("\n"))
              : (errorMsg ? "No text was produced. Nothing is exposed downstream." : "Your refined text proposal will appear here.")}
          </div>
          {refined && hasRefinedCopy(refined) && !readOnly && (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {accepted ? (
                <button
                  type="button"
                  onMouseDown={buttonMouseDown}
                  onClick={(e) => { e.stopPropagation(); handleReject(); }}
                  style={{ border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", background: "rgba(248,113,113,0.08)", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                >Reject</button>
              ) : (
                <button
                  id={`copy-composer-accept-${id}`}
                  type="button"
                  disabled={!draftIsCurrent}
                  title={!draftIsCurrent ? "Re-run the Text Refiner after changing source text" : undefined}
                  onMouseDown={buttonMouseDown}
                  onClick={(e) => { e.stopPropagation(); handleAccept(); }}
                  style={{ border: "1px solid rgba(74,222,128,0.4)", color: draftIsCurrent ? "#86efac" : "rgba(255,255,255,0.3)", background: draftIsCurrent ? "rgba(74,222,128,0.14)" : "rgba(255,255,255,0.04)", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 600, cursor: draftIsCurrent ? "pointer" : "not-allowed" }}
                >Approve text</button>
              )}
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 9, alignSelf: "center" }}>{proposedBlocks} blocks · {changedBlocks} changed</span>
            </div>
          )}
          {errorMsg && (
            <div style={{ marginTop: 4, color: "#f87171", fontSize: 10 }}>{errorMsg.slice(0, 140)}</div>
          )}
        </div>
        {staleNote && (
          <div role="status" aria-live="polite" style={{ borderRadius: 6, padding: "6px 8px", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", fontSize: 10, lineHeight: 1.4 }}>{staleNote}</div>
        )}
      </div>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(30% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>TEXT</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(50% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>CONTEXT</span>
      <Handle type="target" position={Position.Left} id="text" title="Required: Text Content" className="node-handle-icon-text-input" style={{ top: "30%", background: "#f59e0b", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="target" position={Position.Left} id="variables" title="Optional: Variables or Brand Context" style={{ top: "50%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} id="textOut" className="node-handle-icon node-handle-icon-out-text" title="Approved text output — connect to Text Renderer" style={{ background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
