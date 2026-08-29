import { createClient } from "@/lib/supabase/client";

export interface GalleryItem {
  id: string;
  url: string;
  imageUrls?: string[];
  mediaType: "image" | "video";
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  quality?: string;
  azure_resolution?: string;
  source: "generation" | "upload";
  created_at: string;
  referenceImageUrls?: string[];
}

const THUMB_WIDTHS = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];

/**
 * Returns a browser-safe thumbnail URL.
 *
 * Only our R2 assets use the server-side thumbnail route. Every other image is
 * loaded by the browser directly: that supports localhost, ngrok, custom
 * domains, signed provider URLs, and future storage hosts without making the
 * image optimizer an allow-list bottleneck.
 */
export function thumbSrc(url: string, w = 96): string {
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return url;

  if (url.includes(".r2.dev/")) {
    const target = w * 2;
    const snapped = THUMB_WIDTHS.find((size) => size >= target) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
    return `/api/thumb?url=${encodeURIComponent(url)}&w=${snapped}`;
  }

  return url;
}

export async function getToken(): Promise<string | undefined> {
  if (process.env.NEXT_PUBLIC_GUEST_MODE === "true") return "guest";
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token;
}

const _galleryCacheMem = new Map<string, { items: GalleryItem[]; hasMore: boolean }>();

export const galleryCache = {
  get(tab: string): { items: GalleryItem[]; hasMore: boolean } | undefined {
    const mem = _galleryCacheMem.get(tab);
    if (mem) return mem;
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(`nf-gallery-cache-${tab}`) : null;
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { items: GalleryItem[]; hasMore: boolean };
      _galleryCacheMem.set(tab, parsed);
      return parsed;
    } catch { return undefined; }
  },
  set(tab: string, data: { items: GalleryItem[]; hasMore: boolean }) {
    _galleryCacheMem.set(tab, data);
    try {
      if (typeof window !== "undefined") localStorage.setItem(`nf-gallery-cache-${tab}`, JSON.stringify(data));
    } catch { }
  },
};
