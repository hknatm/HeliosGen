"use client";
import { Handle, Position } from "@xyflow/react";
import { HANDLE_KINDS, type HandleKind } from "@/lib/handleKinds";

interface Props {
  id: string;
  kind: HandleKind;
  side: "left" | "right";
  /** Vertical position as a percentage of node height. */
  top: number;
  /** Overrides the default kind label, e.g. "REFS". */
  label?: string;
  title?: string;
  connected?: boolean;
  showLabel?: boolean;
}

/** A colour-coded, labelled connection handle. Colour comes from the shared handle vocabulary. */
export default function TypedHandle({ id, kind, side, top, label, title, connected, showLabel = true }: Props) {
  const spec = HANDLE_KINDS[kind];
  const text = label ?? spec.label;
  return (
    <>
      {showLabel && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            [side]: 13,
            top: `calc(${top}% - 7px)`,
            color: connected ? spec.color : "var(--ui-text-faint)",
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: "0.05em",
            pointerEvents: "none",
          }}
        >
          {text}
        </span>
      )}
      <Handle
        type={side === "left" ? "target" : "source"}
        position={side === "left" ? Position.Left : Position.Right}
        id={id}
        title={title ?? `${text} — ${spec.hint}`}
        data-handle-kind={kind}
        style={{ top: `${top}%`, background: spec.color, border: "2px solid var(--ui-node-surface, #171923)", width: 10, height: 10 }}
      />
    </>
  );
}
