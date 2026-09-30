"use client";

const STATES: Record<string, { color: string; label: string }> = {
  idle:    { color: "#6b7280", label: "Idle" },
  running: { color: "#38bdf8", label: "Running" },
  done:    { color: "#34d399", label: "Done" },
  error:   { color: "#f87171", label: "Error" },
  stale:   { color: "#f59e0b", label: "Out of date" },
};

/** Small, consistent status indicator for any node. Not colour-only: it carries a text label. */
export default function NodeStatusBadge({ status, stale, className = "" }: { status?: string; stale?: boolean; className?: string }) {
  const key = stale ? "stale" : STATES[status ?? "idle"] ? (status ?? "idle") : "idle";
  const s = STATES[key];
  return (
    <span
      role="status"
      aria-label={`Status: ${s.label}`}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${className}`}
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 14%, transparent)` }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: s.color, animation: key === "running" ? "pulse 1.2s ease-in-out infinite" : undefined }} />
      {s.label}
    </span>
  );
}
