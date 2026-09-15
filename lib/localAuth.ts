import { createHmac, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

export const LOCAL_SESSION_COOKIE = "helios_owner_session";
export const LOCAL_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_VERSION = 1;
const PASSWORD_HASH_PREFIX = "scrypt";

interface LocalSessionPayload {
  sub: "owner";
  exp: number;
  v: number;
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function sessionSecret(): string | null {
  const value = process.env.HELIOS_SESSION_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

export function localAuthConfigured(): boolean {
  return !!process.env.HELIOS_ADMIN_PASSWORD_HASH?.trim() && !!sessionSecret();
}

export function createLocalSession(now = Date.now()): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("HELIOS_SESSION_SECRET must contain at least 32 characters.");
  const payload: LocalSessionPayload = {
    sub: "owner",
    exp: Math.floor(now / 1000) + LOCAL_SESSION_MAX_AGE_SECONDS,
    v: SESSION_VERSION,
  };
  const encoded = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyLocalSession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const secret = sessionSecret();
  if (!secret) return false;
  const [encoded, suppliedSignature, extra] = value.split(".");
  if (!encoded || !suppliedSignature || extra) return false;

  const expectedSignature = createHmac("sha256", secret).update(encoded).digest();
  let supplied: Buffer;
  try {
    supplied = decodeBase64Url(suppliedSignature);
  } catch {
    return false;
  }
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return false;

  try {
    const payload = JSON.parse(decodeBase64Url(encoded).toString("utf8")) as Partial<LocalSessionPayload>;
    return payload.sub === "owner" && payload.v === SESSION_VERSION &&
      typeof payload.exp === "number" && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

export async function verifyLocalPassword(password: string): Promise<boolean> {
  const stored = process.env.HELIOS_ADMIN_PASSWORD_HASH?.trim();
  if (!stored || typeof password !== "string" || password.length < 1 || password.length > 1024) return false;
  const parts = stored.split("$");
  if (parts[0] !== PASSWORD_HASH_PREFIX) return false;
  const modern = parts.length === 6;
  const saltValue = modern ? parts[4] : parts[1];
  const digestValue = modern ? parts[5] : parts[2];
  const N = modern ? Number(parts[1]) : 16_384;
  const r = modern ? Number(parts[2]) : 8;
  const p = modern ? Number(parts[3]) : 1;
  if (!saltValue || !digestValue || !Number.isInteger(N) || N < 16_384 || N > 65_536 || r !== 8 || p !== 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = decodeBase64Url(saltValue);
    expected = decodeBase64Url(digestValue);
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== 64) return false;
  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scryptCallback(password, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 }, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/gallery?tab=images";
  try {
    const parsed = new URL(value, "https://helios.invalid");
    if (parsed.origin !== "https://helios.invalid" || parsed.pathname === "/login" || parsed.pathname.startsWith("/login/") || parsed.pathname.startsWith("/api/auth/local-")) {
      return "/gallery?tab=images";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/gallery?tab=images";
  }
}

export function callbackSecretConfigured(): boolean {
  return (process.env.KIE_CALLBACK_SECRET?.trim().length ?? 0) >= 32;
}

export function verifyCallbackSecret(candidate: string | null): boolean {
  const expected = process.env.KIE_CALLBACK_SECRET?.trim();
  if (!expected || expected.length < 32 || !candidate) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function validatedCallbackBase(baseUrl: string): URL {
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "localhost" && parsedBase.hostname !== "127.0.0.1") {
    throw new Error("CALLBACK_BASE_URL must use HTTPS.");
  }
  if ((parsedBase.pathname !== "/" && parsedBase.pathname !== "") || parsedBase.search || parsedBase.hash) {
    throw new Error("CALLBACK_BASE_URL must contain only the public origin, without a path, query, or fragment.");
  }
  return parsedBase;
}

export function callbackUrl(baseUrl: string): string {
  const secret = process.env.KIE_CALLBACK_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("KIE_CALLBACK_SECRET must contain at least 32 characters.");
  const url = new URL("/api/callback", validatedCallbackBase(baseUrl));
  url.searchParams.set("token", secret);
  return url.toString();
}

const PROVIDER_ASSET_MAX_AGE_SECONDS = 24 * 60 * 60;

export function providerAssetUrl(path: string, baseUrl: string, now = Date.now()): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("HELIOS_SESSION_SECRET must contain at least 32 characters.");
  const url = new URL(path, validatedCallbackBase(baseUrl));
  if (!url.pathname.startsWith("/generated/")) throw new Error("Only generated assets can receive provider access tokens.");
  const expires = Math.floor(now / 1000) + PROVIDER_ASSET_MAX_AGE_SECONDS;
  const signature = createHmac("sha256", secret).update(`${url.pathname}\n${expires}`).digest("base64url");
  url.searchParams.set("provider_expires", String(expires));
  url.searchParams.set("provider_token", signature);
  return url.toString();
}

export function verifyProviderAssetAccess(path: string, expiresValue: string | null, token: string | null, now = Date.now()): boolean {
  const secret = sessionSecret();
  const expires = Number(expiresValue);
  if (!secret || !path.startsWith("/generated/") || !Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000) || !token) return false;
  const expected = createHmac("sha256", secret).update(`${path}\n${expires}`).digest();
  let supplied: Buffer;
  try {
    supplied = decodeBase64Url(token);
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
