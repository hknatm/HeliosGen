export function normalizeAssetSrc(url: string, localMode: boolean): string {
  if (!url || url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("/generated/")) return url;

  // Only local deployments own `/generated/*` on the current origin. In cloud
  // mode CDN assets can legitimately use that path, and rewriting them to a
  // relative URL makes previews request a nonexistent file from the app origin.
  if (!localMode) return url;

  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith("/generated/")
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : url;
  } catch {
    return url;
  }
}
