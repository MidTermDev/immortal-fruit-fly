import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import ts from "typescript";

const externalRequire = createRequire(import.meta.url);
function load(filename) {
  const record = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = (id) => id.startsWith(".") ? load(path.resolve(path.dirname(filename), `${id}.ts`)) : externalRequire(id);
  new Function("module", "exports", "require", compiled)(record, record.exports, localRequire);
  return record.exports;
}
const { ArcadeReader, ARCADE_ABI, decodeArcadeDecision } = load(fileURLToPath(new URL("../src/lib/arcade.ts", import.meta.url)));
const abi = new Interface(ARCADE_ABI);
const HASH = `0x${"a".repeat(64)}`;

function decision({ session = 0n, n = 1, block = 150, index = 0, tx = toBeHex(n, 32), brainStep = 9007199254740993n, turn = -17, fire = true } = {}) {
  const encoded = abi.encodeEventLog(abi.getEvent("Decision"), [session, n, HASH, brainStep, turn, fire, 4294967295, 3, 87, 42]);
  return { ...encoded, blockNumber: block, index, transactionHash: tx, blockHash: toBeHex(block, 32) };
}

function fixture({ count = 1n, start = 100n, end = 150n, reported = 1, logs = [decision()], head = 10000 } = {}) {
  const calls = { logs: [], sessions: [], blocks: [], count: 0, invalidations: 0, disposed: 0 };
  const data = { count, start, end, reported, logs, head, failRanges: () => false, failSession: () => false, failCount: false, failTimes: false };
  const provider = {
    getBlockNumber: async () => data.head,
    call: async (transaction) => {
      const request = abi.parseTransaction({ data: transaction.data });
      if (request.name === "sessionCount") {
        calls.count++;
        if (data.failCount) throw new Error("RPC unavailable");
        return abi.encodeFunctionResult("sessionCount", [data.count]);
      }
      assert.equal(request.name, "sessions");
      const id = request.args[0]; calls.sessions.push({ id, blockTag: transaction.blockTag });
      if (data.failSession(id)) throw new Error("Session unavailable");
      return abi.encodeFunctionResult("sessions", [`DOOM · ${id}`, data.start, data.end, data.reported, 3, HASH]);
    },
    getLogs: async (filter) => {
      calls.logs.push(filter);
      assert.ok(filter.toBlock - filter.fromBlock < 2000);
      if (data.failRanges(filter)) throw new Error("Archive access unavailable");
      return data.logs.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock && log.topics[1] === filter.topics[1]);
    },
    getBlock: async (block) => {
      calls.blocks.push(block);
      if (data.failTimes) throw new Error("Block time unavailable");
      return { timestamp: block * 2, hash: toBeHex(block, 32) };
    },
  };
  const chain = { provider, connectRead: async () => { chain.provider = provider; return chain; }, invalidateRead: () => { calls.invalidations++; chain.provider = null; }, dispose: () => { calls.disposed++; } };
  return { reader: new ArcadeReader(chain), calls, data, provider };
}

test("ABI decoding preserves uint64 brain steps and signed decision values", () => {
  const decoded = decodeArcadeDecision(decision());
  assert.equal(decoded.brainStep, 9007199254740993n);
  assert.equal(decoded.turn, -17);
  assert.equal(decoded.fire, true);
  assert.equal(decoded.spikes, 4294967295);
  assert.equal(decoded.session, 0n);
});

test("a historical completed session reads its own block span, not the latest activity window", async () => {
  const { reader, calls } = fixture();
  const state = await reader.read();
  assert.equal(state.status, "ready");
  assert.equal(state.fromBlock, 100);
  assert.equal(state.toBlock, 150);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].timestamp, 300);
  assert.equal(state.selectedSession.startedAt, 200);
  assert.deepEqual(calls.logs.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [[100, 150]]);
  await reader.read();
  assert.equal(calls.logs.length, 1, "complete ended sessions reuse their log cache");
});

test("session listing is bounded and preserves very large uint256 IDs", async () => {
  const count = 1000000000000000000000000000000n;
  const { reader, calls } = fixture({ count, reported: 0, logs: [] });
  const state = await reader.read();
  assert.equal(state.totalSessions, count);
  assert.equal(state.sessions.length, 12);
  assert.equal(state.selectedSessionId, count - 1n);
  assert.equal(calls.sessions.length, 12);
  assert.equal(calls.sessions[0].id, count - 1n);
});

test("an explicitly selected old ID is fetched outside the latest session menu", async () => {
  const { reader, calls } = fixture({ count: 40n, logs: [decision({ session: 2n })] });
  const state = await reader.read(2n);
  assert.equal(state.selectedSession.id, 2n);
  assert.equal(state.sessions.length, 12);
  assert.equal(state.decisions[0].session, 2n);
  assert.equal(calls.sessions.length, 13);
  assert.ok(calls.sessions.some(({ id }) => id === 2n));
});

test("failed chunks preserve successful decisions, mark partial and rotate the provider", async () => {
  const { reader, calls, data } = fixture({ end: 2200n, reported: 2, logs: [decision({ block: 150 }), decision({ block: 2200, n: 2 })] });
  data.failRanges = ({ fromBlock }) => fromBlock === 100;
  const state = await reader.read();
  assert.equal(state.status, "partial");
  assert.equal(state.decisionStatus, "partial");
  assert.deepEqual(state.decisions.map(({ n }) => n), [2]);
  assert.equal(calls.invalidations, 1);
  data.failRanges = () => false;
  const retried = await reader.read();
  assert.deepEqual(retried.decisions.map(({ n }) => n), [1, 2]);
  assert.equal(retried.status, "ready");
});

