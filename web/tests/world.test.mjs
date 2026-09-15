import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const record = { exports: {} };
const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/world-types.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("module", "exports", compiled)(record, record.exports);
const { normalizeWorldMessage, worldOrigin } = record.exports;

function message() {
  return {
    hdr: {
      t_ms: 100, step: 1000, x: 1.5, y: -2, heading: .5, energy: 1200, alive: true, generation: 0,
      life_ms: 100, spikes_total: 400, ate: 0, jumps: 0, hits: 0, food: [{ id: 1, x: 5, y: 6, energy: 60, energy0: 60, by: null }],
      predator: null, lamp: [96, 96], arena: 240, rates: { DNa02_left: 3.5, DNa02_right: 2 }, base: {},
      steer: 1.5, mode: "walk", orn: [4, 6], events: [[0, "born"]], wall: 1700000000, realtime: 1, nrender: 100,
    },
    spikes: Buffer.from([1, 0, 99, 0]).toString("base64"),
  };
}

test("accepts the server frame schema without inventing a path or behavior", () => {
  const parsed = normalizeWorldMessage(JSON.stringify(message()));
  assert.ok(parsed);
  assert.equal(parsed.frame.mode, "walk");
  assert.deepEqual(parsed.frame.orn, [4, 6]);
  assert.deepEqual(parsed.frame.events, [[0, "born"]]);
  assert.deepEqual(parsed.frame.path, []);
  assert.deepEqual([...parsed.spikes], [1, 99]);
});

test("rejects invalid JSON and missing or non-finite essential fields", () => {
  assert.equal(normalizeWorldMessage("{"), null);
  assert.equal(normalizeWorldMessage({ hdr: null, spikes: "" }), null);
  for (const invalid of [NaN, Infinity, -1, "100"]) {
    const data = message(); data.hdr.energy = invalid;
    assert.equal(normalizeWorldMessage(data), null);
  }
});

test("rejects malformed binary data and render indices outside the frame range", () => {
  for (const invalid of ["?", "A===", Buffer.from([1]).toString("base64"), Buffer.from([100, 0]).toString("base64")]) {
    const data = message(); data.spikes = invalid;
    assert.equal(normalizeWorldMessage(data), null);
  }
});

test("rejects malformed event and food records instead of passing them to the UI", () => {
  const event = message(); event.hdr.events = [[null, "event"]];
  assert.equal(normalizeWorldMessage(event), null);
  const food = message(); food.hdr.food[0].x = "5";
  assert.equal(normalizeWorldMessage(food), null);
  const rate = message(); rate.hdr.rates.DNa02_left = Infinity;
  assert.equal(normalizeWorldMessage(rate), null);
});

test("accepts a dead header where the server omits nrender", () => {
  const data = message(); data.hdr.alive = false; data.hdr.energy = 0; delete data.hdr.nrender;
  assert.ok(normalizeWorldMessage(data));
});

test("allows only credential-free web origins for stream discovery", () => {
  assert.equal(worldOrigin("https://example.com/snapshots/brain.npz"), "https://example.com");
  assert.equal(worldOrigin("http://localhost:8123/snapshots/brain.npz"), "http://localhost:8123");
  for (const invalid of ["javascript:alert(1)", "wss://example.com", "file:///secret", "https://user:password@example.com", "snapshots/brain.npz", ""]) assert.equal(worldOrigin(invalid), null);
});
