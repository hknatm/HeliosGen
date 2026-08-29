"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import {
  isValidVariableKey,
  resolveWorkflowTemplate,
  serializeVariableValue,
  type ResolvedWorkflowVariable,
  type WorkflowVariableField,
} from "@/lib/workflowVariables";

type PromptComposerNodeType = Node<NodeData, "promptComposerNode">;

function legacyField(source: Node<NodeData>): WorkflowVariableField[] {
  if (typeof source.data.variableKey !== "string" || !source.data.variableKey) return [];
  return [{
    id: `${source.id}-legacy`,
    key: source.data.variableKey,
    value: String(source.data.variableValue ?? ""),
    type: source.data.variableType ?? "text",
  }];
}

export default function PromptComposerNode({ id, data, selected }: NodeProps<PromptComposerNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const template = (data.template ?? data.prompt ?? "") as string;

  const connectedValues = useMemo(() => {
    const incoming = edges.filter((edge) => edge.target === id && edge.targetHandle === "variables");
    return incoming.flatMap((edge): ResolvedWorkflowVariable[] => {
      const source = nodes.find((node) => node.id === edge.source);
      if (!source || source.type !== "variableNode") return [];
      const fields = Array.isArray(source.data.variables)
        ? source.data.variables as WorkflowVariableField[]
        : legacyField(source);
      return fields
        .filter((field) => isValidVariableKey(field.key))
        .map((field) => ({
          key: field.key,
          value: serializeVariableValue(field),
          sourceId: source.id,
          sourceLabel: String(source.data.label ?? "Variables"),
        }));
    });
  }, [edges, id, nodes]);

  const { resolved, missingKeys, duplicateKeys } = useMemo(
    () => resolveWorkflowTemplate(template, connectedValues),
    [connectedValues, template],
  );

  useEffect(() => {
    if (data.resolvedPrompt !== resolved || data.prompt !== resolved) {
      updateNodeData(id, { resolvedPrompt: resolved, prompt: resolved });
    }
  }, [data.prompt, data.resolvedPrompt, id, resolved, updateNodeData]);

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

  const chipKeys = [...new Set(connectedValues.map((variable) => variable.key))].sort();
  const missingMessage = duplicateKeys.length
    ? `DUPLICATE KEYS: ${duplicateKeys.join(", ")}`
    : missingKeys.length ? `MISSING: ${missingKeys.join(", ")}` : null;

  return (
    <div ref={cardRef} className="node-card w-full h-full flex flex-col" style={{ minWidth: 320, overflow: "visible" }}>
      <CornerResizer minWidth={300} minHeight={250} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, fontWeight: 600 }}>Prompt Composer</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Drag a connected key into your template</div>
          </div>
          <span style={{ color: "#f9a8d4", background: "rgba(244,114,182,0.12)", border: "1px solid rgba(244,114,182,0.24)", padding: "3px 6px", borderRadius: 5, fontSize: 10, fontWeight: 600 }}>NO AI</span>
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
                onClick={() => insertToken(key)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData("text/plain", key);
                }}
                style={{ color: "#ddd6fe", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.24)", padding: "3px 7px", borderRadius: 4, fontSize: 10, fontFamily: "monospace", cursor: readOnly ? "default" : "grab" }}
              >{key}</button>
            )) : <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>Connect a Variables node to add keys.</span>}
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

        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(255,255,255,0.035)", border: `1px solid ${missingMessage ? "rgba(251,191,36,0.35)" : "rgba(255,255,255,0.08)"}` }}>
          <div style={{ color: missingMessage ? "#fcd34d" : "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 4 }}>{missingMessage ?? "RESOLVED PROMPT"}</div>
          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", maxHeight: 68, overflow: "auto" }}>{resolved || "Your resolved prompt will appear here."}</div>
        </div>
      </div>
      <Handle type="target" position={Position.Left} id="variables" style={{ top: "50%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} id="textOut" style={{ background: "#f472b6", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}
