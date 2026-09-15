"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, TextContent, useWorkflowStore } from "@/lib/store";
import { textContentToPrompt } from "@/lib/executor";
import { fontOptions, loadTextFonts, TEXT_FONTS_CHANGED_EVENT } from "@/lib/textFonts";
import { loadTextRenderingSettings } from "@/lib/textRenderingSettings";
import { useReadOnly } from "@/lib/readOnlyContext";

type TextContentNodeType = Node<NodeData, "textContentNode">;

export const EMPTY_TEXT_CONTENT: TextContent = {
  eyebrow: "",
  title: "",
  subtitle: "",
  bullets: [],
  cta: "",
  fontFamily: "Arial",
  textColor: "#FFFFFF",
  accentColor: "#F59E0B",
  alignment: "left",
};

function contentFromData(data: NodeData): TextContent {
  const saved = data.textContent;
  if (!saved || typeof saved !== "object") return EMPTY_TEXT_CONTENT;
  return {
    eyebrow: typeof saved.eyebrow === "string" ? saved.eyebrow : "",
    title: typeof saved.title === "string" ? saved.title : "",
    subtitle: typeof saved.subtitle === "string" ? saved.subtitle : "",
    bullets: Array.isArray(saved.bullets) ? saved.bullets.filter((item): item is string => typeof item === "string") : [],
    cta: typeof saved.cta === "string" ? saved.cta : "",
    fontFamily: typeof saved.fontFamily === "string" && saved.fontFamily.trim() ? saved.fontFamily.trim() : "Arial",
    textColor: typeof saved.textColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(saved.textColor) ? saved.textColor.toUpperCase() : "#FFFFFF",
    accentColor: typeof saved.accentColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(saved.accentColor) ? saved.accentColor.toUpperCase() : "#F59E0B",
    alignment: saved.alignment === "center" || saved.alignment === "right" ? saved.alignment : "left",
  };
}

