import { callbackUrl, createLocalSession, providerAssetUrl, safeNextPath, verifyCallbackSecret, verifyLocalPassword, verifyLocalSession, verifyProviderAssetAccess } from "../lib/localAuth";
import { clearLoginFailures, loginRateLimit, recordLoginFailure, resetLoginRateLimitForTests } from "../lib/localLoginRateLimit";

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) console.log("PASS:", message);
  else { console.error("FAIL:", message); failures++; }
}

async function main() {
  process.env.HELIOS_SESSION_SECRET = "session-secret-that-is-definitely-longer-than-thirty-two-chars";
  process.env.KIE_CALLBACK_SECRET = "callback-secret-that-is-definitely-longer-than-thirty-two-chars";
  process.env.HELIOS_ADMIN_PASSWORD_HASH = "scrypt$16384$8$1$92FDXsVdeyjFy2RmBETiUg$RzJ0mvF1Uz2OyU12I-5FPV87fUL2nQwu_55Dtf8eZDfKZKyoGQxUSGe2rJZP6SBth9g_G5JzlpJGuBm-Km246A";

  const now = 1_700_000_000_000;
  const token = createLocalSession(now);
  assert(verifyLocalSession(token, now + 1_000), "accepts a valid signed owner session");
  assert(!verifyLocalSession(`${token}x`, now + 1_000), "rejects a tampered owner session");
  assert(!verifyLocalSession(token, now + 13 * 60 * 60 * 1_000), "rejects an expired owner session");
  assert(safeNextPath("/workflow/abc?x=1") === "/workflow/abc?x=1", "preserves a safe same-origin next path");
  assert(safeNextPath("//evil.example") === "/gallery?tab=images", "rejects protocol-relative redirects");
  assert(safeNextPath("https://evil.example") === "/gallery?tab=images", "rejects absolute redirects");
  assert(safeNextPath("/login?next=/workflow") === "/gallery?tab=images", "prevents a login redirect loop");
  assert(safeNextPath("/login-help") === "/login-help", "does not reject unrelated paths sharing the login prefix");
  assert(verifyCallbackSecret(process.env.KIE_CALLBACK_SECRET), "accepts the configured callback secret");
  assert(!verifyCallbackSecret("wrong-secret"), "rejects an invalid callback secret");
  const url = callbackUrl("https://helios.example.com");
  assert(new URL(url).pathname === "/api/callback" && new URL(url).searchParams.get("token") === process.env.KIE_CALLBACK_SECRET, "builds the authenticated Kie callback URL");
  try {
    callbackUrl("https://helios.example.com/base");
    assert(false, "rejects a callback base containing a path");
  } catch {
    assert(true, "rejects a callback base containing a path");
  }
  try {
    callbackUrl("http://helios.example.com");
    assert(false, "rejects a non-HTTPS public callback base");
  } catch {
    assert(true, "rejects a non-HTTPS public callback base");
  }
  const assetUrl = new URL(providerAssetUrl("/generated/references/example.png", "https://helios.example.com", now));
  assert(verifyProviderAssetAccess(assetUrl.pathname, assetUrl.searchParams.get("provider_expires"), assetUrl.searchParams.get("provider_token"), now + 1_000), "accepts signed provider access to a generated asset");
  assert(!verifyProviderAssetAccess(assetUrl.pathname, assetUrl.searchParams.get("provider_expires"), `${assetUrl.searchParams.get("provider_token")}x`, now + 1_000), "rejects a tampered provider asset token");
  assert(!verifyProviderAssetAccess(assetUrl.pathname, assetUrl.searchParams.get("provider_expires"), assetUrl.searchParams.get("provider_token"), now + 25 * 60 * 60_000), "rejects an expired provider asset token");
  assert(await verifyLocalPassword("correct horse battery staple") === true, "accepts the configured scrypt password hash");
  assert(await verifyLocalPassword("wrong password") === false, "rejects an incorrect password");

  const rateRequest = new Request("https://helios.example.com/api/auth/local-login");
  resetLoginRateLimitForTests();
  for (let attempt = 0; attempt < 4; attempt++) assert(recordLoginFailure(rateRequest, now) === 0, `login failure ${attempt + 1} remains below the limit`);
  assert(loginRateLimit(rateRequest, now).allowed, "four failures do not block login");
  assert(recordLoginFailure(rateRequest, now) === 900, "the fifth failure starts a 15-minute cooldown");
  assert(!loginRateLimit(rateRequest, now + 1_000).allowed, "rate limiter blocks during the cooldown");
  assert(loginRateLimit(rateRequest, now + 16 * 60_000).allowed, "rate limiter allows login after the cooldown");
  clearLoginFailures(rateRequest);
  assert(loginRateLimit(rateRequest, now).allowed, "successful login clears prior failures");

  if (failures) process.exit(1);
  console.log("\nAll local auth tests passed.");
}

void main();
