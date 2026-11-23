// Run with: node kettu/test.cjs
// Exercises the actual plugin expression with a mocked Kettu/Vendetta API.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const code = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
assert.equal(crypto.createHash("sha256").update(code).digest("hex"), manifest.hash);

const sent = [];
class WebSocket {
  constructor(url) { this.url = url; this.readyState = 1; }
  send(value) { sent.push({ socket: this, value }); }
  close(code) { this.readyState = 3; this.closedWith = code; }
}
const originalWebSocketSend = WebSocket.prototype.send;
const underlyingGatewayCalls = [];
const underlyingGatewaySend = function (...args) { underlyingGatewayCalls.push(args); };
const gateway = {
  send: underlyingGatewaySend,
  sessionId: "test-session",
  seq: 83,
  webSocket: new WebSocket("wss://gateway.discord.gg/?v=10"),
  close() { this.closed = true; }
};
const api = {
  plugin: { storage: {} },
  metro: {
    findByProps: (...keys) => keys.includes("getSocket") ? { getSocket: () => gateway, isConnected: () => true } : null,
    common: {}
  },
  logger: { log() {}, warn() {} }
};
const ctx = vm.createContext({
  vendetta: api,
  WebSocket,
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: f => f(),
  console
});
const result = vm.runInContext(code, ctx).default;
assert.equal(typeof result.onLoad, "function");
assert.equal(typeof result.settings, "function");
result.onLoad();
assert.equal(result.status().platform, "mobile");

// Framework gateway method, op=2. Preserve non-spoof fields.
const directData = { properties: { os: "Linux", browser: "Firefox", device: "Original", custom: "keep" } };
gateway.send(2, directData, false);
assert.equal(directData.properties.os, "Android");
assert.equal(directData.properties.browser, "Discord Android");
assert.equal(directData.properties.custom, "keep");
assert.equal(underlyingGatewayCalls[0][2], false);

// Raw WebSocket payload, only Discord gateway + IDENTIFY, no other frame.
const gwSocket = new WebSocket("wss://gateway.discord.gg/?v=10");
const unrelated = new WebSocket("wss://example.org/service");
const originalPacket = JSON.stringify({ op: 2, d: { properties: { browser: "original" }, token: "dummy" } });
gwSocket.send(originalPacket);
const modified = JSON.parse(sent.at(-1).value);
assert.equal(modified.d.properties.os, "Android");
assert.equal(modified.d.token, "dummy");
unrelated.send(originalPacket);
assert.equal(sent.at(-1).value, originalPacket);
gwSocket.send(JSON.stringify({ op: 1, d: 123 }));
assert.equal(JSON.parse(sent.at(-1).value).op, 1);

// Selection persists; can force non-RESUME reconnect when gateway API exposes sessionId.
result.setPlatform("desktop");
assert.equal(api.plugin.storage.platform, "desktop");
assert.equal(gateway.sessionId, null);
assert.equal(gateway.seq, 0);
assert.equal(gateway.webSocket.closedWith, 1000);
const desktopData = { properties: {} };
gateway.send(2, desktopData);
assert.equal(desktopData.properties.browser, "Discord Client");
result.setPlatform("off");
const offData = { properties: { browser: "Unmodified" } };
gateway.send(2, offData);
assert.equal(offData.properties.browser, "Unmodified");

// Disabling plugin must restore hooks.
result.onUnload();
assert.equal(gateway.send, underlyingGatewaySend);
assert.equal(WebSocket.prototype.send, originalWebSocketSend);
assert.equal(result.status().running, false);
console.log("OK: manifest hash, Kettu plugin lifecycle, platform selection, gateway IDENTIFY, raw WebSocket JSON, non-gateway isolation, cleanup");
