"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";

type VariableNodeType = Node<NodeData, "variableNode">;
type VariableType = NonNullable<NodeData["variableType"]>;

const TYPE_OPTIONS: Array<{ value: VariableType; label: string; placeholder: string }> = [
  { value: "text", label: "Text", placeholder: "e.g. Cedar lounge chair" },
  { value: "number", label: "Number", placeholder: "e.g. 249" },
  { value: "boolean", label: "Boolean", placeholder: "true or false" },
  { value: "json", label: "JSON", placeholder: '{\n  "material": "oak"\n}' },
];

function displayValue(value: string, type: VariableType): string {
  if (type !== "json") return value;
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

export default function VariableNode({ id, data, selected }: NodeProps<VariableNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const cardRef = useRef<HTMLDivElement>(null);
  const type = (data.variableType ?? "text") as VariableType;
  const key = (data.variableKey ?? "") as string;
  const value = (data.variableValue ?? "") as string;
  const currentOption = TYPE_OPTIONS.find((option) => option.value === type) ?? TYPE_OPTIONS[0];
  const validKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);

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

  const update = useCallback((patch: Partial<NodeData>) => updateNodeData(id, patch), [id, updateNodeData]);

  return (
    <div ref={cardRef} className="node-card w-full h-full flex flex-col" style={{ minWidth: 240, overflow: "visible" }}>
      <CornerResizer minWidth={220} minHeight={190} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 6, background: "rgba(167,139,250,0.14)", color: "#c4b5fd", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{"{}"}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: 600 }}>Variable</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Reusable workflow value</div>
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>KEY</span>
          <input
            value={key}
            disabled={readOnly}
            placeholder="product_name"
            aria-label="Variable key"
            onChange={(event) => update({ variableKey: event.target.value.trim() })}
            style={{ width: "100%", boxSizing: "border-box", borderRadius: 6, border: `1px solid ${key && !validKey ? "rgba(248,113,113,0.55)" : "rgba(255,255,255,0.1)"}`, background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "7px 8px", fontFamily: "monospace", fontSize: 12, outline: "none" }}
          />
        </label>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>TYPE</span>
            <select
              value={type}
              disabled={readOnly}
              aria-label="Variable type"
              onChange={(event) => update({ variableType: event.target.value as VariableType })}
              style={{ width: "100%", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "#151821", color: "rgba(255,255,255,0.82)", padding: "7px 8px", fontSize: 12, outline: "none" }}
            >
              {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div style={{ alignSelf: "end", color: validKey || !key ? "rgba(196,181,253,0.7)" : "#f87171", fontSize: 10, paddingBottom: 8 }}>
            {key ? (validKey ? `{{${key}}}` : "Use letters, numbers, _") : "Token pending"}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>VALUE</span>
          <textarea
            value={value}
            disabled={readOnly}
            placeholder={currentOption.placeholder}
            aria-label="Variable value"
            onChange={(event) => update({ variableValue: event.target.value })}
            onBlur={() => type === "json" && value.trim() && update({ variableValue: displayValue(value, type) })}
            style={{ width: "100%", minHeight: 54, resize: "none", boxSizing: "border-box", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.88)", padding: "7px 8px", fontFamily: type === "json" ? "monospace" : "inherit", fontSize: 12, lineHeight: 1.45, outline: "none" }}
          />
        </label>
      </div>
      <Handle type="source" position={Position.Right} id="textOut" style={{ background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
