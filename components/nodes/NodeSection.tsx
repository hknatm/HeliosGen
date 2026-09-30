"use client";
import { useId, useState, type ReactNode } from "react";

interface Props {
  title: string;
  /** Short text shown next to the title while collapsed, e.g. the current value. */
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible group for a node's advanced controls. Keyboard and screen-reader friendly. */
export default function NodeSection({ title, summary, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className="shrink-0" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex w-full items-center gap-1.5 rounded px-0.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
      >
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>
          <path d="M2.5 1 5.5 4 2.5 7" />
        </svg>
        <span>{title}</span>
        {!open && summary && <span className="ml-auto truncate normal-case font-normal tracking-normal text-[var(--ui-text-faint)]">{summary}</span>}
      </button>
      <div id={panelId} hidden={!open} className="flex flex-col gap-1.5 pt-1">{children}</div>
    </div>
  );
}
