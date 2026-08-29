"use client";

import { useEffect, useMemo, useRef } from "react";
import { Handle, Node, NodeProps, Position } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import { NodeData, useWorkflowStore } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";

type PromptComposerNodeType = Node<NodeData, "promptComposerNode">;

type ConnectedValue = { key: string; value: string; label: string };

function resolveTemplate(template: string, values: ConnectedValue[]) {
  const valueByKey = new Map(values.map((value) => [value.key, value.value]));
  return template.replace(/{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g, (token, key: string) => valueByKey.get(key) ?? token);
}

export default function PromptComposerNode({ id, data, selected }: NodeProps<PromptComposerNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const cardRef = useRef<HTMLDivElement>(null);
  const template = (data.template ?? data.prompt ?? "") as string;

  const connectedValues = useMemo(() => {
    const incoming = edges.filter((edge) => edge.target === id && edge.targetHandle === "variables");
    return incoming.flatMap((edge): ConnectedValue[] => {
      const source = nodes.find((node) => node.id === edge.source);
      if (!source) return [];
      if (source.type === "variableNode") {
        const key = source.data.variableKey;
        if (typeof key !== "string" || !key) return [];
        return [{ key, value: String(source.data.variableValue ?? ""), label: String(source.data.label ?? key) }];
      }
      if (source.type === "promptNode" || source.type === "assistantNode" || source.type === "promptComposerNode") {
        const key = source.data.variableKey;
        if (typeof key !== "string" || !key) return [];
        return [{ key, value: String(source.data.resolvedPrompt ?? source.data.outputText ?? source.data.prompt ?? ""), label: String(source.data.label ?? key) }];
      }
      return [];
    });
  }, [edges, id, nodes]);

  const resolved = useMemo(() => resolveTemplate(template, connectedValues), [connectedValues, template]);
  const unresolvedTokens = useMemo(() => [...new Set(resolved.match(/{{\s*[A-Za-z_][A-Za-z0-9_]*\s*}}/g) ?? [])], [resolved]);

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
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
      onNodesChange([{ type: "remove", id }]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, onNodesChange, selected]);

  return (
    <div ref={cardRef} className="node-card w-full h-full flex flex-col" style={{ minWidth: 300, overflow: "visible" }}>
      <CornerResizer minWidth={280} minHeight={240} />
      <span className="node-above-label">{data.label as string}</span>
      <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, fontWeight: 600 }}>Prompt Composer</div>
            <div style={{ color: "rgba(255,255,255,0.34)", fontSize: 10, marginTop: 1 }}>Resolve connected {"{{variables}}"} deterministically</div>
          </div>
          <span style={{ color: "#f9a8d4", background: "rgba(244,114,182,0.12)", border: "1px solid rgba(244,114,182,0.24)", padding: "3px 6px", borderRadius: 5, fontSize: 10, fontWeight: 600 }}>NO AI</span>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 }}>
          <span style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>TEMPLATE</span>
          <textarea
            value={template}
            disabled={readOnly}
            aria-label="Prompt template"
            placeholder={"Studio product photo of {{product_name}}, made from {{material}}."}
            onChange={(event) => updateNodeData(id, { template: event.target.value })}
            style={{ width: "100%", minHeight: 74, flex: 1, resize: "none", boxSizing: "border-box", borderRadius: 7, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(0,0,0,0.2)", color: "rgba(255,255,255,0.9)", padding: "8px 9px", fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, outline: "none" }}
          />
        </label>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 20 }} aria-label="Connected variables">
          {connectedValues.length ? connectedValues.map((value) => (
            <span key={`${value.key}-${value.label}`} style={{ color: "#ddd6fe", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.2)", padding: "2px 6px", borderRadius: 4, fontSize: 10, fontFamily: "monospace" }}>{`{{${value.key}}}`}</span>
          )) : <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>Connect Variable nodes to resolve template tokens.</span>}
        </div>

        <div style={{ borderRadius: 7, padding: "8px 9px", background: "rgba(255,255,255,0.035)", border: `1px solid ${unresolvedTokens.length ? "rgba(251,191,36,0.28)" : "rgba(255,255,255,0.08)"}` }}>
          <div style={{ color: unresolvedTokens.length ? "#fcd34d" : "rgba(255,255,255,0.42)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 4 }}>{unresolvedTokens.length ? `MISSING: ${unresolvedTokens.join(", ")}` : "RESOLVED PROMPT"}</div>
          <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", maxHeight: 68, overflow: "auto" }}>{resolved || "Your resolved prompt will appear here."}</div>
        </div>
      </div>
      <Handle type="target" position={Position.Left} id="variables" style={{ top: "50%", background: "#a78bfa", border: "2px solid #171923", width: 10, height: 10 }} />
      <Handle type="source" position={Position.Right} id="textOut" style={{ background: "#f472b6", border: "2px solid #171923", width: 10, height: 10 }} />
    </div>
  );
}

export { resolveTemplate };
