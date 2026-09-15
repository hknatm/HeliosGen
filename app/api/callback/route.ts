import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { callbackSecretConfigured, verifyCallbackSecret } from "@/lib/localAuth";
import { IS_LOCAL_MODE } from "@/lib/runtimeConfig";

function extractUrls(resultJson?: string): string[] {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson);
    const urls = parsed.resultUrls ?? parsed.resultUrl;
    if (Array.isArray(urls)) return urls.filter(Boolean);
    if (urls) return [urls];
    return [];
  } catch {
    return [];
  }
}

function settle(taskId: string, result: Parameters<typeof jobStore.set>[1]) {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
}

function callbackMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.slice(0, 2_000) : fallback;
}

function callbackOutputUrls(data: { resultJson?: unknown; videoUrl?: unknown; output?: unknown }): string[] {
  const urls = extractUrls(typeof data.resultJson === "string" ? data.resultJson : undefined);
  if (urls.length === 0 && typeof data.videoUrl === "string") urls.push(data.videoUrl);
  if (urls.length === 0) {
    if (typeof data.output === "string") urls.push(data.output);
    else if (Array.isArray(data.output)) urls.push(...data.output.filter((value): value is string => typeof value === "string"));
  }
  return urls.filter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
}

export async function POST(req: NextRequest) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const callbackSecret = req.headers.get("x-callback-token") ?? bearer ?? req.nextUrl.searchParams.get("token");
  if (IS_LOCAL_MODE && !callbackSecretConfigured()) {
    console.error("[callback] rejected because KIE_CALLBACK_SECRET is not configured");
    return NextResponse.json({ error: "Callback authentication is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (IS_LOCAL_MODE && !verifyCallbackSecret(callbackSecret)) {
    console.warn("[callback] rejected invalid callback credentials");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  let bodyValue: unknown;
  try {
    bodyValue = await req.json();
  } catch {
    console.warn("[callback] rejected invalid JSON payload");
    return NextResponse.json({ error: "Invalid callback payload" }, { status: 400 });
  }
  if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
    console.warn("[callback] rejected non-object payload");
    return NextResponse.json({ error: "Invalid callback payload" }, { status: 400 });
  }
  const body = bodyValue as Record<string, unknown>;
  const dataRecord = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : body;
  const data = dataRecord as {
    taskId?: unknown; id?: unknown; state?: unknown; status?: unknown;
    failMsg?: unknown; error?: unknown; resultJson?: unknown; videoUrl?: unknown;
    output?: unknown;
  };
  const callbackBody = body as { taskId?: unknown; id?: unknown; code?: unknown; msg?: string };
  const taskIdValue = data.taskId ?? data.id ?? callbackBody.taskId ?? callbackBody.id;
  const taskId = typeof taskIdValue === "string" ? taskIdValue : "";
  const state = String(data.state ?? data.status ?? "").toLowerCase();

  if (!taskId) {
    console.warn("[callback] rejected payload without a taskId");
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  }
  const existingJob = jobStore.get(taskId);
  if (IS_LOCAL_MODE && (!existingJob || existingJob.status !== "pending")) {
    console.warn("[callback] rejected unknown or settled task:", taskId);
    return NextResponse.json({ error: "Unknown or settled task" }, { status: 404 });
  }
  console.log("[callback] taskId:", taskId, "state:", state);

  // Treat a non-200 top-level code as a hard error (e.g. Veo 500 responses that
  // carry no state/status field but do carry body.code and body.msg).
  if (callbackBody.code !== undefined && callbackBody.code !== 200) {
    const error = callbackMessage(data.failMsg ?? callbackBody.msg, "Generation failed");
    console.log("[callback] top-level error code:", callbackBody.code, error);
    settle(taskId, { status: "error", error });
    if (GUEST_MODE) {
      guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
    } else {
      supabaseAdmin
        .from("generations")
        .update({ status: "error", error_msg: error })
        .eq("task_id", taskId)
        .then(({ error: e }) => {
          if (e) console.error("[callback] supabase error update failed:", e.message);
        });
    }
    return NextResponse.json({ received: true });
  }

  if (state === "success") {
    const kieUrls = callbackOutputUrls(data);
    if (kieUrls.length > 0) {
      const existing = jobStore.get(taskId);
      const isVideo = existing?.status === "pending" && existing.type === "video";
      const folder = isVideo ? "videos" : "images";

      Promise.all(kieUrls.map((u) => mirrorToR2(u, folder)))
        .then((storedUrls) => {
          if (isVideo) {
            const result = { status: "done" as const, videoUrl: storedUrls[0] };
            settle(taskId, result);
            if (GUEST_MODE) {
              guestDb.updateGeneration(taskId, { status: "done", video_url: storedUrls[0] });
            } else {
              return supabaseAdmin.from("generations").update({ status: "done", video_url: storedUrls[0] }).eq("task_id", taskId);
            }
          } else {
            const result = { status: "done" as const, imageUrl: storedUrls[0], imageUrls: storedUrls };
            settle(taskId, result);
            if (GUEST_MODE) {
              guestDb.updateGeneration(taskId, { status: "done", image_url: storedUrls[0], image_urls: storedUrls });
            } else {
              return supabaseAdmin.from("generations").update({ status: "done", image_url: storedUrls[0], image_urls: storedUrls }).eq("task_id", taskId);
            }
          }
        })
        .then((supabaseResult: { error: { message: string } | null } | undefined) => {
          if (supabaseResult?.error) console.error("[callback] supabase update error:", supabaseResult.error.message);
        })
        .catch((err) => {
          console.error("[callback] storage upload failed, using source URLs:", err.message);
          if (isVideo) {
            const result = { status: "done" as const, videoUrl: kieUrls[0] };
            settle(taskId, result);
            if (GUEST_MODE) {
              guestDb.updateGeneration(taskId, { status: "done", video_url: kieUrls[0] });
            } else {
              supabaseAdmin.from("generations").update({ status: "done", video_url: kieUrls[0] }).eq("task_id", taskId).then(() => {});
            }
          } else {
            const result = { status: "done" as const, imageUrl: kieUrls[0], imageUrls: kieUrls };
            settle(taskId, result);
            if (GUEST_MODE) {
              guestDb.updateGeneration(taskId, { status: "done", image_url: kieUrls[0], image_urls: kieUrls });
            } else {
              supabaseAdmin.from("generations").update({ status: "done", image_url: kieUrls[0], image_urls: kieUrls }).eq("task_id", taskId).then(() => {});
            }
          }
        });
    } else {
      const error = "Generation completed without a valid HTTPS result URL.";
      console.error("[callback]", error, "taskId:", taskId);
      settle(taskId, { status: "error", error });
      if (GUEST_MODE) {
        guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
      } else {
        await supabaseAdmin.from("generations").update({ status: "error", error_msg: error }).eq("task_id", taskId);
      }
    }
  } else if (state === "fail" || state === "failed" || state === "error") {
    const error = callbackMessage(data.failMsg ?? data.error ?? callbackBody.msg, "Generation failed");
    settle(taskId, { status: "error", error });

    if (GUEST_MODE) {
      guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
    } else {
      supabaseAdmin
        .from("generations")
        .update({ status: "error", error_msg: error })
        .eq("task_id", taskId)
        .then(({ error: e }) => {
          if (e) console.error("[callback] supabase error update failed:", e.message);
        });
    }
  } else {
    console.log("[callback] intermediate state, ignoring:", state);
  }

  return NextResponse.json({ received: true });
}
