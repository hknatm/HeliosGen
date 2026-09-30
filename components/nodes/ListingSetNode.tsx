"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import TypedHandle from "./TypedHandle";
import NodeStatusBadge from "./NodeStatusBadge";
import NodeActionBar from "./NodeActionBar";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { createClient } from "@/lib/supabase/client";
import { assetSrc } from "@/lib/galleryUtils";
import { MULTIMODAL_AGENT_MODEL, resolveReferenceImages } from "@/lib/referenceBundle";
import { visionModelReady } from "@/lib/vision";
import { customModelId, customModelSupportsVision, loadCustomProviderModels } from "@/lib/customProvider";
import { LISTING_SLOTS } from "@/lib/listing/etsySlots";
import { initialSlotStates, listingSignature, type ListingSlotState } from "@/lib/listing/etsyFlow";
import {
  describeProductPhoto, generateSlotImage, resolveListingFacts, resolveListingImageSettings, writeSlotPrompt,
} from "@/lib/listing/runListing";

type ListingNodeType = Node<NodeData, "listingSetNode">;

export default function ListingSetNode({ id, data, selected }: NodeProps<ListingNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [customModels, setCustomModels] = useState(() => loadCustomProviderModels());
  useEffect(() => {
    const refresh = () => setCustomModels(loadCustomProviderModels());
    window.addEventListener("aiui-custom-provider-models-changed", refresh);
    return () => window.removeEventListener("aiui-custom-provider-models-changed", refresh);
  }, []);
  const modelOptions = useMemo(() => [
    { id: MULTIMODAL_AGENT_MODEL, label: "GPT 5.2 · Vision" },
    ...customModels.filter((m) => m.enabled !== false && customModelSupportsVision(customModelId(m.id))).map((m) => ({ id: customModelId(m.id), label: `${m.name} · Vision` })),
  ], [customModels]);
  const addNode = useWorkflowStore((s) => s.addNode);

  const model = (data.listingModel as string | undefined) ?? MULTIMODAL_AGENT_MODEL;
  const notes = (data.listingNotes as string | undefined) ?? "";
  const stored = useMemo(() => (Array.isArray(data.listingSlots) ? data.listingSlots : []) as ListingSlotState[], [data.listingSlots]);
  const facts = useMemo(() => resolveListingFacts(id, nodes, edges), [id, nodes, edges]);
  const resolution = useMemo(() => resolveReferenceImages(id, nodes, edges, "references"), [id, nodes, edges]);
  const settings = useMemo(() => resolveListingImageSettings(id, nodes, edges), [id, nodes, edges]);
  const refs = resolution.references;
  const slots = useMemo(() => initialSlotStates(facts, refs.map((r) => ({ name: r.name, usageNote: r.usageNote })), stored), [facts, refs, stored]);

  const signature = useMemo(() => listingSignature(facts, refs, model, settings), [facts, refs, model, settings]);
  const stale = slots.some((s) => s.status === "done") && typeof data.listingSignature === "string" && data.listingSignature !== signature;

  const problems = [
    ...(refs.length === 0 ? ["Connect the product photo to REFERENCES"] : []),
    ...(resolution.error ? [resolution.error] : []),
    ...(!settings ? ["Connect an Image node to SETTINGS for model and ratio"] : []),
    ...(facts.length === 0 ? ["Add product specs"] : []),
    ...(!visionModelReady(model) ? ["Select a Vision-capable model"] : []),
  ];
  const status = busy ? "running" : stale ? "stale" : slots.some((s) => s.status === "error") ? "error" : slots.some((s) => s.status === "done") ? "done" : "idle";

  const save = useCallback((next: ListingSlotState[]) => updateNodeData(id, { listingSlots: next }), [id, updateNodeData]);
  const setSlot = useCallback((slotId: number, patch: Partial<ListingSlotState>) => {
    const cur = (useWorkflowStore.getState().nodes.find((n) => n.id === id)?.data.listingSlots ?? []) as ListingSlotState[];
    const base = cur.some((s) => s.id === slotId) ? cur : [...cur, { id: slotId, status: "idle" as const }];
    save(base.map((s) => (s.id === slotId ? { ...s, ...patch } : s)));
  }, [id, save]);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const { data: { session } } = await createClient().auth.getSession();
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
    return h;
  }, []);

  const current = useCallback(() => (useWorkflowStore.getState().nodes.find((n) => n.id === id)?.data.listingSlots ?? []) as ListingSlotState[], [id]);

  /** Runs the given slots in order. Slot 1 pauses the run for hero review unless auto-run is on. */
  const run = useCallback(async (ids: number[], overridePrompts = false) => {
    if (busy || !settings || problems.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setMessage("");
    updateNodeData(id, { listingSignature: signature });
    try {
      const headers = await authHeaders();
      const description = await describeProductPhoto(model, refs, headers, controller.signal);
      for (const slotId of ids) {
        const slot = LISTING_SLOTS.find((s) => s.id === slotId)!;
        const state = initialSlotStates(facts, refs.map((r) => ({ name: r.name, usageNote: r.usageNote })), current()).find((s) => s.id === slotId)!;
        if (state.status === "skipped") { setSlot(slotId, { status: "skipped", note: state.note }); continue; }
        try {
          let prompt = overridePrompts ? current().find((s) => s.id === slotId)?.prompt : undefined;
          if (!prompt) {
            setSlot(slotId, { status: "running", note: "Writing prompt…" });
            const written = await writeSlotPrompt({ slotId, model, facts, description, references: refs, states: current(), headers, signal: controller.signal });
            if (written.skipReason) { setSlot(slotId, { status: "skipped", note: written.skipReason, prompt: undefined }); continue; }
            prompt = written.prompt!;
            setSlot(slotId, { prompt });
          }
          setSlot(slotId, { status: "running", note: "Generating image…" });
          const hero = slotId > 1 ? current().find((s) => s.id === 1)?.imageUrl : undefined;
          const urls = [...refs.map((r) => r.url), ...(hero ? [hero] : [])].slice(0, 16);
          const imageUrl = await generateSlotImage({ prompt, imageUrls: urls, settings, headers, signal: controller.signal });
          setSlot(slotId, { status: "done", imageUrl, note: undefined });
          if (slotId === 1 && ids.length > 1 && data.listingAutoRun !== true) {
            setMessage("Slot 1 is ready. Review the hero, then press Run to continue.");
            break;
          }
        } catch (e: unknown) {
          if ((e as Error)?.name === "AbortError") throw e;
          setSlot(slotId, { status: "error", note: e instanceof Error ? e.message : String(e) });
          void slot;
        }
      }
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") setMessage("Stopped.");
      else setMessage(e instanceof Error ? e.message : String(e));
      save(current().map((s) => (s.status === "running" ? { ...s, status: "idle" as const, note: undefined } : s)));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, settings, problems.length, authHeaders, model, refs, facts, setSlot, save, data.listingAutoRun, signature, id, updateNodeData, current]);

  const pending = () => slots.filter((s) => s.status === "idle" || s.status === "error").map((s) => s.id);
  const runAll = () => run(pending());
  const rerun = (slotId: number, keepPrompt: boolean) => run([slotId], keepPrompt);
  const stop = () => abortRef.current?.abort();
  const done = slots.filter((s) => s.status === "done").length;
  const btn = "rounded-md border border-white/15 px-2 py-1 text-[10px] text-foreground hover:bg-white/5 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";

  return (
    <div className={`node-card w-full h-full flex flex-col${busy ? " node-generating" : ""}`} style={{ minWidth: 420 }}>
      <CornerResizer minWidth={420} minHeight={420} />
      <span className="node-above-label">{data.label as string}</span>
      <NodeStatusBadge status={status} className="absolute -top-[22px] right-0" />
      <NodeActionBar visible={!!selected && !readOnly} hasContent={false} onDelete={() => onNodesChange([{ type: "remove", id }])} onDuplicate={() => {
        const src = useWorkflowStore.getState().nodes.find((n) => n.id === id);
        if (!src) return;
        onNodesChange([{ type: "select", id, selected: false }]);
        addNode({ ...src, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), position: { x: src.position.x + 20, y: src.position.y + 20 }, selected: true, data: { ...src.data, listingSlots: undefined } });
      }} />
      <div className="flex-1 min-h-0 flex flex-col gap-2 p-3" onMouseDown={(e) => { if (selected) e.stopPropagation(); }}>
        <label className="shrink-0">
          <span className="sr-only">Prompt writer model</span>
          <select aria-label="Prompt writer model" value={model} disabled={readOnly || busy} onChange={(e) => updateNodeData(id, { listingModel: e.target.value })}
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
            {!modelOptions.some((m) => m.id === model) && <option value={model}>{model} (not vision-enabled)</option>}
            {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="shrink-0">
          <span className="sr-only">Product notes, one key: value per line</span>
          <textarea aria-label="Product notes" rows={3} readOnly={readOnly} value={notes}
            placeholder={"Extra specs, one per line:\nmaterial: laser-engraved crystal\noccasion: memorial"}
            onChange={(e) => updateNodeData(id, { listingNotes: e.target.value })}
            className="w-full resize-none rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]" />
        </label>
        <div className="grid grid-cols-2 gap-2 flex-1 min-h-0 overflow-y-auto" aria-label="Listing image slots">
          {LISTING_SLOTS.map((slot) => {
            const s = slots.find((x) => x.id === slot.id)!;
            return (
              <div key={slot.id} className="flex flex-col gap-1 rounded-md border border-white/10 bg-black/20 p-1.5">
                <div className="flex items-center justify-between gap-1 text-[10px]">
                  <span className="truncate font-semibold">{slot.id}. {slot.name}</span>
                  <span className={s.status === "error" ? "text-red-400" : s.status === "done" ? "text-emerald-400" : "text-[var(--ui-text-faint)]"}>{s.status}</span>
                </div>
                {s.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetSrc(s.imageUrl)} alt={`${slot.name} result`} className="w-full rounded object-cover max-h-32" />
                )}
                {s.note && <span className={`text-[9px] ${s.status === "error" ? "text-red-400" : "text-[var(--ui-text-faint)]"}`}>{s.note}</span>}
                {s.prompt && (
                  <textarea aria-label={`Slot ${slot.id} prompt`} rows={3} readOnly={readOnly || busy} value={s.prompt}
                    onChange={(e) => setSlot(slot.id, { prompt: e.target.value })}
                    className="w-full resize-none rounded border border-white/10 bg-black/30 px-1 py-0.5 text-[9px] text-foreground" />
                )}
                {!readOnly && s.status !== "skipped" && (
                  <div className="flex gap-1">
                    <button type="button" className={btn} disabled={busy || problems.length > 0} onClick={() => rerun(slot.id, false)}>{s.imageUrl ? "Rewrite" : "Run"}</button>
                    {s.prompt && <button type="button" className={btn} disabled={busy || problems.length > 0} onClick={() => rerun(slot.id, true)}>Regenerate</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <label className="flex items-center gap-1 text-[10px] text-[var(--ui-text-muted)]">
          <input type="checkbox" disabled={readOnly} checked={data.listingAutoRun === true} onChange={(e) => updateNodeData(id, { listingAutoRun: e.target.checked })} />
          Run all slots without pausing after the hero
        </label>
        {stale && <div role="status" className="text-[10px] text-amber-300">Specs, photos or settings changed since these images were made. Re-run to update them.</div>}
        {(problems.length > 0 || message) && <div role="status" className="text-[10px] text-amber-300">{message || problems.join(" · ")}</div>}
        <div className="flex items-center justify-between gap-2 shrink-0">
          <span className="text-[10px] text-[var(--ui-text-faint)]">{done}/10 images</span>
          {!readOnly && (busy
            ? <button type="button" className={btn} onClick={stop}>Stop</button>
            : <button type="button" className={btn} disabled={problems.length > 0 || pending().length === 0} onClick={runAll}>Run</button>)}
        </div>
      </div>
      <TypedHandle id="references" kind="images" side="left" top={25} label="PHOTOS" title="Product photo, then optional customer photo" connected={refs.length > 0} />
      <TypedHandle id="specs" kind="context" side="left" top={50} label="SPECS" title="Variable, Brand or Style nodes" connected={facts.length > 0} />
      <TypedHandle id="settings" kind="images" side="left" top={75} label="IMAGE SETTINGS" title="Image node that supplies model and aspect ratio" connected={!!settings} />
    </div>
  );
}
