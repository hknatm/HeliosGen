import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { callbackSecretConfigured, verifyCallbackSecret } from "@/lib/localAuth";
import { callbackOutputUrls } from "@/lib/callbackPayload";

function settle(taskId: string, result: Parameters<typeof jobStore.set>[1]) {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
}

function callbackMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.slice(0, 2_000) : fallback;
}

export const maxDuration = 180;

export async function POST(req: NextRequest) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const callbackSecret = req.headers.get("x-callback-token") ?? bearer ?? req.nextUrl.searchParams.get("token");
  if (!callbackSecretConfigured()) {
    console.error("[callback] rejected because KIE_CALLBACK_SECRET is not configured");
    return NextResponse.json({ error: "Callback authentication is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!verifyCallbackSecret(callbackSecret)) {
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
  let existingJob = jobStore.get(taskId);
  if ((!existingJob || existingJob.status !== "pending") && !GUEST_MODE) {
    const { data: generation, error: lookupError } = await supabaseAdmin
      .from("generations")
      .select("status, generation_type, user_id")
      .eq("task_id", taskId)
      .single();
    if (lookupError) {
      console.error("[callback] pending job lookup failed:", lookupError.message);
      return NextResponse.json({ error: "Could not verify callback job." }, { status: 503 });
    }
    if (generation?.status === "pending") {
      existingJob = {
        status: "pending",
        type: generation.generation_type === "video" ? "video" : "image",
        userId: generation.user_id ?? undefined,
      };
      jobStore.set(taskId, existingJob);
    }
  }
  if (!existingJob || existingJob.status !== "pending") {
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
      const { error: updateError } = await supabaseAdmin
        .from("generations")
        .update({ status: "error", error_msg: error })
        .eq("task_id", taskId);
      if (updateError) console.error("[callback] supabase error update failed:", updateError.message);
    }
    return NextResponse.json({ received: true });
  }

  if (state === "success") {
    const kieUrls = callbackOutputUrls(data);
    if (kieUrls.length > 0) {
      const isVideo = existingJob.type === "video";
      const folder = isVideo ? "videos" : "images";
      let storedUrls: string[];
      try {
        storedUrls = await Promise.all(kieUrls.map((url) => mirrorToR2(url, folder)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const displayError = "Generation completed, but the result could not be saved. Please try again.";
        console.error("[callback] storage upload failed:", message);
        settle(taskId, { status: "error", error: displayError });
        if (GUEST_MODE) {
          guestDb.updateGeneration(taskId, { status: "error", error_msg: displayError });
        } else {
          const { error: updateError } = await supabaseAdmin
            .from("generations")
            .update({ status: "error", error_msg: displayError })
            .eq("task_id", taskId);
          if (updateError) console.error("[callback] supabase error update failed:", updateError.message);
        }
        return NextResponse.json({ received: true });
      }

      if (isVideo) {
        settle(taskId, { status: "done", videoUrl: storedUrls[0] });
        if (GUEST_MODE) {
          guestDb.updateGeneration(taskId, { status: "done", video_url: storedUrls[0] });
        } else {
          const { error: updateError } = await supabaseAdmin
            .from("generations")
            .update({ status: "done", video_url: storedUrls[0] })
            .eq("task_id", taskId);
          if (updateError) console.error("[callback] supabase update error:", updateError.message);
        }
      } else {
        settle(taskId, { status: "done", imageUrl: storedUrls[0], imageUrls: storedUrls });
        if (GUEST_MODE) {
          guestDb.updateGeneration(taskId, { status: "done", image_url: storedUrls[0], image_urls: storedUrls });
        } else {
          const { error: updateError } = await supabaseAdmin
            .from("generations")
            .update({ status: "done", image_url: storedUrls[0], image_urls: storedUrls })
            .eq("task_id", taskId);
          if (updateError) console.error("[callback] supabase update error:", updateError.message);
        }
      }
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
      const { error: updateError } = await supabaseAdmin
        .from("generations")
        .update({ status: "error", error_msg: error })
        .eq("task_id", taskId);
      if (updateError) console.error("[callback] supabase error update failed:", updateError.message);
    }
  } else {
    console.log("[callback] intermediate state, ignoring:", state);
  }

  return NextResponse.json({ received: true });
}
