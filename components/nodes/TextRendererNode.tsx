"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import MissingInputWarning from "./MissingInputWarning";
import { NodeData, TextContent, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { hasRenderableText, rendererInputSignature, resolveTextRendererContent, resolveTextRendererInputs } from "@/lib/textRendererSources";
import {
  buildCopyComposerPrompt,
  copyDraftMatchesSource,
  hasRefinedCopy,
  mergeRefinedCopy,
  parseCopyJson,
  rawCopySignature,
  resolveCopyComposerInputs,
  validateRefinedCopy,
  type CopyComposerInputs,
} from "@/lib/copyComposer";
import { loadTextFonts, resolveTextFont } from "@/lib/textFonts";
import { loadTextRenderingSettings } from "@/lib/textRenderingSettings";
import { customModelId, loadCustomProviderConfig, loadCustomProviderModels } from "@/lib/customProvider";
import { buildAgentSystemPrompt, COPY_OUTPUT_CONTRACT } from "@/lib/systemPrompt";
import { createClient } from "@/lib/supabase/client";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";

type TextRendererNodeType = Node<NodeData, "textRendererNode">;

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const EMPTY_TEXT: TextContent = {
  eyebrow: "", title: "", subtitle: "", bullets: [""], cta: "",
  fontFamily: "Arial", textColor: "#FFFFFF", accentColor: "#F59E0B", alignment: "left",
};

const ALIGNMENTS: Array<{ value: TextContent["alignment"]; label: string }> = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

const FIELD_LABELS: Array<{ key: Exclude<keyof TextContent, "bullets" | "fontFamily" | "textColor" | "accentColor" | "alignment">; label: string }> = [
  { key: "eyebrow", label: "Eyebrow" },
  { key: "title", label: "Title" },
  { key: "subtitle", label: "Subtitle" },
  { key: "cta", label: "Call to action" },
];

function normalizeTextContent(value: TextContent | undefined): TextContent {
  if (!value || typeof value !== "object") return { ...EMPTY_TEXT };
  const input = value as Partial<TextContent>;
  return {
    eyebrow: typeof input.eyebrow === "string" ? input.eyebrow : "",
    title: typeof input.title === "string" ? input.title : "",
    subtitle: typeof input.subtitle === "string" ? input.subtitle : "",
    bullets: Array.isArray(input.bullets) ? input.bullets.map((b) => typeof b === "string" ? b : "") : [""],
    cta: typeof input.cta === "string" ? input.cta : "",
    fontFamily: typeof input.fontFamily === "string" ? input.fontFamily : "Arial",
    textColor: typeof input.textColor === "string" ? input.textColor : "#FFFFFF",
    accentColor: typeof input.accentColor === "string" ? input.accentColor : "#F59E0B",
    alignment: input.alignment === "center" || input.alignment === "right" ? input.alignment : "left",
  };
}

export default function TextRendererNode({ id, data, selected }: NodeProps<TextRendererNodeType>) {
  const readOnly = useReadOnly();
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelBarRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const [fonts, setFonts] = useState(() => loadTextFonts());
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [customModels, setCustomModels] = useState(() => loadCustomProviderModels());

  // Editable structured copy owned by this Text Overlay node.
  const ownCopy = useMemo(() => normalizeTextContent(data.textContent as TextContent | undefined), [data.textContent]);
  const hasOwnText = hasRenderableText(ownCopy);

  // Legacy connections (image / style / old text inputs) still resolve here so
  // saved workflows keep working; new Text Overlay nodes author copy inline.
  const legacyInputs = useMemo(() => resolveTextRendererInputs(id, nodes, edges), [edges, id, nodes]);
  const inputs = legacyInputs;

  // Optional Variables / Brand context for AI copy refinement (legacy Text
  // Content connections are excluded — the overlay owns its copy).
  const refineCtx = useMemo(() => {
    const resolved = resolveCopyComposerInputs(id, nodes, edges);
    return { connectedValues: resolved.connectedValues };
  }, [edges, id, nodes]);

  const refined = data.refinedTextContent as TextContent | undefined;
  const accepted = data.copyAccepted === true;
  const draftSig = data.copyDraftRawSignature as string | undefined;
  const acceptedSig = data.copyAcceptedRawSignature as string | undefined;
  const errorMsg = data.errorMsg as string | undefined;
  const staleNote = data.staleCopyNote as string | undefined;

  // Effective copy that renders: approved AI refinement, else inline authored
  // copy, else (legacy) a connected Text Content node.
  const refinementCopy = hasOwnText ? ownCopy : inputs.content;
  const refinementSig = rawCopySignature(refinementCopy);
  const effectiveContent = useMemo<TextContent | undefined>(() => resolveTextRendererContent(
    { ...inputs, content: refinementCopy },
    data,
  ), [data, inputs, refinementCopy]);

  const font = effectiveContent ? resolveTextFont(fonts, effectiveContent.fontFamily) : undefined;

  // Invalidate a stale draft / acceptance when the authored source changes.
  useEffect(() => {
    if (!refinementSig) {
      if (refined || accepted) {
        updateNodeData(id, {
          refinedTextContent: undefined,
          copyJson: "",
          copyAccepted: false,
          copyAcceptedRawSignature: undefined,
          staleCopyNote: undefined,
        });
      }
      return;
    }
    if (refined && draftSig && draftSig !== refinementSig) {
      updateNodeData(id, {
        refinedTextContent: undefined,
        copyJson: "",
        copyAccepted: false,
        copyAcceptedRawSignature: undefined,
        staleCopyNote: "Source text changed — re-run to refresh the draft.",
      });
    } else if (accepted && acceptedSig && acceptedSig !== refinementSig) {
      updateNodeData(id, {
        copyAccepted: false,
        copyAcceptedRawSignature: undefined,
        staleCopyNote: "Source text changed after approval — re-run to refresh the draft.",
      });
    }
  }, [accepted, acceptedSig, draftSig, id, refined, refinementSig, updateNodeData]);

  const ready = !!inputs.imageUrl && hasRenderableText(effectiveContent) && !!inputs.composition;
  const isRendering = rendering;
  const busy = aiBusy;

  useGeneratingBorderAnimation(cardRef, busy || isRendering);

  // Signature of everything the renderer composites — used to flag stale results.
  const inputSignature = useMemo(() => {
    void settingsVersion;
    return rendererInputSignature(
      { imageUrl: inputs.imageUrl, content: effectiveContent, composition: inputs.composition },
      loadTextRenderingSettings(),
      font?.url,
      font?.familyKey,
    );
  }, [inputs.imageUrl, inputs.composition, effectiveContent, font, settingsVersion]);
  const stale = !!data.imageUrl && typeof data.renderedInputSignature === "string" && data.renderedInputSignature !== inputSignature;
  const truncated = typeof data.truncatedLines === "number" ? data.truncatedLines : 0;

  useEffect(() => {
    const refreshFonts = () => setFonts(loadTextFonts());
    const refreshSettings = () => setSettingsVersion((version) => version + 1);
    window.addEventListener("aiui-text-fonts-changed", refreshFonts);
    window.addEventListener("aiui-text-rendering-settings-changed", refreshSettings);
    return () => {
      window.removeEventListener("aiui-text-fonts-changed", refreshFonts);
      window.removeEventListener("aiui-text-rendering-settings-changed", refreshSettings);
    };
  }, []);

  const model = (data.copyModel as string | undefined) ?? "claude-sonnet-4-6";
  useEffect(() => {
    const refresh = () => setCustomModels(loadCustomProviderModels());
    window.addEventListener("aiui-custom-provider-models-changed", refresh);
    return () => window.removeEventListener("aiui-custom-provider-models-changed", refresh);
  }, []);
  const modelOptions = [
    ...MODELS,
    ...customModels.filter((m) => m.enabled !== false).map((item) => ({ id: customModelId(item.id), label: item.name })),
  ];

  // Internal scroll must not pan the canvas.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || el.scrollHeight <= el.clientHeight) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelBarRef.current && !modelBarRef.current.contains(e.target as unknown as globalThis.Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelOpen]);

  useEffect(() => {
    if (!selected || !cardRef.current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (readOnly || (event.key !== "Delete" && event.key !== "Backspace")) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      onNodesChange([{ type: "remove", id }]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, onNodesChange, readOnly, selected]);

  const render = useCallback(async () => {
    if (readOnly || rendering || aiBusy) return;
    if (!ready || !inputs.imageUrl || !effectiveContent || !inputs.composition) {
      updateNodeData(id, { status: "error", errorMsg: "Connect an image, non-empty copy, and an Image Style Profile text area." });
      return;
    }
    setRendering(true);
    const settings = loadTextRenderingSettings();
    const signature = rendererInputSignature(
      { imageUrl: inputs.imageUrl, content: effectiveContent, composition: inputs.composition },
      settings, font?.url, font?.familyKey,
    );
    updateNodeData(id, { status: "running", errorMsg: undefined, truncatedLines: 0, renderedInputSignature: undefined });
    try {
      const { data: { session } } = await createClient().auth.getSession();
      const response = await fetch("/api/render-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({
          imageUrl: inputs.imageUrl,
          content: effectiveContent,
          composition: inputs.composition,
          settings,
          ...(font?.familyKey ? { fontUrl: font.url, fontFamilyKey: font.familyKey } : {}),
        }),
      });
      const result = await response.json().catch(() => ({})) as { imageUrl?: string; error?: string; truncatedLines?: number };
      if (!response.ok || !result.imageUrl) throw new Error(result.error ?? "Text render failed");
      updateNodeData(id, {
        status: "done",
        imageUrl: result.imageUrl,
        errorMsg: undefined,
        truncatedLines: typeof result.truncatedLines === "number" ? result.truncatedLines : 0,
        renderedInputSignature: signature,
      });
    } catch (error: unknown) {
      updateNodeData(id, { status: "error", errorMsg: error instanceof Error ? error.message : "Text render failed" });
    } finally {
      setRendering(false);
    }
  }, [aiBusy, font, id, inputs, effectiveContent, readOnly, ready, rendering, updateNodeData]);

  useEffect(() => {
    if (!data.pendingRender) return;
    updateNodeData(id, { pendingRender: false });
    const timer = window.setTimeout(() => { void render(); }, 0);
    return () => window.clearTimeout(timer);
  }, [data.pendingRender, id, render, updateNodeData]);

  // ── AI copy refinement ──────────────────────────────────────────────────────
  const handleImproveAI = useCallback(async () => {
    if (busy || readOnly || !refinementCopy || !hasRenderableText(refinementCopy)) return;
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAiBusy(true);
    setShowOriginal(false);
    updateNodeData(id, {
      status: "running", errorMsg: undefined,
      copyJson: "", refinedTextContent: undefined, copyAccepted: false,
      copyDraftRawSignature: undefined, copyAcceptedRawSignature: undefined, staleCopyNote: undefined,
    });
    try {
      const promptInputs: CopyComposerInputs = { raw: refinementCopy, textSourceId: hasOwnText ? id : inputs.textSourceId, connectedValues: refineCtx.connectedValues };
      const { data: { session } } = await createClient().auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: buildCopyComposerPrompt(promptInputs),
          model,
          systemPrompt: buildAgentSystemPrompt(COPY_OUTPUT_CONTRACT),
          ...(model.startsWith("custom:") ? { customProvider: loadCustomProviderConfig() } : {}),
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "AI copy refinement failed" }));
        throw new Error(err.error ?? "AI copy refinement failed");
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
                ? parsed.delta.text : null) ??
              parsed.choices?.[0]?.delta?.content ?? "";
            if (delta) { accumulated += delta; if (requestSeqRef.current === seq) updateNodeData(id, { copyJson: accumulated }); }
          } catch { /* skip malformed SSE lines */ }
        }
      }
      if (requestSeqRef.current !== seq) return;
      const refinedFields = parseCopyJson(accumulated);
      if (!refinedFields) {
        updateNodeData(id, { status: "error", errorMsg: "The model did not return valid structured copy JSON. No copy was produced.", copyJson: accumulated, refinedTextContent: undefined, copyAccepted: false });
        return;
      }
      const validation = validateRefinedCopy(refinementCopy, refinedFields);
      if (!validation.ok) {
        updateNodeData(id, { status: "error", errorMsg: validation.warnings.join(" "), copyJson: accumulated, refinedTextContent: undefined, copyAccepted: false });
        return;
      }
      updateNodeData(id, {
        status: "done", copyJson: accumulated,
        refinedTextContent: mergeRefinedCopy(refinementCopy, refinedFields),
        copyAccepted: false, copyDraftRawSignature: refinementSig, errorMsg: undefined,
      });
    } catch (e: unknown) {
      if (requestSeqRef.current === seq) {
        updateNodeData(id, { status: "error", errorMsg: e instanceof Error ? e.message : String(e), copyJson: "", refinedTextContent: undefined, copyAccepted: false });
      }
    } finally {
      if (requestSeqRef.current === seq) { setAiBusy(false); abortRef.current = null; }
    }
  }, [busy, hasOwnText, id, inputs.textSourceId, model, readOnly, refineCtx.connectedValues, refinementCopy, refinementSig, updateNodeData]);

  const handleCancel = useCallback(() => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    setAiBusy(false);
    updateNodeData(id, { status: "idle", errorMsg: undefined });
  }, [id, updateNodeData]);

  const handleAccept = useCallback(() => {
    if (!refined || !hasRefinedCopy(refined) || readOnly || !refinementCopy || !refinementSig) return;
    if (!copyDraftMatchesSource(refinementCopy, draftSig)) {
      updateNodeData(id, { copyAccepted: false, copyAcceptedRawSignature: undefined, staleCopyNote: "Source text changed — re-run to refresh the draft before approving it." });
      return;
    }
    updateNodeData(id, { copyAccepted: true, copyAcceptedRawSignature: refinementSig, staleCopyNote: undefined });
  }, [draftSig, id, readOnly, refined, refinementCopy, refinementSig, updateNodeData]);

  const handleReject = useCallback(() => {
    if (readOnly) return;
    updateNodeData(id, { copyAccepted: false });
  }, [id, readOnly, updateNodeData]);

  const setTextField = useCallback((field: keyof TextContent, value: string) => {
    if (readOnly) return;
    const next = normalizeTextContent({ ...ownCopy, [field]: value });
    updateNodeData(id, { textContent: next });
  }, [id, ownCopy, readOnly, updateNodeData]);

  const setBullet = useCallback((index: number, value: string) => {
    if (readOnly) return;
    const nextBullets = ownCopy.bullets.map((b, i) => i === index ? value : b);
    updateNodeData(id, { textContent: normalizeTextContent({ ...ownCopy, bullets: nextBullets }) });
  }, [id, ownCopy, readOnly, updateNodeData]);

  const addBullet = useCallback(() => {
    if (readOnly || ownCopy.bullets.length >= 5) return;
    updateNodeData(id, { textContent: normalizeTextContent({ ...ownCopy, bullets: [...ownCopy.bullets, ""] }) });
  }, [id, ownCopy, readOnly, updateNodeData]);

  const removeBullet = useCallback((index: number) => {
    if (readOnly) return;
    updateNodeData(id, { textContent: normalizeTextContent({ ...ownCopy, bullets: ownCopy.bullets.filter((_, i) => i !== index) }) });
  }, [id, ownCopy, readOnly, updateNodeData]);

  const mouseDown = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);
  const draftIsCurrent = copyDraftMatchesSource(refinementCopy, draftSig);
  const proposedBlocks = refined && hasRefinedCopy(refined) ? [refined.eyebrow, refined.title, refined.subtitle, refined.cta, ...refined.bullets].filter((v) => v.trim()).length : 0;
  const CHANGED_FIELDS: Array<"eyebrow" | "title" | "subtitle" | "cta"> = ["eyebrow", "title", "subtitle", "cta"];
  const changedBlocks = refined ? CHANGED_FIELDS.filter((f) => (ownCopy[f] ?? "") !== (refined?.[f] ?? "")).length + (JSON.stringify(ownCopy.bullets) !== JSON.stringify(refined.bullets) ? 1 : 0) : 0;

  const missingMessages = !ready && data.status !== "running" ? [
    ...(!inputs.imageUrl ? ["Connect a generated or uploaded image"] : []),
    ...(!hasRenderableText(effectiveContent) ? ["Add text to the overlay"] : []),
    ...(!inputs.composition ? ["Connect an Image Style Profile with a text area"] : []),
  ] : [];

  return (
    <div ref={cardRef} className={`node-card node-data-card w-full h-full flex flex-col${busy || isRendering ? " node-generating" : ""}`} style={{ minWidth: 340, overflow: "visible" }}>
      <CornerResizer minWidth={320} minHeight={360} />
      <span className="node-above-label">{data.label as string}</span>
      {missingMessages.length > 0 && <MissingInputWarning messages={missingMessages} />}
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 9, height: "100%", minHeight: 0 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: "rgba(249,115,22,0.14)", color: "#fdba74", fontWeight: 800, fontSize: 13 }}>T</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>Text Overlay</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Author copy, refine it, then render it onto a finished image</div>
          </div>
          <span style={{ color: ready ? "#86efac" : "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "monospace" }}>{ready ? "ready" : "waiting"}</span>
        </div>

        {/* Input status */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4 }}>
          {[
            ["IMAGE", !!inputs.imageUrl, inputs.imageUrl ? "Connected" : "Required"],
            ["STYLE", !!inputs.composition, inputs.composition ? `${Math.round(inputs.composition.copySpace.width * 100)}% reserved area` : "Required"],
          ].map(([label, valid, value]) => (
            <div key={String(label)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 7px", borderRadius: 6, border: `1px solid ${valid ? "rgba(74,222,128,0.2)" : "rgba(255,255,255,0.08)"}`, background: valid ? "rgba(74,222,128,0.05)" : "rgba(255,255,255,0.025)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: valid ? "#4ade80" : "rgba(255,255,255,0.25)" }} />
              <span style={{ width: 56, color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>{label}</span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: valid ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.35)", fontSize: 10 }}>{String(value)}</span>
            </div>
          ))}
        </div>

        {/* Scrollable content: copy editor + status + preview */}
        <div ref={scrollRef} className="node-scroll-region" style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2, minHeight: 0, flex: 1 }}>
          {/* Copy editor */}
          <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.2)", display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "rgba(253,186,116,0.8)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>COPY</span>
              <span style={{ color: ready ? "#86efac" : "rgba(255,255,255,0.35)", fontSize: 9 }}>{hasOwnText ? "editable" : "empty"}</span>
            </div>
            {FIELD_LABELS.map(({ key, label }) => (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label htmlFor={`text-overlay-${id}-${key}`} style={{ width: 62, color: "rgba(255,255,255,0.4)", fontSize: 9, fontWeight: 600 }}>{label}</label>
                <input
                  id={`text-overlay-${id}-${key}`}
                  value={ownCopy[key]}
                  readOnly={readOnly}
                  onChange={(e) => setTextField(key, e.target.value)}
                  onMouseDown={(e) => { if (readOnly) e.preventDefault(); }}
                  placeholder="—"
                  maxLength={500}
                  style={{ flex: 1, minWidth: 0, background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 5, padding: "4px 7px", fontSize: 11, color: "rgba(255,255,255,0.85)" }}
                />
              </div>
            ))}
            {ownCopy.bullets.map((bullet, index) => (
              <div key={index} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label htmlFor={`text-overlay-${id}-bullet-${index}`} style={{ width: 62, color: "rgba(255,255,255,0.4)", fontSize: 9, fontWeight: 600 }}>{index === 0 ? "Bullets" : `Bullet ${index + 1}`}</label>
                <input
                  id={`text-overlay-${id}-bullet-${index}`}
                  aria-label={`Bullet ${index + 1}`}
                  value={bullet}
                  readOnly={readOnly}
                  onChange={(e) => setBullet(index, e.target.value)}
                  onMouseDown={(e) => { if (readOnly) e.preventDefault(); }}
                  placeholder="• bullet"
                  maxLength={500}
                  style={{ flex: 1, minWidth: 0, background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 5, padding: "4px 7px", fontSize: 11, color: "rgba(255,255,255,0.85)" }}
                />
                {!readOnly && (
                  <button type="button" aria-label={`Remove bullet ${index + 1}`} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); removeBullet(index); }} title="Remove bullet" style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>×</button>
                )}
              </div>
            ))}
            {!readOnly && (
              <button type="button" disabled={ownCopy.bullets.length >= 5} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); addBullet(); }} style={{ alignSelf: "flex-start", background: "rgba(255,255,255,0.05)", border: "1px dashed rgba(255,255,255,0.18)", color: ownCopy.bullets.length >= 5 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.5)", borderRadius: 5, padding: "2px 7px", fontSize: 10, cursor: ownCopy.bullets.length >= 5 ? "not-allowed" : "pointer" }}>+ Add bullet</button>
            )}
            {/* Typography */}
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 6, marginTop: 2, display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label htmlFor={`text-overlay-${id}-font`} style={{ width: 62, color: "rgba(255,255,255,0.4)", fontSize: 9, fontWeight: 600 }}>Font</label>
                <select id={`text-overlay-${id}-font`} value={ownCopy.fontFamily} disabled={readOnly} onChange={(e) => setTextField("fontFamily", e.target.value)} onMouseDown={(e) => { if (readOnly) e.preventDefault(); }} style={{ flex: 1, minWidth: 0, background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 5, padding: "4px 7px", fontSize: 11, color: "rgba(255,255,255,0.85)" }}>
                  {["Arial", "Helvetica", "Georgia", "Times New Roman", ...fonts.map((f) => f.family)].filter((value, i, arr) => arr.indexOf(value) === i).map((family) => (
                    <option key={family} value={family}>{family}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 62, color: "rgba(255,255,255,0.4)", fontSize: 9, fontWeight: 600 }}>Colors</span>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "rgba(255,255,255,0.55)" }}>Text <input type="color" disabled={readOnly} value={ownCopy.textColor} onChange={(e) => setTextField("textColor", e.target.value)} onMouseDown={(e) => { if (readOnly) e.preventDefault(); }} style={{ width: 22, height: 18, border: "none", background: "transparent", padding: 0 }} /></label>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "rgba(255,255,255,0.55)" }}>Accent <input type="color" disabled={readOnly} value={ownCopy.accentColor} onChange={(e) => setTextField("accentColor", e.target.value)} onMouseDown={(e) => { if (readOnly) e.preventDefault(); }} style={{ width: 22, height: 18, border: "none", background: "transparent", padding: 0 }} /></label>
                <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                  {ALIGNMENTS.map((a) => (
                    <button key={a.value} type="button" disabled={readOnly} aria-label={`Align ${a.label.toLowerCase()}`} aria-pressed={ownCopy.alignment === a.value} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); setTextField("alignment", a.value); }} title={`Align ${a.label.toLowerCase()}`} style={{ background: ownCopy.alignment === a.value ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.05)", border: `1px solid ${ownCopy.alignment === a.value ? "rgba(249,115,22,0.4)" : "rgba(255,255,255,0.12)"}`, color: "#fff", borderRadius: 5, padding: "2px 7px", fontSize: 9, cursor: "pointer" }}>{a.label[0]}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* AI refinement */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5, borderRadius: 7, padding: "7px 9px", background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#c4b5fd", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", flex: 1 }}>AI IMPROVEMENT</span>
              <div ref={modelBarRef} style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
                <button type="button" disabled={busy || readOnly} aria-haspopup="menu" aria-expanded={modelOpen} aria-label="Select copy refinement model" onKeyDown={(e) => { if (e.key === "Escape") setModelOpen(false); }} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); if (!busy && !readOnly) setModelOpen((o) => !o); }} style={{ border: "1px solid rgba(167,139,250,0.24)", background: "rgba(167,139,250,0.12)", color: "#c4b5fd", padding: "2px 6px", borderRadius: 5, fontSize: 9, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
                  {modelOptions.find((m) => m.id === model)?.label ?? model}
                </button>
                {modelOpen && (
                  <div role="menu" aria-label="Copy refinement models" onKeyDown={(e) => { if (e.key === "Escape") setModelOpen(false); }} style={{ position: "fixed", zIndex: 1001, background: "#111622", border: "1px solid #1E2840", borderRadius: 8, overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)", width: 170 }}>
                    {modelOptions.map((m) => (
                      <button key={m.id} type="button" role="menuitemradio" aria-checked={model === m.id} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); updateNodeData(id, { copyModel: m.id }); setModelOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "transparent", fontSize: 11, color: model === m.id ? "#fff" : "rgba(255,255,255,0.6)", cursor: "pointer" }}>{m.label}</button>
                    ))}
                  </div>
                )}
              </div>
              {!readOnly && (busy ? (
                <button type="button" onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); handleCancel(); }} style={{ border: "1px solid #333", color: "#888", background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: "3px 7px", fontSize: 9, fontWeight: 600, cursor: "pointer" }}>Stop</button>
              ) : (
                <button id={`text-overlay-improve-${id}`} type="button" disabled={!refinementCopy || !hasRenderableText(refinementCopy)} aria-describedby={!refinementCopy || !hasRenderableText(refinementCopy) ? `text-overlay-improve-help-${id}` : undefined} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); handleImproveAI(); }} style={{ border: "1px solid rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.18)", color: "#c4b5fd", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 600, cursor: refinementCopy && hasRenderableText(refinementCopy) ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}>Improve with AI</button>
              ))}
            </div>
            <div id={`text-overlay-improve-help-${id}`} style={{ color: "rgba(255,255,255,0.45)", fontSize: 9, lineHeight: 1.4 }}>
              {refined && hasRefinedCopy(refined)
                ? (showOriginal ? "Showing original authored copy." : "Review the AI-improved draft, then approve it to make it the rendered copy.")
                : "Optional — polish your text without changing facts. Connect Variable/Brand context for tone and voice."}
            </div>
            {refined && hasRefinedCopy(refined) && (
              <div style={{ borderRadius: 5, padding: "5px 7px", background: "rgba(0,0,0,0.25)", border: `1px solid ${errorMsg ? "rgba(248,113,113,0.4)" : accepted ? "rgba(74,222,128,0.4)" : "rgba(167,139,250,0.3)"}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 3 }}>
                  <span style={{ color: errorMsg ? "#f87171" : accepted ? "#86efac" : "#c4b5fd", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>{errorMsg ? "REFINEMENT FAILED" : accepted ? "APPROVED COPY" : "DRAFT COPY"}</span>
                  {!busy && !errorMsg && (
                    <button type="button" onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); setShowOriginal((v) => !v); }} style={{ border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", color: showOriginal ? "#c4b5fd" : "rgba(255,255,255,0.55)", borderRadius: 5, padding: "1px 6px", fontSize: 8, fontWeight: 600, cursor: "pointer" }}>{showOriginal ? "Show draft" : "Compare original"}</button>
                  )}
                </div>
                <div style={{ color: "rgba(255,255,255,0.72)", fontSize: 10, lineHeight: 1.4, whiteSpace: "pre-wrap", maxHeight: 44, overflow: "auto" }}>
                  {showOriginal
                    ? refinementCopy ? [refinementCopy.eyebrow, refinementCopy.title, refinementCopy.subtitle, ...refinementCopy.bullets, refinementCopy.cta].filter((v) => v.trim()).join("\n") : ""
                    : errorMsg && !accepted ? "No refinement was produced. The rendered copy is your authored copy."
                    : [refined.eyebrow, refined.title, refined.subtitle, ...refined.bullets, refined.cta].filter((v) => v.trim()).join("\n")}
                </div>
                {!readOnly && !errorMsg && (
                  <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
                    {accepted ? (
                      <button type="button" onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); handleReject(); }} style={{ border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", background: "rgba(248,113,113,0.08)", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 600, cursor: "pointer" }}>Reject</button>
                    ) : (
                      <button id={`text-overlay-approve-${id}`} type="button" disabled={!draftIsCurrent} title={!draftIsCurrent ? "Re-run after editing the source copy" : undefined} onMouseDown={mouseDown} onClick={(e) => { e.stopPropagation(); handleAccept(); }} style={{ border: "1px solid rgba(74,222,128,0.4)", color: draftIsCurrent ? "#86efac" : "rgba(255,255,255,0.3)", background: draftIsCurrent ? "rgba(74,222,128,0.14)" : "rgba(255,255,255,0.04)", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 600, cursor: draftIsCurrent ? "pointer" : "not-allowed" }}>Approve text</button>
                    )}
                    <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 8, alignSelf: "center" }}>{proposedBlocks} blocks · {changedBlocks} changed</span>
                  </div>
                )}
              </div>
            )}
            {errorMsg && !refined && <div role="status" aria-live="polite" style={{ color: "#fca5a5", fontSize: 9 }}>{errorMsg.slice(0, 140)}</div>}
            {staleNote && <div role="status" aria-live="polite" style={{ color: "#fbbf24", fontSize: 9 }}>{staleNote}</div>}
          </div>

          {/* Render contract + preview */}
          <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.2)" }}>
            <div style={{ color: "rgba(253,186,116,0.8)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 3 }}>RENDER</div>
            <div role="status" aria-live="polite" style={{ color: "rgba(255,255,255,0.55)", fontSize: 10, lineHeight: 1.4 }}>
              {ready ? "Ready: renders the approved/authored copy exactly into the reserved text area." : !inputs.imageUrl ? "Required: connect a generated or uploaded image." : !hasRenderableText(effectiveContent) ? "Required: add copy to the overlay (or connect legacy Text Content)." : !inputs.composition ? "Required: connect an Image Style Profile with a reserved text area." : "Waiting…"}
            </div>
            {font?.familyKey && <div style={{ color: "rgba(253,186,116,0.72)", fontSize: 9, marginTop: 4 }}>Uploaded font: {font.family}</div>}
          </div>

          {truncated > 0 && (
            <div role="status" aria-live="polite" style={{ borderRadius: 6, padding: "6px 8px", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", fontSize: 10, lineHeight: 1.4 }}>
              {truncated} text line{truncated === 1 ? "" : "s"} did not fit the reserved text area and were clipped. Shorten the copy or enlarge the text area.
            </div>
          )}
          {stale && (
            <div role="status" aria-live="polite" style={{ borderRadius: 6, padding: "6px 8px", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", fontSize: 10, lineHeight: 1.4 }}>
              Inputs changed since this render — re-render to update the asset.
            </div>
          )}
          {data.imageUrl && (
            <div style={{ borderRadius: 7, overflow: "hidden", border: `1px solid ${stale ? "rgba(251,191,36,0.35)" : "rgba(134,239,172,0.25)"}` }}>
              <a href={data.imageUrl} target="_blank" rel="noreferrer" title="Open the rendered asset in a new tab" style={{ display: "block" }}>
                <img src={data.imageUrl} alt="Rendered text overlay result" style={{ width: "100%", maxHeight: 150, objectFit: "contain", background: "rgba(0,0,0,0.3)", display: "block" }} />
              </a>
              <div style={{ padding: "4px 7px", color: stale ? "#fbbf24" : "rgba(134,239,172,0.85)", fontSize: 9, background: "rgba(0,0,0,0.18)" }}>
                {stale ? "Stale result — inputs changed" : "Rendered asset ready — click to open"}
              </div>
            </div>
          )}
        </div>

        <button type="button" disabled={!ready || isRendering || busy || readOnly} aria-describedby={!ready ? `text-overlay-render-help-${id}` : undefined} className="nodrag" onMouseDown={mouseDown} onClick={render} style={{ border: "1px solid rgba(249,115,22,0.42)", background: ready ? "rgba(249,115,22,0.18)" : "rgba(255,255,255,0.04)", color: ready ? "#fdba74" : "rgba(255,255,255,0.28)", borderRadius: 7, padding: "7px 10px", cursor: ready && !isRendering && !busy && !readOnly ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 700 }}>{isRendering ? "Rendering…" : busy ? "Improving copy…" : "Render text overlay"}</button>
        {!ready && <span id={`text-overlay-render-help-${id}`} className="sr-only">{missingMessages.join("; ")}</span>}
        {data.status === "error" && !staleNote && <div role="status" aria-live="polite" style={{ color: "#fca5a5", fontSize: 10 }}>{String(data.errorMsg ?? "").slice(0, 140)}</div>}
      </div>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(18% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>IMAGE</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(31% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>STYLE</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(44% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>CONTEXT</span>
      <Handle type="target" position={Position.Left} id="image" title="Required: generated, uploaded, or rendered image" style={{ top: "18%", background: "#fb923c", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="target" position={Position.Left} id="style" title="Required: Image Style Profile reserved text area" style={{ top: "31%", background: "#38bdf8", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="target" position={Position.Left} id="variables" title="Optional: Variables or Brand Context for AI copy refinement" style={{ top: "44%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
      {edges.some((edge) => edge.target === id && edge.targetHandle === "text") && (
        <Handle type="target" position={Position.Left} id="text" title="Legacy Text Content input" className="node-handle-icon-text-input" style={{ top: "50%", background: "#f59e0b", border: "2px solid #171923", width: 10, height: 10 }} />
      )}
      <Handle type="source" position={Position.Right} id="imageOut" className="node-handle-icon node-handle-icon-out-image" title="Rendered image output" style={{ background: "#f97316", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
