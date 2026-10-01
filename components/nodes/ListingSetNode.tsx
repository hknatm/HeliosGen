"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import CornerResizer from "./CornerResizer";
import TypedHandle from "./TypedHandle";
import NodeStatusBadge from "./NodeStatusBadge";
import NodeActionBar from "./NodeActionBar";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { loadSystemPromptSettings, type SystemPromptPreset } from "@/lib/systemPrompt";
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

  // Settings prompt library: each slot can use one preset instead of the built-in instruction.
  const [library, setLibrary] = useState<SystemPromptPreset[]>(() => loadSystemPromptSettings().presets);
  useEffect(() => {
    const refresh = () => setLibrary(loadSystemPromptSettings().presets);
    window.addEventListener("aiui-system-prompts-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("aiui-system-prompts-changed", refresh); window.removeEventListener("storage", refresh); };
  }, []);
  const slotPromptIds = useMemo(() => (data.listingSlotPrompts ?? {}) as Record<string, string>, [data.listingSlotPrompts]);
  /** Only presets that still exist count; a deleted preset falls back to the built-in instruction. */
  const slotPrompts = useMemo(() => {
    const out: Record<number, string> = {};
    for (const [slotId, presetId] of Object.entries(slotPromptIds)) {
      const preset = library.find((p) => p.id === presetId);
      if (preset) out[Number(slotId)] = preset.content;
    }
    return out;
  }, [slotPromptIds, library]);
  const setSlotPrompt = (slotId: number, presetId: string) => {
    const next = { ...slotPromptIds };
    if (presetId) next[String(slotId)] = presetId; else delete next[String(slotId)];
    updateNodeData(id, { listingSlotPrompts: next });
  };

  const model = (data.listingModel as string | undefined) ?? MULTIMODAL_AGENT_MODEL;
  const notes = (data.listingNotes as string | undefined) ?? "";
  const stored = useMemo(() => (Array.isArray(data.listingSlots) ? data.listingSlots : []) as ListingSlotState[], [data.listingSlots]);
  const facts = useMemo(() => resolveListingFacts(id, nodes, edges), [id, nodes, edges]);
  const resolution = useMemo(() => resolveReferenceImages(id, nodes, edges, "references"), [id, nodes, edges]);
  const settings = useMemo(() => resolveListingImageSettings(id, nodes, edges), [id, nodes, edges]);
  const refs = resolution.references;
  const slots = useMemo(() => initialSlotStates(facts, refs.map((r) => ({ name: r.name, usageNote: r.usageNote })), stored), [facts, refs, stored]);

  const signature = useMemo(() => listingSignature(facts, refs, model, settings, slotPrompts), [facts, refs, model, settings, slotPrompts]);
  // Each finished slot remembers the inputs it was made from, so re-running one slot never hides the others being out of date.
  const stale = slots.some((s) => s.status === "done" && (s.sig ?? (data.listingSignature as string | undefined)) !== signature);

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

  type RunMode = "sequential" | "all";
  const CONCURRENCY = 3;

  /**
   * sequential: one slot at a time (prompt, then image); pauses after the hero for review.
   * all: hero first, then the remaining prompts are written in order and their images run in parallel.
   */
  const run = useCallback(async (ids: number[], opts: { mode?: RunMode; keepPrompt?: boolean } = {}) => {
    if (busy || !settings || problems.length) return;
    const mode = opts.mode ?? "sequential";
    if (!ids.includes(1) && !current().find((s) => s.id === 1)?.imageUrl) {
      setMessage("Run slot 1 (the hero) first so the other images match it.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setMessage("");
    updateNodeData(id, { listingSignature: signature, status: "running", errorMsg: undefined });
    const refInfo = refs.map((r) => ({ name: r.name, usageNote: r.usageNote }));
    let failed = 0;
    try {
      const headers = await authHeaders();
      const description = await describeProductPhoto(model, refs, headers, controller.signal);

      const writePrompt = async (slotId: number): Promise<string | null> => {
        const state = initialSlotStates(facts, refInfo, current()).find((s) => s.id === slotId)!;
        if (state.status === "skipped") { setSlot(slotId, { status: "skipped", note: state.note }); return null; }
        const existing = opts.keepPrompt ? current().find((s) => s.id === slotId)?.prompt : undefined;
        if (existing) return existing;
        setSlot(slotId, { status: "running", note: "Writing prompt…" });
        const written = await writeSlotPrompt({ slotId, model, facts, description, references: refs, states: current(), headers, signal: controller.signal, instruction: slotPrompts[slotId] });
        if (written.skipReason) { setSlot(slotId, { status: "skipped", note: written.skipReason, prompt: undefined }); return null; }
        setSlot(slotId, { prompt: written.prompt });
        return written.prompt!;
      };
      const makeImage = async (slotId: number, prompt: string) => {
        setSlot(slotId, { status: "running", note: "Generating image…" });
        const hero = slotId > 1 ? current().find((s) => s.id === 1)?.imageUrl : undefined;
        const urls = [...refs.map((r) => r.url), ...(hero ? [hero] : [])].slice(0, 16);
        const imageUrl = await generateSlotImage({ prompt, imageUrls: urls, settings, headers, signal: controller.signal });
        setSlot(slotId, { status: "done", imageUrl, note: undefined, sig: signature });
      };
      const guarded = async (slotId: number, work: () => Promise<void>) => {
        try { await work(); } catch (e: unknown) {
          if ((e as Error)?.name === "AbortError") throw e;
          failed++;
          setSlot(slotId, { status: "error", note: e instanceof Error ? e.message : String(e) });
        }
      };
      const single = async (slotId: number) => guarded(slotId, async () => {
        const prompt = await writePrompt(slotId);
        if (prompt) await makeImage(slotId, prompt);
      });

      const heroFirst = ids.includes(1) && ids.length > 1;
      const rest = heroFirst ? ids.filter((x) => x !== 1) : ids;
      if (heroFirst) {
        await single(1);
        if (!current().find((s) => s.id === 1)?.imageUrl) {
          setMessage("The hero image failed, so the rest were not started. Fix slot 1 and run again.");
          return;
        }
        if (mode === "sequential") {
          setMessage("Slot 1 is ready. Review the hero, then press Run sequentially to continue.");
          return;
        }
      }
      if (mode === "sequential") {
        for (const slotId of rest) await single(slotId);
      } else {
        const prompts = new Map<number, string>();
        for (const slotId of rest) {
          await guarded(slotId, async () => { const p = await writePrompt(slotId); if (p) prompts.set(slotId, p); });
        }
        const queue = [...prompts.keys()];
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (let slotId = queue.shift(); slotId !== undefined; slotId = queue.shift()) {
            const sid = slotId;
            await guarded(sid, () => makeImage(sid, prompts.get(sid)!));
          }
        }));
      }
    } catch (e: unknown) {
      failed++;
      if ((e as Error)?.name === "AbortError") setMessage("Stopped.");
      else setMessage(e instanceof Error ? e.message : String(e));
      save(current().map((s) => (s.status === "running" ? { ...s, status: "idle" as const, note: undefined } : s)));
    } finally {
      updateNodeData(id, { status: failed ? "error" : "done", errorMsg: failed ? "Some slots did not finish" : undefined });
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, settings, problems.length, authHeaders, model, refs, facts, setSlot, save, signature, id, updateNodeData, current, slotPrompts, signature]);

  const pending = () => slots.filter((s) => s.status === "idle" || s.status === "error").map((s) => s.id);
  const runAll = () => run(pending(), { mode: "all" });
  const runSequential = () => run(pending(), { mode: "sequential" });
  const rerun = (slotId: number, keepPrompt: boolean) => run([slotId], { keepPrompt });

  // Canvas-wide Run all triggers this node in "all" mode.
  const runAllRef = useRef(runAll);
  useEffect(() => { runAllRef.current = runAll; });
  useEffect(() => {
    if (!data.pendingGenerate) return;
    updateNodeData(id, { pendingGenerate: false });
    if (problems.length || pending().length === 0) updateNodeData(id, { status: problems.length ? "error" : "done", errorMsg: problems[0] });
    else runAllRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.pendingGenerate]);
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
                <label className="block">
                  <span className="sr-only">Prompt for slot {slot.id}</span>
                  <select aria-label={`Prompt for slot ${slot.id}`} value={slotPrompts[slot.id] !== undefined ? slotPromptIds[String(slot.id)] : ""} disabled={readOnly || busy}
                    onChange={(e) => setSlotPrompt(slot.id, e.target.value)}
                    className="w-full rounded border border-white/10 bg-black/30 px-1 py-0.5 text-[9px] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
                    <option value="">Built-in prompt</option>
                    {library.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                {slotPromptIds[String(slot.id)] && slotPrompts[slot.id] === undefined && (
                  <span className="text-[9px] text-amber-300">Missing preset · using built-in</span>
                )}
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
        {stale && <div role="status" className="text-[10px] text-amber-300">Specs, photos or settings changed since these images were made. Re-run to update them.</div>}
        {(problems.length > 0 || message) && <div role="status" className="text-[10px] text-amber-300">{message || problems.join(" · ")}</div>}
        <div className="flex items-center justify-between gap-2 shrink-0">
          <span className="text-[10px] text-[var(--ui-text-faint)]">{done}/10 images</span>
          {!readOnly && (busy
            ? <button type="button" className={btn} onClick={stop}>Stop</button>
            : (
              <div className="flex gap-1">
                <button type="button" className={btn} disabled={problems.length > 0 || pending().length === 0} onClick={runSequential} title="One slot at a time; pauses after the hero image">Run sequentially</button>
                <button type="button" className={btn} disabled={problems.length > 0 || pending().length === 0} onClick={runAll} title="Hero first, then the other images in parallel">Run all</button>
              </div>
            ))}
        </div>
      </div>
      <TypedHandle id="imagesOut" kind="images" side="right" top={50} label="IMAGES" title="Every finished slot image, in slot order" connected={done > 0} />
      <TypedHandle id="references" kind="images" side="left" top={25} label="PHOTOS" title="Product photo, then optional customer photo" connected={refs.length > 0} />
      <TypedHandle id="specs" kind="context" side="left" top={50} label="SPECS" title="Variable, Brand or Style nodes" connected={facts.length > 0} />
      <TypedHandle id="settings" kind="images" side="left" top={75} label="IMAGE SETTINGS" title="Image node that supplies model and aspect ratio" connected={!!settings} />
    </div>
  );
}
