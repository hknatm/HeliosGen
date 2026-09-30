import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type JobResult =
  | { status: "pending"; type?: "image" | "video"; userId?: string; claimedAt?: number }
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string }
  | { status: "error"; error: string };

const FILE = join(process.cwd(), ".job-store.json");

function read(): Record<string, JobResult> {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return {}; }
}

function write(data: Record<string, JobResult>): void {
  writeFileSync(FILE, JSON.stringify(data), "utf8");
}

export const jobStore = {
  get(taskId: string): JobResult | undefined {
    return read()[taskId];
  },
  set(taskId: string, result: JobResult): void {
    const data = read();
    data[taskId] = result;
    write(data);
  },
  /**
   * Claims a pending job for settlement. Returns false when it is not pending or another
   * settler holds a fresh claim. The read-modify-write is synchronous, so it is atomic within
   * a process and shared across processes through the job file. A claim expires after ttlMs.
   */
  claim(taskId: string, ttlMs = 3 * 60_000): boolean {
    const data = read();
    const job = data[taskId];
    if (!job || job.status !== "pending") return false;
    if (job.claimedAt && Date.now() - job.claimedAt < ttlMs) return false;
    data[taskId] = { ...job, claimedAt: Date.now() };
    write(data);
    return true;
  },
};
