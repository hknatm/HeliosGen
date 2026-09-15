import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error("Usage: pnpm local-auth:hash '<password-at-least-12-characters>'");
  process.exit(1);
}

const salt = randomBytes(16);
const N = 65_536;
const r = 8;
const p = 1;
const digest = scryptSync(password, salt, 64, { N, r, p, maxmem: 128 * 1024 * 1024 });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${digest.toString("base64url")}`);