test("failed metadata reads keep the last selected decision records", async () => {
  const { reader, data } = fixture();
  const initial = await reader.read();
  data.failCount = true;
  const failed = await reader.read();
  assert.equal(failed.status, "partial");
  assert.deepEqual(failed.decisions, initial.decisions);
  assert.deepEqual(failed.selectedSession, initial.selectedSession);
});

test("failed session detail reads preserve cached session and decisions", async () => {
  const { reader, data } = fixture();
  const initial = await reader.read(0n);
  data.failSession = () => true;
  const failed = await reader.read(0n);
  assert.equal(failed.sessionStatus, "partial");
  assert.equal(failed.selectedSession.id, 0n);
  assert.deepEqual(failed.decisions, initial.decisions);
});

test("an end record does not make a session complete when decision counts disagree", async () => {
  const { reader, calls } = fixture({ reported: 2, head: 200 });
  const initial = await reader.read();
  assert.equal(initial.decisionStatus, "partial");
  assert.match(initial.error, /do not cover every recorded decision/);
  const firstReads = calls.logs.length;
  await reader.read();
  assert.ok(calls.logs.length > firstReads, "incomplete ended sessions must retry their log range");
});

test("decisions submitted after an end record remain discoverable", async () => {
  const { reader } = fixture({ head: 200, reported: 2, logs: [decision(), decision({ block: 160, n: 2 })] });
  const state = await reader.read();
  assert.equal(state.decisionStatus, "ready");
  assert.equal(state.toBlock, 200);
  assert.deepEqual(state.decisions.map(({ n }) => n), [1, 2]);
});

test("older decision windows remain available and can return to the latest window", async () => {
  const { reader } = fixture({ end: 0n, reported: 2, logs: [decision(), decision({ block: 9500, n: 2 })] });
  const latest = await reader.read(0n);
  assert.deepEqual(latest.decisions.map(({ n }) => n), [2]);
  assert.deepEqual(latest.olderCursor, { block: 2000 });
  const earlier = await reader.read(0n, latest.olderCursor);
  assert.equal(earlier.fromBlock, 100);
  assert.equal(earlier.toBlock, 2000);
  assert.equal(earlier.isLatest, false);
  assert.deepEqual(earlier.decisions.map(({ n }) => n), [1]);
  assert.equal(earlier.olderCursor, null);
  const restored = await reader.read(0n);
  assert.equal(restored.isLatest, true);
  assert.deepEqual(restored.decisions.map(({ n }) => n), [2]);
});

test("row-limit pagination preserves every decision in a crowded block without overlap", async () => {
  const logs = Array.from({ length: 300 }, (_, index) => decision({ n: index + 1, index }));
  const { reader } = fixture({ head: 200, reported: 300, logs });
  const latest = await reader.read(0n);
  assert.equal(latest.decisions.length, 250);
  assert.deepEqual(latest.olderCursor, { block: 150, beforeIndex: 50 });
  const earlier = await reader.read(0n, latest.olderCursor);
  assert.equal(earlier.decisions.length, 50);
  assert.equal(earlier.olderCursor, null);
  const combined = [...earlier.decisions, ...latest.decisions];
  assert.equal(new Set(combined.map(({ id }) => id)).size, 300);
  assert.deepEqual(combined.map(({ n }) => n), Array.from({ length: 300 }, (_, index) => index + 1));
});

test("a denied log request never looks like a successful empty decision history", async () => {
  const { reader, data } = fixture();
  data.failRanges = () => true;
  const state = await reader.read();
  assert.equal(state.decisionStatus, "unavailable");
  assert.equal(state.selectedSession.decisions, 1);
  assert.deepEqual(state.decisions, []);
  assert.match(state.error, /Decision logs are unavailable/);
});

test("long sessions stay inside four capped log chunks and report omitted history", async () => {
  const { reader, calls } = fixture({ start: 1n, end: 10000n, logs: [decision({ block: 10000 })] });
  const state = await reader.read();
  assert.equal(calls.logs.length, 4);
  assert.equal(state.fromBlock, 2001);
  assert.equal(state.toBlock, 10000);
  assert.equal(state.hasOlderDecisions, true);
  assert.equal(state.truncated, true);
  assert.equal(state.status, "partial");
});

test("the overlapping live range replaces orphaned logs instead of duplicating decisions", async () => {
  const { reader, data } = fixture({ end: 0n, head: 1000, logs: [decision({ block: 999 })] });
  await reader.read();
  data.head = 1001;
  data.logs = [decision({ block: 999, tx: toBeHex(100, 32) })];
  const state = await reader.read();
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].tx, toBeHex(100, 32));
});

test("timestamp failures preserve evidence and expose unknown times", async () => {
  const { reader, data } = fixture();
  data.failTimes = true;
  const state = await reader.read();
  assert.equal(state.status, "partial");
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0].timestamp, null);
});

test("the reader coalesces matching reads and stops cleanly", async () => {
  const { reader, calls } = fixture();
  await Promise.all([reader.read(), reader.read()]);
  assert.equal(calls.count, 1);
  reader.dispose();
  await reader.read();
  assert.equal(calls.count, 1);
  assert.equal(calls.disposed, 1);
});
