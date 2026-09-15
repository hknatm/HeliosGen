"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import {
  defaultStyleProfileJson,
  fieldsToProfileJson,
  profileJsonToFields,
  type ProfileNodeConfig,
} from "@/lib/profileNodes";
import {
  COPY_SPACE_PRESETS,
  parseStyleProfileObject,
  readStyleComposition,
  writeStyleComposition,
  formatStyleProfileObject,
  type StyleComposition,
} from "@/lib/styleComposition";
import {
  isValidHexColor,
  isValidVariableKey,
  normalizeHexColor,
  normalizeVariableKey,
  type WorkflowVariableField,
  type WorkflowVariableType,
} from "@/lib/workflowVariables";

const TYPE_OPTIONS: Array<{ value: WorkflowVariableType; label: string; placeholder: string }> = [
  { value: "text", label: "Text", placeholder: "Soft directional daylight" },
  { value: "color", label: "Color", placeholder: "#2F6B5F" },
  { value: "json", label: "JSON", placeholder: '{ "angle": "three-quarter" }' },
];

function fieldsFromData(data: NodeData, defaults: WorkflowVariableField[]): WorkflowVariableField[] {
  if (!Array.isArray(data.variables)) return defaults;
  const fields = data.variables.filter((field): field is WorkflowVariableField =>
    !!field && typeof field.id === "string" && typeof field.key === "string" &&
    typeof field.value === "string" && ["text", "json", "color"].includes(field.type),
  );
  return fields.length ? fields : defaults;
}

/** Validate a profile JSON payload and return either parsed fields or a parse error. */
function parseProfileJson(json: string): { fields: WorkflowVariableField[]; error: string | null } {
  if (!json.trim()) return { fields: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { fields: [], error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fields: [], error: "Expected a JSON object like { \"lighting\": \"soft\" }" };
  }
  return { fields: profileJsonToFields(json), error: null };
}

export interface ProfileDataNodeProps {
  id: string;
  data: NodeData;
  selected: boolean;
  config: ProfileNodeConfig;
}

