import type { NodeData } from "./store";

/** Remove browser-only previews before storing workflows and expose interrupted uploads as errors. */
export function persistedNodeData(data: NodeData): NodeData {
  const referenceImages = Array.isArray(data.referenceImages)
    ? data.referenceImages.map((item) => {
        const transient = !!item.inputImage && (item.inputImage.startsWith("blob:") || item.inputImage.startsWith("data:"));
        const interruptedNewUpload = transient && !item.r2Url;
        const interruptedReplacement = transient && !!item.r2Url;
        return {
          ...item,
          inputImage: item.r2Url || transient ? undefined : item.inputImage,
          ...(interruptedNewUpload ? { status: "error" as const, error: "Upload interrupted before completion. Add the image again." } : {}),
          ...(interruptedReplacement ? { status: "ready" as const, error: "Replacement was interrupted. The previous image was kept." } : {}),
        };
      })
    : undefined;
  const legacyInput = typeof data.inputImage === "string" && (data.inputImage.startsWith("blob:") || data.inputImage.startsWith("data:"))
    ? undefined
    : data.inputImage;
  return { ...data, inputImage: legacyInput, ...(referenceImages ? { referenceImages } : {}) };
}
