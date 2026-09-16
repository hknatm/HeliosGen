"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node, useUpdateNodeInternals } from "@xyflow/react";
import { ChevronDown, ChevronUp, ImagePlus, Trash2, Upload } from "lucide-react";
import CornerResizer from "./CornerResizer";
import { useWorkflowStore, NodeData, type ReferenceImageInput } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { createClient } from "@/lib/supabase/client";
import { sha256Hex } from "@/lib/assetHash";


type ImageInputNodeType = Node<NodeData, "imageInputNode">;

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const MAX_REFERENCES = 16;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function legacyReference(data: NodeData): ReferenceImageInput[] {
  const url = (data.r2Url ?? data.inputImage) as string | undefined;
  if (!url) return [];
  return [{
    id: "legacy-reference",
    inputImage: data.inputImage as string | undefined,
    r2Url: data.r2Url as string | undefined,
    naturalRatio: data.imageNaturalRatio as string | undefined,
    name: typeof data.referenceName === "string" && data.referenceName.trim() ? data.referenceName : "Reference 1",
    usageNote: typeof data.referenceUsage === "string" ? data.referenceUsage : "",
    status: data.uploadError ? "error" : data.r2Url ? "ready" : "uploading",
    error: typeof data.uploadError === "string" ? data.uploadError : undefined,
  }];
}

function normalizedReferences(data: NodeData): ReferenceImageInput[] {
  if (Array.isArray(data.referenceImages)) return data.referenceImages as ReferenceImageInput[];
  return legacyReference(data);
}

