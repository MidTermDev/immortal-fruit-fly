import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/decisions.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const record = { exports: {} };
new Function("module", "exports", compiled)(record, record.exports);
const { executions, heading, position } = record.exports;

function event(name, index, overrides = {}) {
  const value = { source: "core", tx: "0xtransaction", block: 100, timestamp: 1700000000, name, index, args: {}, ...overrides };
  return { ...value, id: `${value.source}:${value.tx}:${value.index}` };
}

function tick(index, overrides = {}) {
  const args = { fromStep: 100n, steps: 16n, spikes: 256n, posX: 256n, posY: -512n, headX: 10n, headY: 0n, energyLeft: 1000n, ...overrides.args };
  return event("Ticked", index, { ...overrides, args });
}

test("a multicall associates only new input events before each execution", () => {
  const stimulus = event("Stimulated", 0, { args: { channel: 2n, strength: 4n } });
  const fed = event("Fed", 2, { args: { energyAdded: 100n } });
  // Deliberately unsorted: log order, not array order, determines causality.
  const records = executions([tick(3), fed, tick(1), stimulus]);
  assert.deepEqual(records.map((entry) => entry.event.index), [3, 1]);
  assert.deepEqual(records[0].inputs.map((entry) => entry.name), ["Fed"]);
  assert.deepEqual(records[1].inputs.map((entry) => entry.name), ["Stimulated"]);
});

test("world events and other transactions cannot become core inputs", () => {
  const records = executions([
    event("Resurrected", 0, { source: "world" }),
    event("Fed", 1, { tx: "0xother" }),
    event("Stimulated", 2, { block: 99 }),
    tick(3),
    tick(4, { source: "world" }),
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].inputs, []);
});

test("later input events never apply retroactively and duplicate logs are ignored", () => {
  const first = tick(1);
  const records = executions([first, { ...first, id: "duplicate-id" }, event("Stimulated", 2), tick(3)]);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].inputs.map((entry) => entry.index), [2]);
  assert.deepEqual(records[1].inputs, []);
});

test("death and revival inside one transaction preserve execution boundaries", () => {
  const records = executions([
    event("Stimulated", 0),
    tick(1, { args: { energyLeft: 0n } }),
    event("Died", 2),
    event("Resurrected", 3),
    tick(4),
  ]);
  assert.deepEqual(records[0].inputs.map((entry) => entry.name), ["Resurrected"]);
  assert.deepEqual(records[1].inputs.map((entry) => entry.name), ["Stimulated"]);
  assert.equal(records[1].energy, 0n);
});

test("uint64 step ranges and int64 positions retain their recorded precision", () => {
  const from = 9007199254740993n;
  const energy = (1n << 64n) - 1n;
  const [execution] = executions([tick(1, { args: { fromStep: from, steps: 32n, energyLeft: energy, posX: 9223372036854775806n, posY: -9223372036854775806n } })]);
  assert.equal(execution.from, from);
  assert.equal(execution.to, from + 32n);
  assert.equal(execution.energy, energy);
  assert.equal(execution.x, "36028797018963967.99");
  assert.equal(execution.y, "-36028797018963967.99");
});

test("a zero-step tick remains a real record with no invented heading", () => {
  const [execution] = executions([tick(1, { args: { steps: 0n, spikes: 0n, headX: 0n, headY: 0n, energyLeft: 0n } })]);
  assert.equal(execution.from, execution.to);
  assert.equal(execution.steps, 0);
  assert.equal(execution.spikes, 0);
  assert.equal(execution.direction, null);
});

test("coordinate rounding and compass axes follow the contract vector", () => {
  assert.equal(position(32n), "0.13");
  assert.equal(position(-32n), "-0.13");
  assert.equal(heading(1, 0), 0);
  assert.equal(heading(0, 1), 90);
  assert.equal(heading(-1, 0), 180);
  assert.equal(heading(0, -1), 270);
  assert.equal(heading(0, 0), null);
});
