import { NextRequest, NextResponse } from "next/server";
import { renderTextOverlay } from "@/lib/textRenderer";
import { uploadBuffer } from "@/lib/r2";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { supabaseAdmin } from "@/lib/supabase/admin";
import * as guestDb from "@/lib/guest/db";
import { normalizeTextRenderingSettings } from "@/lib/textRenderingSettings";
import { familyKeyFromFontUrl, fontFamilyKey, isAppOwnedFontUrl, isBuiltInFontFamily } from "@/lib/textFonts";
import { normalizeStyleComposition } from "@/lib/styleComposition";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FIELD_LENGTH = 500;
const MAX_BULLETS = 5;

function boundedText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_FIELD_LENGTH) : "";
}

function normalizeRenderContent(value: unknown): Parameters<typeof renderTextOverlay>[0]["content"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = value as Record<string, unknown>;
  return {
    eyebrow: boundedText(content.eyebrow),
    title: boundedText(content.title),
    subtitle: boundedText(content.subtitle),
    bullets: Array.isArray(content.bullets) ? content.bullets.slice(0, MAX_BULLETS).map(boundedText) : [],
    cta: boundedText(content.cta),
    fontFamily: boundedText(content.fontFamily).slice(0, 100) || "Arial",
    textColor: boundedText(content.textColor),
    accentColor: boundedText(content.accentColor),
    alignment: content.alignment === "center" || content.alignment === "right" ? content.alignment : "left",
  };
}

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.imageUrl !== "string") return NextResponse.json({ error: "An app-owned source image is required" }, { status: 400 });
    const content = normalizeRenderContent(body.content);
    if (!content) return NextResponse.json({ error: "Structured text content is required" }, { status: 400 });
    if (![content.eyebrow, content.title, content.subtitle, content.cta, ...content.bullets].some((field) => field.trim())) {
      return NextResponse.json({ error: "Text content must contain at least one non-empty field" }, { status: 400 });
    }
    const settings = normalizeTextRenderingSettings(body.settings);
    const composition = normalizeStyleComposition(body.composition);
    let fontUrl = typeof body.fontUrl === "string" && isAppOwnedFontUrl(body.fontUrl) ? body.fontUrl : undefined;
    // Only a newly uploaded font URL that embeds the selected family key may
    // define an @font-face. Built-in families always use the renderer's system
    // font, so a caller cannot smuggle another uploaded font in as “Arial”.
    const expectedFamilyKey = fontFamilyKey(content.fontFamily);
    const suppliedFamilyKey = typeof body.fontFamilyKey === "string" ? body.fontFamilyKey : undefined;
    if (
      !fontUrl ||
      isBuiltInFontFamily(content.fontFamily) ||
      !expectedFamilyKey ||
      suppliedFamilyKey !== expectedFamilyKey ||
      familyKeyFromFontUrl(fontUrl) !== expectedFamilyKey
    ) {
      fontUrl = undefined;
    }
    const { buffer, mime, truncatedLines } = await renderTextOverlay({
      imageUrl: body.imageUrl,
      content,
      composition,
      settings,
      fontUrl,
    });
    // A rendered asset belongs to this user even when its pixel data matches a
    // prior render, so never reuse a cached URL owned by somebody else.
    const imageUrl = await uploadBuffer(buffer, mime, "rendered", { deduplicate: false });
    // A rendered asset is a durable new image, not a mutation of its source.
    // Keep it visible in the existing gallery just like a user-uploaded asset.
    if (GUEST_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: imageUrl, mime_type: mime, source: "text_render" });
    } else {
      const { error } = await supabaseAdmin.from("user_uploads").insert({ user_id: userId, r2_url: imageUrl, mime_type: mime, source: "text_render" });
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ imageUrl, mime, truncatedLines });
  } catch (error: unknown) {
    // Keep operational filesystem/storage details in server logs, not API responses.
    console.error("Text render failed", error);
    const message = error instanceof Error && /^(Source asset|Unable to load stored asset|Source asset exceeds|Unable to read image dimensions)/.test(error.message)
      ? error.message
      : "Text render failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