export default function ImageInputNode({ id, data }: NodeProps<ImageInputNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addToast = useWorkflowStore((state) => state.addToast);
  const updateNodeSize = useWorkflowStore((state) => state.updateNodeSize);
  const edges = useWorkflowStore((state) => state.edges);
  const sourceConnected = edges.some((edge) => edge.source === id);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const references = useMemo(() => normalizedReferences(data), [data]);
  const legacyTextConnected = edges.some((edge) => edge.target === id && edge.targetHandle === "decorativeText");
  const legacyImageConnected = edges.some((edge) => edge.target === id && edge.targetHandle === "decorativeImage");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const dialogTitleId = useId();
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lightboxTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      updateNodeSize(id, element.offsetWidth, element.offsetHeight);
      updateNodeInternals(id);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, updateNodeInternals, updateNodeSize]);

  const persist = useCallback((next: ReferenceImageInput[]) => {
    const first = next[0];
    updateNodeData(id, {
      referenceImages: next,
      // Keep legacy consumers and old saved-workflow code functional by exposing item 1.
      inputImage: first?.inputImage,
      r2Url: first?.r2Url,
      imageNaturalRatio: first?.naturalRatio,
      referenceName: first?.name,
      referenceUsage: first?.usageNote,
      uploadError: next.find((item) => item.status === "error")?.error,
    });
  }, [id, updateNodeData]);

  const patchItem = useCallback((itemId: string, patch: Partial<ReferenceImageInput>) => {
    const currentData = useWorkflowStore.getState().nodes.find((node) => node.id === id)?.data ?? data;
    persist(normalizedReferences(currentData).map((item) => item.id === itemId ? { ...item, ...patch } : item));
  }, [data, id, persist]);

  const uploadFile = useCallback(async (file: File, itemId = uid()) => {
    if (DEMO_MODE) { useWorkflowStore.getState().setAuthModalOpen(true); return; }
    if (!file.type.startsWith("image/")) { addToast(`${file.name}: choose a valid image file.`, "error"); return; }
    if (file.size > 30 * 1024 * 1024) { addToast(`${file.name}: reference images must be 30 MB or smaller.`, "error"); return; }

    const current = normalizedReferences(useWorkflowStore.getState().nodes.find((node) => node.id === id)?.data ?? data);
    if (!current.some((item) => item.id === itemId) && current.length >= MAX_REFERENCES) {
      addToast(`A reference node supports up to ${MAX_REFERENCES} images.`, "error");
      return;
    }

    const blobUrl = URL.createObjectURL(file);
    const existing = current.find((item) => item.id === itemId);
    const draft: ReferenceImageInput = {
      id: itemId,
      inputImage: blobUrl,
      name: existing?.name || file.name.replace(/\.[^.]+$/, "").slice(0, 80) || `Reference ${current.length + 1}`,
      usageNote: existing?.usageNote ?? "",
      status: "uploading",
    };
    const next = current.some((item) => item.id === itemId)
      ? current.map((item) => item.id === itemId ? { ...item, ...draft } : item)
      : [...current, draft];
    persist(next);

    try {
      const bytes = await file.arrayBuffer();
      const hash = await sha256Hex(bytes);
      const { data: { session } } = await createClient().auth.getSession();
      const authHeaders: Record<string, string> = {};
      if (session?.access_token) authHeaders.Authorization = `Bearer ${session.access_token}`;

      try {
        const lookup = await fetch(`/api/lookup-asset?hash=${hash}`, { headers: authHeaders });
        const cached = await lookup.json() as { cdnUrl?: string | null };
        if (lookup.ok && cached.cdnUrl) {
          patchItem(itemId, { inputImage: cached.cdnUrl, r2Url: cached.cdnUrl, status: "ready", error: undefined });
          URL.revokeObjectURL(blobUrl);
          return;
        }
      } catch { /* upload normally */ }

      const response = await fetch("/api/upload-asset", {
        method: "POST",
        headers: { "Content-Type": file.type || "image/jpeg", ...authHeaders },
        body: bytes,
      });
      const payload = await response.json().catch(() => ({})) as { cdnUrl?: string; error?: string };
      if (!response.ok || !payload.cdnUrl) throw new Error(payload.error || `Upload failed (${response.status})`);
      patchItem(itemId, { inputImage: payload.cdnUrl, r2Url: payload.cdnUrl, status: "ready", error: undefined });
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reference image upload failed";
      patchItem(itemId, { inputImage: undefined, status: "error", error: message });
      URL.revokeObjectURL(blobUrl);
      addToast(message, "error");
    }
  }, [addToast, data, id, patchItem, persist]);

  const addFiles = useCallback((files: File[]) => {
    const available = MAX_REFERENCES - references.length;
    const accepted = files.filter((file) => file.type.startsWith("image/")).slice(0, available);
    if (files.length > available) addToast(`Only ${available} more reference image${available === 1 ? "" : "s"} can be added.`, "error");
    accepted.forEach((file) => void uploadFile(file));
  }, [addToast, references.length, uploadFile]);

  const move = useCallback((index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= references.length) return;
    const next = [...references];
    [next[index], next[target]] = [next[target], next[index]];
    persist(next);
  }, [persist, references]);

  const remove = useCallback((itemId: string) => {
    const item = references.find((candidate) => candidate.id === itemId);
    if (item?.inputImage?.startsWith("blob:")) URL.revokeObjectURL(item.inputImage);
    persist(references.filter((candidate) => candidate.id !== itemId));
  }, [persist, references]);

  const lightboxItem = lightboxIndex === null ? undefined : references[lightboxIndex];
  const lightboxOpen = !!lightboxItem;
  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
    requestAnimationFrame(() => lightboxTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!lightboxOpen) return;
    closeButtonRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeLightbox(); return; }
      if (event.key !== "Tab") return;
      const controls = lightboxRef.current?.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", trapFocus);
    return () => window.removeEventListener("keydown", trapFocus);
  }, [closeLightbox, lightboxOpen]);

  return (
    <div ref={rootRef} className={`node-card multi-reference-node w-full h-full flex flex-col${data.hasError ? " node-error-blink" : ""}`} style={{ minWidth: 360, minHeight: 240 }}>
      <CornerResizer minWidth={340} minHeight={220} />
      <span className="node-above-label">{data.label as string}</span>

      {(legacyTextConnected || legacyImageConnected) && (
        <>
          <Handle type="target" position={Position.Left} id="decorativeText" style={{ top: "42%", opacity: legacyTextConnected ? 1 : 0 }} className="node-handle-icon node-handle-icon-prompt" />
          <Handle type="target" position={Position.Left} id="decorativeImage" style={{ top: "58%", opacity: legacyImageConnected ? 1 : 0 }} className="node-handle-icon node-handle-icon-resource" />
        </>
      )}

      <Handle
        type="source"
        position={Position.Right}
        style={{ top: "50%" }}
        className={`node-handle-icon node-handle-icon-out-image${sourceConnected ? " node-handle-connected" : ""}`}
        title={`Ordered reference output (${references.length} image${references.length === 1 ? "" : "s"})`}
      >
        <ImageOutIcon />
      </Handle>

      <div className="multi-reference-header">
        <div>
          <strong>Ordered references</strong>
          <span>{references.length}/{MAX_REFERENCES} · sent top to bottom</span>
        </div>
        {!readOnly && (
          <button type="button" className="multi-reference-add" onClick={() => fileRef.current?.click()} disabled={references.length >= MAX_REFERENCES}>
            <ImagePlus size={14} /> Add images
          </button>
        )}
      </div>

      <div
        className="multi-reference-list nowheel nodrag"
        role="list"
        aria-label="Ordered reference images"
        onMouseDown={(event) => event.stopPropagation()}
        onDrop={(event) => { event.preventDefault(); if (!readOnly) addFiles(Array.from(event.dataTransfer.files)); }}
        onDragOver={(event) => event.preventDefault()}
      >
        {references.length === 0 ? (
          <button type="button" className="multi-reference-empty" aria-label="Add reference images" onClick={() => !readOnly && fileRef.current?.click()} disabled={readOnly}>
            <Upload size={20} />
            <strong>Add reference images</strong>
            <span>Select or drop up to 16 images. Their row order becomes Reference 1…N.</span>
          </button>
        ) : references.map((item, index) => {
          const src = item.r2Url ?? item.inputImage;
          return (
            <div key={item.id} className={`multi-reference-row${item.status === "error" ? " multi-reference-row-error" : ""}`} role="listitem">
              <div className="multi-reference-order" aria-label={`Reference ${index + 1}`}>{index + 1}</div>
              <button type="button" className="multi-reference-thumb" onClick={(event) => { lightboxTriggerRef.current = event.currentTarget; setLightboxIndex(index); }} aria-label={`Preview Reference ${index + 1}: ${item.name}`}>
                {src ? (
                  // Dynamic workflow assets may be local, signed, or remote.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt="" />
                ) : <ImagePlus size={18} />}
                {item.status === "uploading" && <span className="multi-reference-progress" role="status">Uploading</span>}
              </button>
              <div className="multi-reference-fields">
                <label>
                  <span>Reference {index + 1} name / tag</span>
                  <input value={item.name} maxLength={80} readOnly={readOnly} onChange={(event) => patchItem(item.id, { name: event.target.value })} placeholder={`Reference ${index + 1}`} />
                </label>
                <label>
                  <span>How to use Reference {index + 1}</span>
                  <textarea value={item.usageNote} maxLength={500} readOnly={readOnly} onChange={(event) => patchItem(item.id, { usageNote: event.target.value })} placeholder="Subject, style, composition, background…" rows={2} />
                </label>
                {item.error && <p role="alert">{item.error}</p>}
              </div>
              {!readOnly && (
                <div className="multi-reference-actions" aria-label={`Reference ${index + 1} actions`}>
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move Reference ${index + 1} up`}><ChevronUp size={14} /></button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === references.length - 1} aria-label={`Move Reference ${index + 1} down`}><ChevronDown size={14} /></button>
                  <button type="button" onClick={() => remove(item.id)} aria-label={`Remove Reference ${index + 1}`}><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {lightboxItem && typeof document !== "undefined" && createPortal(
        <div ref={lightboxRef} className="multi-reference-lightbox" role="dialog" aria-modal="true" aria-labelledby={dialogTitleId} onClick={(event) => { if (event.target === event.currentTarget) closeLightbox(); }}>
          <h2 id={dialogTitleId} className="sr-only">Reference {lightboxIndex! + 1}: {lightboxItem.name}</h2>
          <button ref={closeButtonRef} type="button" onClick={closeLightbox} aria-label="Close reference preview">×</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightboxItem.r2Url ?? lightboxItem.inputImage} alt={`${lightboxItem.name || `Reference ${lightboxIndex! + 1}`} preview`} />
        </div>,
        document.body,
      )}
    </div>
  );
}

function ImageOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" fill="white" stroke="none" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}
