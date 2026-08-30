"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Handle, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { type ProfileNodeConfig } from "@/lib/profileNodes";
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
  const fields = useMemo(() => fieldsFromData(data, config.defaultFields), [config.defaultFields, data]);

  const fieldId = useCallback(
    () => `${config.fieldIdPrefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    [config.fieldIdPrefix],
  );

  useEffect(() => {
    if (!Array.isArray(data.variables) || data.variables.length === 0) updateNodeData(id, { variables: fields });
  }, [data.variables, fields, id, updateNodeData]);

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

  return (
    <div ref={cardRef} className="node-card w-full h-full flex flex-col" style={{ minWidth: 330, overflow: "visible" }}>
      <CornerResizer minWidth={310} minHeight={260} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: config.accentBg, color: config.accentText, fontWeight: 700, fontSize: 13 }}>✦</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>{config.displayName}</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>{config.subtitle}</div>
          </div>
          <span style={{ color: config.accentText, opacity: 0.75, fontSize: 10, fontFamily: "monospace" }}>{fields.length} fields</span>
        </div>

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
                  <input value={field.key} disabled={readOnly} placeholder="lighting" aria-label={`${config.displayName} field key`} onChange={(event) => updateField(field.id, { key: event.target.value })} onBlur={(event) => updateField(field.id, { key: normalizeVariableKey(event.target.value) })} style={{ width: "100%", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }} />
                  {field.type === "color" ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <input type="color" value={isValidHexColor(field.value) ? normalizeHexColor(field.value) : "#000000"} disabled={readOnly} aria-label={`${field.key || config.displayName} color picker`} onChange={(event) => updateField(field.id, { value: event.target.value.toUpperCase() })} style={{ width: 32, height: 28, border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: 2, background: "rgba(0,0,0,0.16)", cursor: readOnly ? "default" : "pointer" }} />
                      <input value={field.value} disabled={readOnly} placeholder={option.placeholder} aria-label={`${field.key || config.displayName} color value`} onChange={(event) => updateField(field.id, { value: event.target.value })} onBlur={(event) => updateField(field.id, { value: normalizeHexColor(event.target.value) })} style={{ minWidth: 0, flex: 1, borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }} />
                    </div>
                  ) : <textarea value={field.value} disabled={readOnly} placeholder={option.placeholder} aria-label={`${field.key || config.displayName} value`} onChange={(event) => updateField(field.id, { value: event.target.value })} style={{ width: "100%", minHeight: 38, resize: "vertical", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: field.type === "json" ? "monospace" : "inherit", fontSize: 11, lineHeight: 1.4, outline: "none" }} />}
                  {field.key && (!validKey || duplicate || !validColor) && <span style={{ color: "#f87171", fontSize: 9 }}>{duplicate ? "Duplicate key in this node" : !validColor ? "Use a hex color such as #2F6B5F" : "Keys use letters, numbers, and _"}</span>}
                </div>
                <select value={field.type} disabled={readOnly} aria-label={`${field.key || config.displayName} type`} onChange={(event) => updateField(field.id, { type: event.target.value as WorkflowVariableType })} style={{ width: "100%", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.78)", padding: "6px 4px", fontSize: 10, outline: "none" }}>{TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                <button type="button" disabled={readOnly || fields.length === 1} aria-label={`Remove ${config.displayName} field`} title={fields.length === 1 ? "Keep at least one field" : "Remove field"} onClick={() => saveFields(fields.filter((item) => item.id !== field.id))} style={{ width: 24, height: 26, padding: 0, border: "1px solid rgba(255,255,255,0.09)", borderRadius: 5, background: "transparent", color: fields.length === 1 ? "rgba(255,255,255,0.18)" : "rgba(248,113,113,0.75)", cursor: fields.length === 1 ? "not-allowed" : "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
              </div>
            );
          })}
        </div>

        <button type="button" disabled={readOnly} onClick={addField} style={{ alignSelf: "flex-start", border: `1px solid ${config.accent}47`, background: config.accentBg, color: config.accentText, borderRadius: 6, padding: "5px 8px", cursor: readOnly ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}>+ Add field</button>
      </div>
      <Handle type="source" position={Position.Right} id="dataOut" style={{ background: config.accent, border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
