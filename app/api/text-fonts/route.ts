import { extname } from "path";
import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { supabaseAdmin } from "@/lib/supabase/admin";
import * as guestDb from "@/lib/guest/db";
import { fontFamilyKey, isBuiltInFontFamily } from "@/lib/textFonts";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, { mime: string; format: "ttf" | "otf" | "woff" | "woff2" }> = {
  ".ttf": { mime: "font/ttf", format: "ttf" },
  ".otf": { mime: "font/otf", format: "otf" },
  ".woff": { mime: "font/woff", format: "woff" },
  ".woff2": { mime: "font/woff2", format: "woff2" },
};

function familyFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return (base || "Uploaded font").slice(0, 100);
}

function hasExpectedFontSignature(bytes: Buffer, format: "ttf" | "otf" | "woff" | "woff2"): boolean {
  const header = bytes.subarray(0, 4).toString("ascii");
  if (format === "woff") return header === "wOFF";
  if (format === "woff2") return header === "wOF2";
  if (format === "otf") return header === "OTTO";
  return header === "\u0000\u0001\u0000\u0000" || header === "true";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const rawFile = form.get("font");
    if (!(rawFile instanceof File)) return NextResponse.json({ error: "Choose a font file to upload" }, { status: 400 });

    const extension = extname(rawFile.name).toLowerCase();
    const type = MIME_BY_EXTENSION[extension];
    if (!type) return NextResponse.json({ error: "Use a .ttf, .otf, .woff, or .woff2 font file" }, { status: 415 });
    if (rawFile.size <= 0 || rawFile.size > MAX_BYTES) return NextResponse.json({ error: "Font files must be between 1 byte and 10 MB" }, { status: 413 });

    const userId = await resolveUserId(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const bytes = Buffer.from(await rawFile.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: "Font file exceeds 10 MB" }, { status: 413 });
    if (!hasExpectedFontSignature(bytes, type.format)) return NextResponse.json({ error: "The selected file is not a valid font of the declared type" }, { status: 415 });

    const fontId = crypto.randomUUID();
    const family = familyFromFilename(rawFile.name);
    const familyKey = fontFamilyKey(family);
    if (!familyKey) return NextResponse.json({ error: "The font filename must contain at least one letter or number" }, { status: 400 });
    if (isBuiltInFontFamily(family)) return NextResponse.json({ error: `${family} is built in; rename the font file before uploading it` }, { status: 400 });
    // Fonts are bound to their selected family by their private storage path;
    // never deduplicate across users, or an existing public URL could be reused.
    const url = await uploadBuffer(bytes, type.mime, `fonts/${familyKey}`, { deduplicate: false });

    // Record it as an upload for durable ownership/audit. Font metadata itself is
    // browser/server-settings state, keeping the existing no-migration model.
    if (GUEST_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: url, mime_type: type.mime, source: "text_font" });
    } else {
      const { error } = await supabaseAdmin.from("user_uploads").insert({ user_id: userId, r2_url: url, mime_type: type.mime, source: "text_font" });
      if (error) throw new Error(error.message);
    }

    return NextResponse.json({
      font: {
        id: fontId,
        family,
        familyKey,
        url,
        format: type.format,
        source: "uploaded",
        createdAt: Date.now(),
      },
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Font upload failed" }, { status: 500 });
  }
}
