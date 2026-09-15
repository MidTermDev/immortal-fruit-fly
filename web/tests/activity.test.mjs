import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const externalRequire = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/hooks/useActivity.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const record = { exports: {} };
new Function("module", "exports", "require", compiled)(record, record.exports, (id) => id === "@/lib/chain" ? {} : externalRequire(id));
const { ActivityReader } = record.exports;

function event(source, block, index = 0, name = "Ticked", args = {}) {
  const tx = `0x${source}${block}`;
  return { source, block, index, name, args, tx, id: `${source}:${tx}:${index}` };
}

function harness() {
  let latest = 10000;
  const ranges = [];
  const timestampReads = [];
  const sourceEvents = { core: [], world: [], arcade: [] };
  const failing = new Set();
  const chain = {
    connectRead: async () => {},
    provider: {
      getBlockNumber: async () => latest,
      getBlock: async (block) => { timestampReads.push(block); return { timestamp: block * 3 }; },
    },
    readEvents: async (source, from, to) => {
      ranges.push({ source, from, to });
      if (failing.has(source)) throw new Error("Logs unavailable");
      return sourceEvents[source].filter((entry) => entry.block >= from && entry.block <= to);
    },
    invalidateRead: () => {},
    dispose: () => {},
  };
  return { reader: new ActivityReader(chain), chain, ranges, timestampReads, sourceEvents, failing, setLatest: (block) => { latest = block; } };
}

test("activity starts with one 2,000-block window per contract then advances incrementally", async () => {
  const h = harness();
  h.sourceEvents.core = [event("core", 9999, 1)];
  h.sourceEvents.world = [event("world", 9998, 2, "FoodPlaced")];
  h.sourceEvents.arcade = [event("arcade", 9999, 0, "Decision")];
  const first = await h.reader.read();
  assert.deepEqual(h.ranges, ["core", "world", "arcade"].map(source => ({ source, from: 8001, to: 10000 })));
  assert.deepEqual(first.events.map((entry) => entry.source), ["world", "arcade", "core"]);
  assert.equal(first.status, "ready");
  h.setLatest(10010);
  h.sourceEvents.core.push(event("core", 10010, 0));
  const second = await h.reader.read();
  assert.deepEqual(h.ranges.slice(3), ["core", "world", "arcade"].map(source => ({ source, from: 9989, to: 10010 })));
  assert.equal(second.events.length, 4);
  assert.equal(new Set(second.events.map((entry) => entry.id)).size, 4);
  assert.deepEqual(h.timestampReads, [9999, 9998, 10010]);
});

test("one denied source is partial, while all denied sources are unavailable", async () => {
  const partial = harness();
  partial.failing.add("world");
  partial.sourceEvents.core = [event("core", 9999)];
  assert.equal((await partial.reader.read()).status, "partial");
  const denied = harness();
  denied.failing.add("world");
  denied.failing.add("core");
  denied.failing.add("arcade");
  const result = await denied.reader.read();
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.events, []);
  assert.equal(result.toBlock, null);
});

test("temporary history failure retains known events and retries the failed cursor", async () => {
  const h = harness();
  h.sourceEvents.core = [event("core", 9999)];
  await h.reader.read();
  h.failing.add("core");
  h.setLatest(10010);
  const partial = await h.reader.read();
  assert.equal(partial.events.length, 1);
  assert.equal(partial.status, "partial");
  h.failing.delete("core");
  h.setLatest(10020);
  await h.reader.read();
  assert.equal(h.ranges.at(-3).from, 9989);
  assert.equal(h.ranges.at(-2).from, 9999);
  assert.equal(h.ranges.at(-1).from, 9999);
});

test("overlap replacement removes orphaned logs and exposes checkpoint metadata", async () => {
  const h = harness();
  h.sourceEvents.core = [event("core", 9999)];
  h.sourceEvents.world = [event("world", 10000, 0, "Checkpoint", { snapshotURI: "https://fly.example/snapshots/state.npz" })];
  const first = await h.reader.read();
  assert.equal(first.latestCheckpointURI, "https://fly.example/snapshots/state.npz");
  h.sourceEvents.core = [];
  const next = await h.reader.read();
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].source, "world");
});

test("concurrent refreshes share one read and timestamp work stays bounded", async () => {
  const h = harness();
  h.sourceEvents.core = Array.from({ length: 40 }, (_, i) => event("core", 9900 + i));
  const first = h.reader.read();
  const second = h.reader.read();
  assert.equal(first, second);
  const state = await first;
  assert.equal(h.ranges.length, 3);
  assert.equal(h.timestampReads.length, 24);
  assert.equal(state.status, "partial");
  assert.equal(state.events.filter((entry) => entry.timestamp === null).length, 16);
  const filled = await h.reader.read();
  assert.equal(filled.status, "ready");
  assert.equal(h.timestampReads.length, 40);
});
