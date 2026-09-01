"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { hasRenderableText, resolveTextRendererInputs } from "@/lib/textRendererSources";
import { loadTextFonts, resolveTextFont } from "@/lib/textFonts";
import { loadTextRenderingSettings } from "@/lib/textRenderingSettings";
import { createClient } from "@/lib/supabase/client";

type TextRendererNodeType = Node<NodeData, "textRendererNode">;

export default function TextRendererNode({ id, data, selected }: NodeProps<TextRendererNodeType>) {
  const readOnly = useReadOnly();
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const cardRef = useRef<HTMLDivElement>(null);
  const [fonts, setFonts] = useState(() => loadTextFonts());
  const [rendering, setRendering] = useState(false);
  const renderRef = useRef<() => Promise<void>>(async () => {});

  const inputs = useMemo(() => resolveTextRendererInputs(id, nodes, edges), [edges, id, nodes]);
  const ready = !!inputs.imageUrl && hasRenderableText(inputs.content) && !!inputs.composition;
  const font = inputs.content ? resolveTextFont(fonts, inputs.content.fontFamily) : undefined;
  const isRendering = rendering || data.status === "running";

  useEffect(() => {
    const refresh = () => setFonts(loadTextFonts());
    window.addEventListener("aiui-text-fonts-changed", refresh);
    window.addEventListener("aiui-text-rendering-settings-changed", refresh);
    return () => {
      window.removeEventListener("aiui-text-fonts-changed", refresh);
      window.removeEventListener("aiui-text-rendering-settings-changed", refresh);
    };
  }, []);

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
    if (readOnly || rendering) return;
    if (!ready || !inputs.imageUrl || !inputs.content || !inputs.composition) {
      updateNodeData(id, { status: "error", errorMsg: "Connect an image, non-empty Text Content, and Image Style Profile text area." });
      return;
    }
    setRendering(true);
    // Preserve the latest successful result until a replacement has completed.
    updateNodeData(id, { status: "running", errorMsg: undefined });
    try {
      const { data: { session } } = await createClient().auth.getSession();
      const response = await fetch("/api/render-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({
          imageUrl: inputs.imageUrl,
          content: inputs.content,
          composition: inputs.composition,
          settings: loadTextRenderingSettings(),
          ...(font ? { fontUrl: font.url } : {}),
        }),
      });
      const result = await response.json().catch(() => ({})) as { imageUrl?: string; error?: string };
      if (!response.ok || !result.imageUrl) throw new Error(result.error ?? "Text render failed");
      updateNodeData(id, { status: "done", imageUrl: result.imageUrl, errorMsg: undefined });
    } catch (error: unknown) {
      updateNodeData(id, { status: "error", errorMsg: error instanceof Error ? error.message : "Text render failed" });
    } finally {
      setRendering(false);
    }
  }, [font, id, inputs, readOnly, ready, rendering, updateNodeData]);

  renderRef.current = render;
  useEffect(() => {
    if (!data.pendingRender) return;
    updateNodeData(id, { pendingRender: false });
    void renderRef.current();
  }, [data.pendingRender, id, updateNodeData]);

  const mouseDown = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);
  const hasUnacceptedCopy = edges.some((edge) => edge.target === id && edge.targetHandle === "text" && nodes.some((node) => node.id === edge.source && node.type === "copyComposerNode" && node.data.copyAccepted !== true));
  const message = !inputs.imageUrl ? "Required: connect a generated or uploaded image." : !hasRenderableText(inputs.content) ? (hasUnacceptedCopy ? "Required: approve the connected Text Refiner draft first." : "Required: connect Text Content with at least one non-empty field.") : !inputs.composition ? "Required: connect an Image Style Profile with a reserved text area." : "Ready: renders the approved text exactly into the reserved text area.";

  return (
    <div ref={cardRef} className={`node-card w-full h-full flex flex-col${isRendering ? " node-generating" : ""}`} style={{ minWidth: 320, overflow: "visible" }}>
      <CornerResizer minWidth={300} minHeight={250} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: "rgba(249,115,22,0.14)", color: "#fdba74", fontWeight: 800, fontSize: 13 }}>T</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>Text Renderer</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Places approved text onto a finished image</div>
          </div>
          <span style={{ color: ready ? "#86efac" : "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "monospace" }}>{ready ? "ready" : "waiting"}</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
          {[
            ["IMAGE", !!inputs.imageUrl, inputs.imageUrl ? "Connected" : "Required"],
            ["TEXT", hasRenderableText(inputs.content), inputs.content?.title || inputs.content?.eyebrow || inputs.content?.subtitle || inputs.content?.bullets.find((bullet) => bullet.trim()) || inputs.content?.cta || "Required"],
            ["TEXT AREA", !!inputs.composition, inputs.composition ? `${Math.round(inputs.composition.copySpace.width * 100)}% reserved` : "Required"],
          ].map(([label, valid, value]) => <div key={String(label)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 7px", borderRadius: 6, border: `1px solid ${valid ? "rgba(74,222,128,0.2)" : "rgba(255,255,255,0.08)"}`, background: valid ? "rgba(74,222,128,0.05)" : "rgba(255,255,255,0.025)" }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: valid ? "#4ade80" : "rgba(255,255,255,0.25)" }} /><span style={{ width: 72, color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>{label}</span><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: valid ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.35)", fontSize: 10 }}>{String(value)}</span></div>)}
        </div>

        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.2)" }}>
          <div style={{ color: "rgba(253,186,116,0.8)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 3 }}>RENDER CONTRACT</div>
          <div role="status" aria-live="polite" style={{ color: "rgba(255,255,255,0.55)", fontSize: 10, lineHeight: 1.4 }}>{message}</div>
          <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 9, lineHeight: 1.35, marginTop: 5 }}>Inputs are typed: image → IMAGE, authored or approved text → TEXT, and Image Style Profile → TEXT AREA.</div>
          {font && <div style={{ color: "rgba(253,186,116,0.72)", fontSize: 9, marginTop: 4 }}>Uploaded font: {font.family}</div>}
          {inputs.content && !font && !["Arial", "Helvetica", "Georgia", "Times New Roman"].includes(inputs.content.fontFamily) && <div style={{ color: "#fbbf24", fontSize: 9, marginTop: 4 }}>Selected uploaded font is unavailable; the renderer will use Arial.</div>}
        </div>

        <button type="button" disabled={!ready || isRendering || readOnly} className="nodrag" onMouseDown={mouseDown} onClick={render} style={{ border: "1px solid rgba(249,115,22,0.42)", background: ready ? "rgba(249,115,22,0.18)" : "rgba(255,255,255,0.04)", color: ready ? "#fdba74" : "rgba(255,255,255,0.28)", borderRadius: 7, padding: "7px 10px", cursor: ready && !isRendering && !readOnly ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 700 }}>{isRendering ? "Rendering…" : "Render text overlay"}</button>
        {data.imageUrl && <div role="status" aria-live="polite" style={{ color: "rgba(134,239,172,0.85)", fontSize: 10 }}>Rendered asset ready</div>}
        {data.errorMsg && <div role="status" aria-live="polite" style={{ color: "#fca5a5", fontSize: 10 }}>{String(data.errorMsg).slice(0, 140)}</div>}
      </div>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(35% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>IMAGE</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(50% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>TEXT</span>
      <span aria-hidden="true" style={{ position: "absolute", left: 13, top: "calc(65% - 7px)", color: "rgba(255,255,255,0.42)", fontSize: 8, fontWeight: 700, letterSpacing: "0.05em" }}>AREA</span>
      <Handle type="target" position={Position.Left} id="image" title="Required: generated, uploaded, or rendered image" style={{ top: "35%", background: "#fb923c", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="target" position={Position.Left} id="text" title="Required: Text Content or approved Text Refiner output" className="node-handle-icon-text-input" style={{ top: "50%", background: "#f59e0b", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="target" position={Position.Left} id="style" title="Required: Image Style Profile reserved text area" style={{ top: "65%", background: "#38bdf8", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} id="imageOut" className="node-handle-icon node-handle-icon-out-image" title="Rendered image output" style={{ background: "#f97316", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
