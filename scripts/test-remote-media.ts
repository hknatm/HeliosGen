import assert from "node:assert/strict";
import http from "node:http";
import { fetchRemoteMedia, isNonPublicAddress } from "../lib/remoteMedia";

for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "not-an-ip"]) {
  assert.equal(isNonPublicAddress(bad), true, `${bad} must be blocked`);
}
for (const ok of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
  assert.equal(isNonPublicAddress(ok), false, `${ok} must be allowed`);
}

async function main() {
  const server = http.createServer((_req, res) => { res.end("secret"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // Default behaviour is unchanged for internal callers.
  const ok = await fetchRemoteMedia(`http://127.0.0.1:${port}/`);
  assert.equal(ok.buffer.toString(), "secret");
  // Public-only mode rejects loopback, plain HTTP and credentials.
  await assert.rejects(fetchRemoteMedia(`http://127.0.0.1:${port}/`, { publicOnly: true }), /public HTTPS/);
  await assert.rejects(fetchRemoteMedia("https://127.0.0.1/x", { publicOnly: true }), /public HTTPS/);
  await assert.rejects(fetchRemoteMedia("https://user:pw@example.com/x", { publicOnly: true }), /public HTTPS/);
  await assert.rejects(fetchRemoteMedia("https://localhost/x", { publicOnly: true, totalTimeoutMs: 5000 }), /public address|EACCES/);
  server.close();
  console.log("remote media ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
