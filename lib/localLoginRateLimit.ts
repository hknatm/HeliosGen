interface AttemptState {
  failures: number;
  blockedUntil: number;
  lastSeen: number;
}

const attempts = new Map<string, AttemptState>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const BLOCK_MS = 15 * 60_000;

function keyFor(request: Request): string {
  // Only trust X-Real-IP when a reverse proxy explicitly opts in. Otherwise use
  // one global bucket, which is safest for a single-owner application.
  if (process.env.HELIOS_TRUST_PROXY === "true") {
    const ip = request.headers.get("x-real-ip")?.trim();
    if (ip && ip.length <= 64) return ip;
  }
  return "global";
}

function prune(now: number) {
  if (attempts.size < 1_000) return;
  for (const [key, state] of attempts) {
    if (now - state.lastSeen > WINDOW_MS + BLOCK_MS) attempts.delete(key);
  }
}

export function loginRateLimit(request: Request, now = Date.now()): { allowed: boolean; retryAfter: number } {
  prune(now);
  const state = attempts.get(keyFor(request));
  if (!state || state.blockedUntil <= now) return { allowed: true, retryAfter: 0 };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((state.blockedUntil - now) / 1_000)) };
}

export function recordLoginFailure(request: Request, now = Date.now()): number {
  const key = keyFor(request);
  const previous = attempts.get(key);
  const failures = !previous || now - previous.lastSeen > WINDOW_MS ? 1 : previous.failures + 1;
  const blockedUntil = failures >= MAX_FAILURES ? now + BLOCK_MS : 0;
  attempts.set(key, { failures, blockedUntil, lastSeen: now });
  return blockedUntil > now ? Math.ceil((blockedUntil - now) / 1_000) : 0;
}

export function clearLoginFailures(request: Request): void {
  attempts.delete(keyFor(request));
}

export function resetLoginRateLimitForTests(): void {
  attempts.clear();
}