export default function ProfileDataNode({ id, data, selected, config }: ProfileDataNodeProps) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);

  // Unified Style Profile is JSON-first. Legacy profile nodes (and Brand Context
  // kept for saved spaces) still use the row editor when they hold `variables`.
  // Legacy variables must never be clobbered by JSON seeding.
  const isStyle = config.namespace === "style";
  const hasVariables = Array.isArray(data.variables) && data.variables.length > 0;
  const jsonMode = isStyle && !hasVariables;

  const fields = useMemo(
    () => (jsonMode ? [] as WorkflowVariableField[] : fieldsFromData(data, config.defaultFields)),
    [config.defaultFields, data, jsonMode],
  );

  const fieldId = useCallback(
    () => `${config.fieldIdPrefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    [config.fieldIdPrefix],
  );

  // Seed a valid JSON payload for a brand-new Style profile node. Never touches
  // legacy nodes that already carry `variables`.
  useEffect(() => {
    if (jsonMode && typeof data.profileJson !== "string") {
      updateNodeData(id, { profileJson: defaultStyleProfileJson() });
    }
  }, [id, jsonMode, data.profileJson, updateNodeData]);

  // Legacy row editor: only hydrate default fields when the node has none.
  useEffect(() => {
    if (jsonMode) return;
    if (!Array.isArray(data.variables) || data.variables.length === 0) updateNodeData(id, { variables: fields });
  }, [data.variables, fields, id, jsonMode, updateNodeData]);

  useEffect(() => {
    const fieldsElement = fieldsRef.current;
    if (!fieldsElement) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const canScroll = fieldsElement.scrollHeight > fieldsElement.clientHeight;
      if (!canScroll) return;
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

  // ── Legacy row editor handlers ──────────────────────────────────────────
  const saveFields = useCallback((next: WorkflowVariableField[]) => updateNodeData(id, { variables: next }), [id, updateNodeData]);
  const updateField = useCallback((fieldId: string, patch: Partial<WorkflowVariableField>) => {
    saveFields(fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field));
  }, [fields, saveFields]);
  const addField = useCallback(
    () => saveFields([...fields, { id: fieldId(), key: "", value: "", type: "text" }]),
    [fieldId, fields, saveFields],
  );
  const duplicateKeys = new Set(fields
    .filter((field) => isValidVariableKey(field.key))
    .map((field) => field.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index));

  // ── JSON-first editor state ──────────────────────────────────────────────
  const profileJson = (data.profileJson ?? "") as string;
  const parsed = useMemo(() => parseProfileJson(profileJson), [profileJson]);
  const profileObject = useMemo(() => jsonMode ? parseStyleProfileObject(profileJson) : null, [jsonMode, profileJson]);
  const composition = useMemo(() => profileObject ? readStyleComposition(profileObject) : null, [profileObject]);
  const saveComposition = useCallback((patch: Partial<StyleComposition>) => {
    if (!profileObject) return;
    updateNodeData(id, { profileJson: formatStyleProfileObject(writeStyleComposition(profileObject, patch)) });
  }, [id, profileObject, updateNodeData]);

  // ── JSON-first row editor ────────────────────────────────────────────────
  // Local editable copy of the parsed profile fields. Keys are committed to
  // profileJson on blur (so they are never re-normalized mid-typing); values
  // and types commit on change. This makes every key/value directly editable
  // instead of the old read-only "KEYS (preview)" chips.
  const [jsonFields, setJsonFields] = useState<WorkflowVariableField[]>(() => parsed.fields);
  useEffect(() => {
    setJsonFields(parsed.fields);
  }, [parsed.fields]);

  const saveJsonFields = useCallback((next: WorkflowVariableField[]) => {
    updateNodeData(id, { profileJson: fieldsToProfileJson(next) });
  }, [id, updateNodeData]);

  const canSaveJsonFields = useCallback((next: WorkflowVariableField[]) => {
    const keys = next.map((field) => field.key);
    return keys.every(isValidVariableKey) && new Set(keys).size === keys.length;
  }, []);

  const updateJsonField = useCallback((fieldId: string, patch: Partial<WorkflowVariableField>) => {
    setJsonFields((prev) => prev.map((field) => field.id === fieldId ? { ...field, ...patch } : field));
  }, []);

  const commitJsonField = useCallback((fieldId: string, patch: Partial<WorkflowVariableField>) => {
    setJsonFields((prev) => {
      const next = prev.map((field) => field.id === fieldId ? { ...field, ...patch } : field);
      // Preserve an invalid/duplicate draft in the row editor for correction;
      // never let it silently overwrite or remove persisted instructions.
      if (canSaveJsonFields(next)) saveJsonFields(next);
      return next;
    });
  }, [canSaveJsonFields, saveJsonFields]);

  const addJsonField = useCallback(() => {
    // Keep a local blank row until its key is valid; it must not replace the
    // profile JSON with an accidental empty object.
    setJsonFields((prev) => [...prev, { id: fieldId(), key: "", value: "", type: "text" as WorkflowVariableType }]);
  }, [fieldId]);

  const removeJsonField = useCallback((fieldIdToRemove: string) => {
    setJsonFields((prev) => {
      const next = prev.filter((field) => field.id !== fieldIdToRemove);
      // Draft-only blank/invalid rows are not part of the saved JSON yet.
      const persisted = next.filter((field) => isValidVariableKey(field.key));
      const keys = persisted.map((field) => field.key);
      if (new Set(keys).size === keys.length) saveJsonFields(persisted);
      return next;
    });
  }, [saveJsonFields]);

  const jsonDuplicateKeys = useMemo(() => new Set(jsonFields
    .filter((field) => isValidVariableKey(field.key))
    .map((field) => field.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index)), [jsonFields]);

  // Stick-to-cursor guards: when selected, stop the mousedown from bubbling to
  // ReactFlow (which would drag the node); when unselected, preventDefault so a
  // first click selects the node instead of starting an edit/drag.
  const fieldMouseDown = useCallback((e: React.MouseEvent) => {
    if (selected) e.stopPropagation(); else e.preventDefault();
  }, [selected]);
  const buttonMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div ref={cardRef} className="node-card node-data-card w-full h-full flex flex-col" style={{ minWidth: 330, overflow: "visible" }}>
      <CornerResizer minWidth={310} minHeight={260} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: config.accentBg, color: config.accentText, fontWeight: 700, fontSize: 13 }}>✦</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>{config.displayName}</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>{jsonMode ? "JSON profile — validated on edit" : config.subtitle}</div>
          </div>
          {jsonMode
            ? <span style={{ color: config.accentText, opacity: 0.75, fontSize: 10, fontFamily: "monospace" }}>{parsed.error ? "invalid" : `${parsed.fields.length} keys`}</span>
            : <span style={{ color: config.accentText, opacity: 0.75, fontSize: 10, fontFamily: "monospace" }}>{fields.length} fields</span>}
        </div>

        {jsonMode ? (
          <>
            <div ref={fieldsRef} className="node-scroll-region" style={{ display: "flex", flexDirection: "column", gap: 7, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2, minHeight: 0, flex: 1 }}>
              {parsed.error ? (
                <>
                  <textarea
                    value={profileJson}
                    disabled={readOnly}
                    aria-label={`${config.displayName} JSON profile`}
                    spellCheck={false}
                    onChange={(event) => updateNodeData(id, { profileJson: event.target.value })}
                    onMouseDown={fieldMouseDown}
                    className="nodrag"
                    style={{ width: "100%", minHeight: 120, resize: "vertical", boxSizing: "border-box", borderRadius: 7, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "8px 9px", fontFamily: "monospace", fontSize: 11, lineHeight: 1.5, outline: "none" }}
                  />
                  <div style={{ borderRadius: 6, padding: "6px 8px", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 10 }}>
                    JSON parse error: {parsed.error}
                  </div>
                </>
              ) : composition ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 9, borderRadius: 8, border: `1px solid ${config.accent}3a`, background: config.accentBg }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: config.accentText, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em" }}>COMPOSITION & TEXT AREA</span>
                    <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 9 }}>Ratio-independent</span>
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.56)", fontSize: 10, lineHeight: 1.4 }}>The dashed area is intentionally left uncluttered so the Text Renderer can place your text there later.</div>
                  <div aria-label="Composition preview" style={{ position: "relative", width: "100%", aspectRatio: "1.65 / 1", borderRadius: 6, overflow: "hidden", background: "linear-gradient(135deg, rgba(255,255,255,0.09), rgba(0,0,0,0.22))", border: "1px solid rgba(255,255,255,0.11)" }}>
                    <div style={{ position: "absolute", left: `${composition.copySpace.x * 100}%`, top: `${composition.copySpace.y * 100}%`, width: `${composition.copySpace.width * 100}%`, height: `${composition.copySpace.height * 100}%`, boxSizing: "border-box", border: `1px dashed ${config.accentText}`, background: config.accentBg, display: "grid", placeItems: "center", color: config.accentText, fontSize: 9, fontWeight: 700, letterSpacing: "0.05em" }}>TEXT AREA</div>
                    <div aria-label="Subject placement intent" style={{ position: "absolute", top: "50%", transform: "translate(-50%, -50%)", left: composition.subjectAnchor === "left_third" ? "17%" : composition.subjectAnchor === "right_third" ? "83%" : "50%", width: composition.subjectScale === "small" ? 24 : composition.subjectScale === "large" ? 46 : 34, height: composition.subjectScale === "small" ? 24 : composition.subjectScale === "large" ? 46 : 34, borderRadius: "50%", background: "rgba(255,255,255,0.78)", border: "2px solid rgba(8,15,26,0.8)", boxShadow: "0 2px 10px rgba(0,0,0,0.4)" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>SUBJECT
                      <select value={composition.subjectAnchor} disabled={readOnly} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ subjectAnchor: event.target.value as StyleComposition["subjectAnchor"] })} style={{ borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 6px", fontSize: 10, outline: "none" }}><option value="left_third">Left third</option><option value="center">Center</option><option value="right_third">Right third</option></select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>SCALE
                      <select value={composition.subjectScale} disabled={readOnly} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ subjectScale: event.target.value as StyleComposition["subjectScale"] })} style={{ borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 6px", fontSize: 10, outline: "none" }}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select>
                    </label>
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>RESERVED TEXT AREA
                    <select value={composition.copySpacePreset} disabled={readOnly} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ copySpacePreset: event.target.value as StyleComposition["copySpacePreset"] })} style={{ borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 6px", fontSize: 10, outline: "none" }}>{COPY_SPACE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}<option value="custom">Custom zone</option></select>
                  </label>
                  {composition.copySpacePreset === "custom" && <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 5 }}>{(["x", "y", "width", "height"] as const).map((key) => <label key={key} style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>{key.toUpperCase()}<input type="number" min="0" max="1" step="0.01" value={Number(composition.copySpace[key].toFixed(2))} disabled={readOnly} aria-label={`Custom text area ${key}`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ copySpace: { ...composition.copySpace, [key]: Number(event.target.value) } })} style={{ minWidth: 0, borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 4px", fontSize: 10, outline: "none" }} /></label>)}</div>}
                  <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>TEXT-AREA BACKGROUND
                    <input value={composition.copySpaceBackground} disabled={readOnly} aria-label="Text-area background expectation" onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ copySpaceBackground: event.target.value })} style={{ width: "100%", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 6px", fontSize: 10, outline: "none" }} />
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>TEXT CONTRAST
                      <select value={composition.copySpaceContrast} disabled={readOnly} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ copySpaceContrast: event.target.value as StyleComposition["copySpaceContrast"] })} style={{ borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 6px", fontSize: 10, outline: "none" }}><option value="high">High contrast</option><option value="light">Light text</option><option value="dark">Dark text</option></select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 3, color: "rgba(255,255,255,0.48)", fontSize: 9 }}>KEEP CLEAR OF
                      <input value={composition.copySpaceAvoid.join(", ")} disabled={readOnly} aria-label="Text area avoid rules" onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => saveComposition({ copySpaceAvoid: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} style={{ minWidth: 0, borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)", background: "#111b28", color: "rgba(255,255,255,0.85)", padding: "5px 6px", fontSize: 10, outline: "none" }} />
                    </label>
                  </div>
                </div>
              ) : null}
              {jsonFields.length ? (
                <>
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 9, fontWeight: 600, letterSpacing: "0.06em" }}>PROFILE KEYS & VALUES</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }} aria-label="Style profile keys and values">
                    {jsonFields.map((field) => {
                      const validKey = isValidVariableKey(field.key);
                      const duplicate = jsonDuplicateKeys.has(field.key);
                      const validColor = field.type !== "color" || !field.value || isValidHexColor(field.value);
                      const option = TYPE_OPTIONS.find((item) => item.value === field.type) ?? TYPE_OPTIONS[0];
                      const invalid = field.key && (!validKey || duplicate || !validColor);
                      return (
                        <div key={field.id} style={{ border: `1px solid ${invalid ? "rgba(248,113,113,0.45)" : "rgba(255,255,255,0.08)"}`, background: "rgba(255,255,255,0.025)", borderRadius: 8, padding: 8, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 74px 24px", gap: 6, alignItems: "start" }}>
                          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                            <input value={field.key} disabled={readOnly} placeholder="lighting" aria-label={`${config.displayName} field key`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => updateJsonField(field.id, { key: event.target.value })} onBlur={(event) => commitJsonField(field.id, { key: normalizeVariableKey(event.target.value) })} style={{ width: "100%", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }} />
                            {field.type === "color" ? (
                              <div style={{ display: "flex", gap: 6 }}>
                                <input type="color" value={isValidHexColor(field.value) ? normalizeHexColor(field.value) : "#000000"} disabled={readOnly} aria-label={`${field.key || config.displayName} color picker`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => commitJsonField(field.id, { value: event.target.value.toUpperCase() })} style={{ width: 32, height: 28, border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: 2, background: "rgba(0,0,0,0.16)", cursor: readOnly ? "default" : "pointer" }} />
                                <input value={field.value} disabled={readOnly} placeholder={option.placeholder} aria-label={`${field.key || config.displayName} color value`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => commitJsonField(field.id, { value: event.target.value })} onBlur={(event) => commitJsonField(field.id, { value: normalizeHexColor(event.target.value) })} style={{ minWidth: 0, flex: 1, borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }} />
                              </div>
                            ) : <textarea value={field.value} disabled={readOnly} placeholder={option.placeholder} aria-label={`${field.key || config.displayName} value`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => commitJsonField(field.id, { value: event.target.value })} style={{ width: "100%", minHeight: 38, resize: "vertical", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: field.type === "json" ? "monospace" : "inherit", fontSize: 11, lineHeight: 1.4, outline: "none" }} />}
                            {field.key && (!validKey || duplicate || !validColor) && <span style={{ color: "#f87171", fontSize: 9 }}>{duplicate ? "Duplicate key in this node" : !validColor ? "Use a hex color such as #2F6B5F" : "Keys use letters, numbers, and _"}</span>}
                          </div>
                          <select value={field.type} disabled={readOnly} aria-label={`${field.key || config.displayName} type`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => commitJsonField(field.id, { type: event.target.value as WorkflowVariableType })} style={{ width: "100%", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.78)", padding: "6px 4px", fontSize: 10, outline: "none" }}>{TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                          <button type="button" disabled={readOnly} aria-label={`Remove ${config.displayName} field`} onMouseDown={buttonMouseDown} className="nodrag" title="Remove field" onClick={() => removeJsonField(field.id)} style={{ width: 24, height: 26, padding: 0, border: "1px solid rgba(255,255,255,0.09)", borderRadius: 5, background: "transparent", color: "rgba(248,113,113,0.75)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
                        </div>
                      );
                    })}
                  </div>
                  <button type="button" disabled={readOnly} onMouseDown={buttonMouseDown} className="nodrag" onClick={addJsonField} style={{ alignSelf: "flex-start", border: `1px solid ${config.accent}47`, background: config.accentBg, color: config.accentText, borderRadius: 6, padding: "5px 8px", cursor: readOnly ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}>+ Add key</button>
                  <details className="nodrag" onMouseDown={fieldMouseDown} style={{ borderRadius: 7, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", padding: "6px 8px" }}>
                    <summary style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, cursor: "pointer" }}>Advanced JSON profile</summary>
                    <textarea
                      value={profileJson}
                      disabled={readOnly}
                      aria-label={`${config.displayName} JSON profile`}
                      spellCheck={false}
                      onChange={(event) => updateNodeData(id, { profileJson: event.target.value })}
                      onMouseDown={fieldMouseDown}
                      className="nodrag"
                      placeholder='{ "shot_type": "Product hero shot", "lighting": "Soft directional daylight" }'
                      style={{ width: "100%", minHeight: 120, marginTop: 7, resize: "vertical", boxSizing: "border-box", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "8px 9px", fontFamily: "monospace", fontSize: 11, lineHeight: 1.5, outline: "none" }}
                    />
                  </details>
                </>
              ) : (
                <>
                  <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>Add a named instruction below, or use Advanced JSON for bulk editing.</span>
                  <button type="button" disabled={readOnly} onMouseDown={buttonMouseDown} className="nodrag" onClick={addJsonField} style={{ alignSelf: "flex-start", border: `1px solid ${config.accent}47`, background: config.accentBg, color: config.accentText, borderRadius: 6, padding: "5px 8px", cursor: readOnly ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}>+ Add key</button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div ref={fieldsRef} className="node-scroll-region" style={{ display: "flex", flexDirection: "column", gap: 7, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2, minHeight: 0, flex: 1 }}>
              {fields.map((field) => {
                const validKey = isValidVariableKey(field.key);
                const duplicate = duplicateKeys.has(field.key);
                const validColor = field.type !== "color" || !field.value || isValidHexColor(field.value);
                const option = TYPE_OPTIONS.find((item) => item.value === field.type) ?? TYPE_OPTIONS[0];
                const invalid = field.key && (!validKey || duplicate || !validColor);
                return (
                  <div key={field.id} style={{ border: `1px solid ${invalid ? "rgba(248,113,113,0.45)" : "rgba(255,255,255,0.08)"}`, background: "rgba(255,255,255,0.025)", borderRadius: 8, padding: 8, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 74px 24px", gap: 6, alignItems: "start" }}>
                    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                      <input value={field.key} disabled={readOnly} placeholder="lighting" aria-label={`${config.displayName} field key`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => updateField(field.id, { key: event.target.value })} onBlur={(event) => updateField(field.id, { key: normalizeVariableKey(event.target.value) })} style={{ width: "100%", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }} />
                      {field.type === "color" ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input type="color" value={isValidHexColor(field.value) ? normalizeHexColor(field.value) : "#000000"} disabled={readOnly} aria-label={`${field.key || config.displayName} color picker`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => updateField(field.id, { value: event.target.value.toUpperCase() })} style={{ width: 32, height: 28, border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: 2, background: "rgba(0,0,0,0.16)", cursor: readOnly ? "default" : "pointer" }} />
                          <input value={field.value} disabled={readOnly} placeholder={option.placeholder} aria-label={`${field.key || config.displayName} color value`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => updateField(field.id, { value: event.target.value })} onBlur={(event) => updateField(field.id, { value: normalizeHexColor(event.target.value) })} style={{ minWidth: 0, flex: 1, borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }} />
                        </div>
                      ) : <textarea value={field.value} disabled={readOnly} placeholder={option.placeholder} aria-label={`${field.key || config.displayName} value`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => updateField(field.id, { value: event.target.value })} style={{ width: "100%", minHeight: 38, resize: "vertical", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: field.type === "json" ? "monospace" : "inherit", fontSize: 11, lineHeight: 1.4, outline: "none" }} />}
                      {field.key && (!validKey || duplicate || !validColor) && <span style={{ color: "#f87171", fontSize: 9 }}>{duplicate ? "Duplicate key in this node" : !validColor ? "Use a hex color such as #2F6B5F" : "Keys use letters, numbers, and _"}</span>}
                    </div>
                    <select value={field.type} disabled={readOnly} aria-label={`${field.key || config.displayName} type`} onMouseDown={fieldMouseDown} className="nodrag" onChange={(event) => updateField(field.id, { type: event.target.value as WorkflowVariableType })} style={{ width: "100%", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.78)", padding: "6px 4px", fontSize: 10, outline: "none" }}>{TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                    <button type="button" disabled={readOnly || fields.length === 1} aria-label={`Remove ${config.displayName} field`} onMouseDown={buttonMouseDown} className="nodrag" title={fields.length === 1 ? "Keep at least one field" : "Remove field"} onClick={() => saveFields(fields.filter((item) => item.id !== field.id))} style={{ width: 24, height: 26, padding: 0, border: "1px solid rgba(255,255,255,0.09)", borderRadius: 5, background: "transparent", color: fields.length === 1 ? "rgba(255,255,255,0.18)" : "rgba(248,113,113,0.75)", cursor: fields.length === 1 ? "not-allowed" : "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
                  </div>
                );
              })}
            </div>

            <button type="button" disabled={readOnly} onMouseDown={buttonMouseDown} className="nodrag" onClick={addField} style={{ alignSelf: "flex-start", border: `1px solid ${config.accent}47`, background: config.accentBg, color: config.accentText, borderRadius: 6, padding: "5px 8px", cursor: readOnly ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}>+ Add field</button>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="dataOut" style={{ background: config.accent, border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
