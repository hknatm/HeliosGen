"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import {
  isValidVariableKey,
  normalizeVariableKey,
  serializeVariableValue,
  type WorkflowVariableField,
  type WorkflowVariableType,
} from "@/lib/workflowVariables";

type VariableNodeType = Node<NodeData, "variableNode">;

const TYPE_OPTIONS: Array<{ value: WorkflowVariableType; label: string; placeholder: string }> = [
  { value: "text", label: "Text", placeholder: "Cedar lounge chair" },
  { value: "number", label: "Number", placeholder: "249" },
  { value: "boolean", label: "Boolean", placeholder: "true or false" },
  { value: "json", label: "JSON", placeholder: '{ "material": "oak" }' },
];

function fieldId() {
  return `field-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function fieldsFromData(data: NodeData): WorkflowVariableField[] {
  if (Array.isArray(data.variables)) {
    return data.variables.filter((field): field is WorkflowVariableField =>
      !!field && typeof field.id === "string" && typeof field.key === "string" &&
      typeof field.value === "string" && ["text", "number", "boolean", "json"].includes(field.type),
    );
  }
  // Existing one-value Variable nodes migrate in memory without losing data.
  if (typeof data.variableKey === "string" || typeof data.variableValue === "string") {
    return [{
      id: fieldId(),
      key: typeof data.variableKey === "string" ? data.variableKey : "",
      value: typeof data.variableValue === "string" ? data.variableValue : "",
      type: (data.variableType ?? "text") as WorkflowVariableType,
    }];
  }
  return [{ id: fieldId(), key: "", value: "", type: "text" }];
}

export default function VariableNode({ id, data, selected }: NodeProps<VariableNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const fields = useMemo(() => fieldsFromData(data), [data]);

  useEffect(() => {
    if (!Array.isArray(data.variables)) updateNodeData(id, { variables: fields });
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
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      onNodesChange([{ type: "remove", id }]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, onNodesChange, selected]);

  const saveFields = useCallback((next: WorkflowVariableField[]) => {
    updateNodeData(id, { variables: next });
  }, [id, updateNodeData]);

  const updateField = useCallback((fieldId: string, patch: Partial<WorkflowVariableField>) => {
    saveFields(fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field));
  }, [fields, saveFields]);

  const duplicateKeys = new Set(fields
    .filter((field) => isValidVariableKey(field.key))
    .map((field) => field.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index));

  return (
    <div ref={cardRef} className="node-card w-full h-full flex flex-col" style={{ minWidth: 310, overflow: "visible" }}>
      <CornerResizer minWidth={290} minHeight={210} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: "rgba(167,139,250,0.14)", color: "#c4b5fd", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{"{}"}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>Variables</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>One structured input source for this workflow</div>
          </div>
          <span style={{ color: "rgba(196,181,253,0.75)", fontSize: 10, fontFamily: "monospace" }}>{fields.length} field{fields.length === 1 ? "" : "s"}</span>
        </div>

        <div ref={fieldsRef} className="node-scroll-region" style={{ display: "flex", flexDirection: "column", gap: 7, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2, minHeight: 0, flex: 1 }}>
          {fields.map((field) => {
            const validKey = isValidVariableKey(field.key);
            const duplicate = duplicateKeys.has(field.key);
            const option = TYPE_OPTIONS.find((item) => item.value === field.type) ?? TYPE_OPTIONS[0];
            return (
              <div key={field.id} style={{ border: `1px solid ${field.key && (!validKey || duplicate) ? "rgba(248,113,113,0.45)" : "rgba(255,255,255,0.08)"}`, background: "rgba(255,255,255,0.025)", borderRadius: 8, padding: 8, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 82px 24px", gap: 6, alignItems: "start" }}>
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                  <input
                    value={field.key}
                    disabled={readOnly}
                    placeholder="product_name"
                    aria-label="Variable key"
                    onChange={(event) => updateField(field.id, { key: event.target.value })}
                    onBlur={(event) => updateField(field.id, { key: normalizeVariableKey(event.target.value) })}
                    style={{ width: "100%", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "6px 7px", fontFamily: "monospace", fontSize: 11, outline: "none" }}
                  />
                  <textarea
                    value={field.value}
                    disabled={readOnly}
                    placeholder={option.placeholder}
                    aria-label={`${field.key || "Variable"} value`}
                    onChange={(event) => updateField(field.id, { value: event.target.value })}
                    onBlur={() => field.type === "json" && field.value.trim() && updateField(field.id, { value: serializeVariableValue(field) })}
                    style={{ width: "100%", minHeight: 38, resize: "vertical", boxSizing: "border-box", borderRadius: 5, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.16)", color: "rgba(255,255,255,0.82)", padding: "6px 7px", fontFamily: field.type === "json" ? "monospace" : "inherit", fontSize: 11, lineHeight: 1.4, outline: "none" }}
                  />
                  {field.key && (!validKey || duplicate) && <span style={{ color: "#f87171", fontSize: 9 }}>{duplicate ? "Duplicate key in this node" : "Keys use letters, numbers, and _"}</span>}
                </div>
                <select
                  value={field.type}
                  disabled={readOnly}
                  aria-label={`${field.key || "Variable"} type`}
                  onChange={(event) => updateField(field.id, { type: event.target.value as WorkflowVariableType })}
                  style={{ width: "100%", borderRadius: 5, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.78)", padding: "6px 4px", fontSize: 10, outline: "none" }}
                >
                  {TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <button
                  type="button"
                  disabled={readOnly || fields.length === 1}
                  aria-label={`Remove ${field.key || "variable"}`}
                  title={fields.length === 1 ? "Keep at least one field" : "Remove field"}
                  onClick={() => saveFields(fields.filter((item) => item.id !== field.id))}
                  style={{ width: 24, height: 26, padding: 0, border: "1px solid rgba(255,255,255,0.09)", borderRadius: 5, background: "transparent", color: fields.length === 1 ? "rgba(255,255,255,0.18)" : "rgba(248,113,113,0.75)", cursor: fields.length === 1 ? "not-allowed" : "pointer", fontSize: 16, lineHeight: 1 }}
                >×</button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          disabled={readOnly}
          onClick={() => saveFields([...fields, { id: fieldId(), key: "", value: "", type: "text" }])}
          style={{ alignSelf: "flex-start", border: "1px solid rgba(167,139,250,0.28)", background: "rgba(167,139,250,0.1)", color: "#ddd6fe", borderRadius: 6, padding: "5px 8px", cursor: readOnly ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
        >+ Add field</button>
      </div>
      <Handle type="source" position={Position.Right} id="dataOut" style={{ background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
