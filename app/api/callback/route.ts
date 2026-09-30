import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { callbackSecretConfigured, verifyCallbackSecret, verifyCallbackSignature } from "@/lib/localAuth";
import { callbackOutputUrls } from "@/lib/callbackPayload";

function settle(taskId: string, result: Parameters<typeof jobStore.set>[1]) {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
}

function callbackMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.slice(0, 2_000) : fallback;
}

export const maxDuration = 180;

const FAILURE_STATES = new Set(["fail", "failed", "error", "canceled", "cancelled", "expired", "timeout", "timed_out"]);

export async function POST(req: NextRequest) {
  const response = await handle(req);
  return response;
}


async function handle(req: NextRequest): Promise<NextResponse> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const headerSecret = req.headers.get("x-callback-token") ?? bearer;
  if (!callbackSecretConfigured()) {
    console.error("[callback] rejected because KIE_CALLBACK_SECRET is not configured");
    return NextResponse.json({ error: "Callback authentication is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const authorized = verifyCallbackSecret(headerSecret)
    || verifyCallbackSignature(req.nextUrl.searchParams.get("exp"), req.nextUrl.searchParams.get("sig"));
  if (!authorized) {
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
  const terminal = state === "success" || FAILURE_STATES.has(state) || (callbackBody.code !== undefined && callbackBody.code !== 200);
  if (terminal) {
    if (!jobStore.claim(taskId)) {
      console.warn("[callback] duplicate in-flight callback ignored:", taskId);
      return NextResponse.json({ received: true });
    }
  }
  return settleCallback(taskId, state, existingJob, data, callbackBody);
}

type Persisted = Parameters<typeof guestDb.updateGeneration>[1];

/** Writes the durable record. Returns false on failure so the caller can leave the job pending for a retry. */
async function persist(taskId: string, updates: Persisted): Promise<boolean> {
  if (GUEST_MODE) {
    try { guestDb.updateGeneration(taskId, updates); return true; }
    catch (error) { console.error("[callback] local update failed:", error instanceof Error ? error.message : error); return false; }
  }
  const { error } = await supabaseAdmin.from("generations").update(updates).eq("task_id", taskId);
  if (error) console.error("[callback] supabase update failed:", error.message);
  return !error;
}

/** Persist first, then publish. If persisting fails the job stays pending and Kie's retry can settle it. */
async function finish(taskId: string, result: Parameters<typeof jobStore.set>[1], updates: Persisted): Promise<NextResponse> {
  if (!(await persist(taskId, updates))) {
    const pending = jobStore.get(taskId);
    if (pending && pending.status === "pending") jobStore.set(taskId, { ...pending, claimedAt: undefined });
    return NextResponse.json({ error: "Could not save the result." }, { status: 503 });
  }
  settle(taskId, result);
  return NextResponse.json({ received: true });
}

async function settleCallback(
  taskId: string,
  state: string,
  existingJob: { status: "pending"; type?: "image" | "video"; userId?: string },
  data: { failMsg?: unknown; error?: unknown; resultJson?: unknown; videoUrl?: unknown; output?: unknown; [key: string]: unknown },
  callbackBody: { code?: unknown; msg?: string },
): Promise<NextResponse> {
  console.log("[callback] taskId:", taskId, "state:", state);

  const fail = (error: string) => finish(taskId, { status: "error", error }, { status: "error", error_msg: error });

  // A non-200 top-level code is a hard error (e.g. Veo 500 responses that carry
  // no state/status field but do carry body.code and body.msg).
  if (callbackBody.code !== undefined && callbackBody.code !== 200) {
    const error = callbackMessage(data.failMsg ?? callbackBody.msg, "Generation failed");
    console.log("[callback] top-level error code:", callbackBody.code, error);
    return fail(error);
  }

  if (state === "success") {
    const kieUrls = callbackOutputUrls(data);
    if (kieUrls.length === 0) {
      console.error("[callback] success without a valid HTTPS result URL, taskId:", taskId);
      return fail("Generation completed without a valid HTTPS result URL.");
    }
    const isVideo = existingJob.type === "video";
    const folder = isVideo ? "videos" : "images";
    let storedUrls: string[];
    try {
      storedUrls = await Promise.all(kieUrls.map((url) => mirrorToR2(url, folder, { publicOnly: true })));
    } catch (error) {
      console.error("[callback] storage upload failed:", error instanceof Error ? error.message : String(error));
      return fail("Generation completed, but the result could not be saved. Please try again.");
    }
    return isVideo
      ? finish(taskId, { status: "done", videoUrl: storedUrls[0] }, { status: "done", video_url: storedUrls[0] })
      : finish(taskId, { status: "done", imageUrl: storedUrls[0], imageUrls: storedUrls }, { status: "done", image_url: storedUrls[0], image_urls: storedUrls });
  }

  if (FAILURE_STATES.has(state)) {
    return fail(callbackMessage(data.failMsg ?? data.error ?? callbackBody.msg, "Generation failed"));
  }

  // Only terminal states take a claim, so there is nothing to release here.
  console.log("[callback] intermediate state, ignoring:", state);
  return NextResponse.json({ received: true });
}
