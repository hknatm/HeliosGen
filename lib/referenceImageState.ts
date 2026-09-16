import type { ReferenceImageInput } from "./store";

function durableImageUrl(item: ReferenceImageInput | undefined): string | undefined {
  const url = item?.r2Url ?? item?.inputImage;
  return url && !url.startsWith("blob:") && !url.startsWith("data:") ? url : undefined;
}

/** Build the in-flight row without discarding an already-saved image. */
export function replacementDraft(
  existing: ReferenceImageInput | undefined,
  itemId: string,
  previewUrl: string,
  fallbackName: string,
): ReferenceImageInput {
  return {
    id: itemId,
    inputImage: previewUrl,
    r2Url: durableImageUrl(existing),
    name: existing?.name || fallbackName,
    usageNote: existing?.usageNote ?? "",
    presetId: existing?.presetId,
    status: "uploading",
    error: undefined,
  };
}

/** Restore the previous saved image when a replacement cannot be uploaded. */
export function replacementFailurePatch(
  existing: ReferenceImageInput | undefined,
  message: string,
): Partial<ReferenceImageInput> {
  const previousUrl = durableImageUrl(existing);
  return previousUrl
    ? { inputImage: previousUrl, r2Url: existing?.r2Url, status: "ready", error: `Replacement failed: ${message}` }
    : { inputImage: undefined, r2Url: undefined, status: "error", error: message };
}