export default function TextContentNode({ id, data, selected }: NodeProps<TextContentNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const [fonts, setFonts] = useState(() => loadTextFonts());
  const content = useMemo(() => contentFromData(data), [data]);
  const availableFonts = useMemo(() => fontOptions(fonts), [fonts]);

  useEffect(() => {
    if (!data.textContent) {
      const defaults = loadTextRenderingSettings();
      updateNodeData(id, { textContent: { ...EMPTY_TEXT_CONTENT, fontFamily: defaults.defaultFontFamily, textColor: defaults.defaultTextColor, accentColor: defaults.defaultAccentColor, alignment: defaults.defaultAlignment } });
    }
  }, [data.textContent, id, updateNodeData]);

  useEffect(() => {
    const refresh = () => setFonts(loadTextFonts());
    window.addEventListener(TEXT_FONTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(TEXT_FONTS_CHANGED_EVENT, refresh);
  }, []);

  // If an uploaded font is removed, persist a valid deterministic fallback
  // instead of only showing Arial while leaving stale node data behind.
  useEffect(() => {
    if (availableFonts.includes(content.fontFamily)) return;
    updateNodeData(id, { textContent: { ...content, fontFamily: "Arial" } });
  }, [availableFonts, content, id, updateNodeData]);

  useEffect(() => {
    const fieldsElement = fieldsRef.current;
    if (!fieldsElement) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || fieldsElement.scrollHeight <= fieldsElement.clientHeight) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    fieldsElement.addEventListener("wheel", onWheel, { passive: true });
    return () => fieldsElement.removeEventListener("wheel", onWheel);
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

  const save = useCallback((patch: Partial<TextContent>) => {
    updateNodeData(id, { textContent: { ...content, ...patch } });
  }, [content, id, updateNodeData]);
  const fieldMouseDown = useCallback((event: React.MouseEvent) => {
    if (selected) event.stopPropagation(); else event.preventDefault();
  }, [selected]);
  const buttonMouseDown = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);
  const nonEmptyBlocks = [content.eyebrow, content.title, content.subtitle, content.cta, ...content.bullets].filter((item) => item.trim()).length;
  const promptPreview = textContentToPrompt(content);

  const textArea = (label: string, key: "eyebrow" | "title" | "subtitle" | "cta", placeholder: string, rows = 2) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.07em" }}>{label}</span>
      <textarea
        value={content[key]}
        disabled={readOnly}
        placeholder={placeholder}
        aria-label={`Text content ${label.toLowerCase()}`}
        rows={rows}
        maxLength={500}
        onMouseDown={fieldMouseDown}
        className="nodrag"
        onChange={(event) => save({ [key]: event.target.value })}
        style={{ width: "100%", minHeight: rows === 1 ? 32 : 40, resize: "vertical", boxSizing: "border-box", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "6px 8px", fontSize: 11, lineHeight: 1.4, outline: "none" }}
      />
    </label>
  );

  return (
    <div ref={cardRef} className="node-card node-data-card w-full h-full flex flex-col" style={{ minWidth: 330, overflow: "visible" }}>
      <CornerResizer minWidth={300} minHeight={300} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: "rgba(245,158,11,0.14)", color: "#fcd34d", fontWeight: 800, fontSize: 13 }}>T</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>Text Content</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Raw text — preserved exactly for review and rendering</div>
          </div>
          <span style={{ color: "rgba(252,211,77,0.8)", fontSize: 10, fontFamily: "monospace" }}>{nonEmptyBlocks} blocks</span>
        </div>

        <div ref={fieldsRef} className="node-scroll-region" style={{ display: "flex", flexDirection: "column", gap: 9, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2, minHeight: 0, flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 78px 78px", gap: 6 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>FONT
              <select value={availableFonts.includes(content.fontFamily) ? content.fontFamily : "Arial"} disabled={readOnly} aria-label="Text font family" onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => save({ fontFamily: event.target.value })} style={{ minWidth: 0, borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.85)", padding: "5px", fontSize: 10, outline: "none" }}>{availableFonts.map((family) => <option key={family} value={family}>{family}</option>)}</select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>TEXT
              <input type="color" value={content.textColor} disabled={readOnly} aria-label="Text color" onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => save({ textColor: event.target.value.toUpperCase() })} style={{ width: "100%", height: 28, padding: 2, borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", cursor: readOnly ? "default" : "pointer" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>ACCENT
              <input type="color" value={content.accentColor} disabled={readOnly} aria-label="Accent color" onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => save({ accentColor: event.target.value.toUpperCase() })} style={{ width: "100%", height: 28, padding: 2, borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", cursor: readOnly ? "default" : "pointer" }} />
            </label>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em" }}>ALIGNMENT
            <select value={content.alignment} disabled={readOnly} aria-label="Text alignment" onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => save({ alignment: event.target.value as TextContent["alignment"] })} style={{ borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.85)", padding: "5px", fontSize: 10, outline: "none" }}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select>
          </label>
          {textArea("EYEBROW", "eyebrow", "NEW COLLECTION", 1)}
          {textArea("TITLE", "title", "A headline for the finished asset", 2)}
          {textArea("SUBTITLE", "subtitle", "A concise supporting line", 2)}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 9, fontWeight: 700, letterSpacing: "0.07em" }}>BULLET POINTS</span>
            {content.bullets.map((bullet, index) => (
              <div key={index} style={{ display: "flex", gap: 6 }}>
                <textarea
                  value={bullet}
                  disabled={readOnly}
                  placeholder="Premium K9 crystal for memorable gifting"
                  aria-label={`Bullet point ${index + 1}`}
                  rows={2}
                  maxLength={500}
                  onMouseDown={fieldMouseDown}
                  className="nodrag"
                  onChange={(event) => {
                    const bullets = [...content.bullets];
                    bullets[index] = event.target.value;
                    save({ bullets });
                  }}
                  style={{ minWidth: 0, flex: 1, minHeight: 40, resize: "vertical", boxSizing: "border-box", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "6px 8px", fontSize: 11, lineHeight: 1.4, outline: "none" }}
                />
                <button type="button" disabled={readOnly} aria-label={`Remove bullet point ${index + 1}`} title="Remove bullet" className="nodrag" onMouseDown={buttonMouseDown} onClick={() => save({ bullets: content.bullets.filter((_, itemIndex) => itemIndex !== index) })} style={{ alignSelf: "flex-start", width: 25, height: 27, padding: 0, border: "1px solid rgba(255,255,255,0.09)", borderRadius: 6, background: "transparent", color: "rgba(248,113,113,0.8)", cursor: readOnly ? "default" : "pointer", fontSize: 16 }}>×</button>
              </div>
            ))}
            <button type="button" disabled={readOnly} className="nodrag" onMouseDown={buttonMouseDown} onClick={() => save({ bullets: [...content.bullets, ""] })} style={{ alignSelf: "flex-start", border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.1)", color: "#fcd34d", borderRadius: 6, padding: "5px 8px", cursor: readOnly ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}>+ Add bullet</button>
          </div>
          {textArea("CALL TO ACTION", "cta", "Explore the collection", 1)}
        </div>
        <div style={{ borderRadius: 7, padding: "7px 8px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)" }}>
          <div style={{ color: "rgba(252,211,77,0.76)", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 3 }}>DETERMINISTIC PROMPT INPUT</div>
          <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 10, lineHeight: 1.35, whiteSpace: "pre-wrap", maxHeight: 42, overflow: "auto" }}>{promptPreview || "Add text to use this node as a prompt source."}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} id="textOut" title="Structured text output" className="node-handle-icon node-handle-icon-out-text" style={{ background: "#f59e0b", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
