import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const externalRequire = createRequire(import.meta.url);

// Exercise the actual adapter without a wallet, RPC, or an added test framework.
function loadTypeScript(filename) {
  const source = readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const record = { exports: {} };
  const localRequire = (id) => id.startsWith(".") ? loadTypeScript(path.resolve(path.dirname(filename), `${id}.ts`)) : externalRequire(id);
  new Function("module", "exports", "require", compiled)(record, record.exports, localRequire);
  return record.exports;
}

const { Chain, actionError } = loadTypeScript(fileURLToPath(new URL("../src/lib/chain.ts", import.meta.url)));
const receipt = (hash = "0xconfirmed") => ({ hash, status: 1 });
const transaction = (hash = "0xsubmitted") => ({ hash, wait: async () => receipt() });

function mockChain(allowance = 0n) {
  const chain = new Chain();
  const calls = [];
  chain.account = "0xaccount";
  chain.prices = { stimPrice: 100n, resurrectPrice: 100000n };
  chain.token = { allowance: async () => allowance };
  chain.tokenW = { approve: async (_spender, amount) => { calls.push(["approve", amount]); return transaction("0xapproval"); } };
  chain.brainW = {
    feed: async (amount) => { calls.push(["feed", amount]); return transaction(); },
    stimulate: async (channel, param, strength, steps) => { calls.push(["stimulate", channel, param, strength, steps]); return transaction(); },
    resurrect: async (food) => { calls.push(["resurrect", food]); return transaction(); },
    tick: async (steps) => { calls.push(["tick", steps]); return transaction(); },
  };
  return { chain, calls };
}

test("feeding approves only the entered amount and revalidates before submitting", async () => {
  const { chain, calls } = mockChain();
  const phases = [];
  const result = await chain.feed(1500n, (phase, hash) => phases.push([phase, hash]), async () => { calls.push(["validate"]); });
  assert.deepEqual(calls, [["approve", 1500n], ["validate"], ["feed", 1500n]]);
  assert.deepEqual(phases.map(([phase]) => phase), ["approval", "approving", "wallet", "pending", "confirmed"]);
  assert.equal(phases.at(-1)[1], result.hash);
});

test("an existing allowance skips the approval transaction", async () => {
  const { chain, calls } = mockChain(2000n);
  await chain.feed(1500n);
  assert.deepEqual(calls, [["feed", 1500n]]);
});

test("cancelled approval never submits the action", async () => {
  const { chain, calls } = mockChain();
  chain.tokenW.approve = async () => { throw { code: "ACTION_REJECTED" }; };
  await assert.rejects(chain.feed(1500n), (error) => actionError(error) === "Cancelled in your wallet.");
  assert.deepEqual(calls, []);
});

test("a lifecycle change after approval prevents the action", async () => {
  const { chain, calls } = mockChain();
  await assert.rejects(chain.feed(1500n, undefined, async () => { throw new Error("The fly has died."); }), /fly has died/);
  assert.deepEqual(calls, [["approve", 1500n]]);
});

test("interaction uses refreshed energy after its approval", async () => {
  const { chain, calls } = mockChain();
  await chain.stimulate(2, 0, 4, 16, undefined, async () => 2);
  assert.deepEqual(calls, [["approve", 400n], ["stimulate", 2, 0, 4, 2]]);
});

test("revival approves its contract price plus food", async () => {
  const { chain, calls } = mockChain();
  await chain.resurrect(1000n);
  assert.deepEqual(calls, [["approve", 101000n], ["resurrect", 1000n]]);
});

test("a reverted receipt is never reported as confirmed", async () => {
  const { chain } = mockChain();
  const phases = [];
  chain.brainW.tick = async () => ({ hash: "0xfailed", wait: async () => ({ status: 0 }) });
  await assert.rejects(chain.tick(8, (phase) => phases.push(phase)), /transaction failed/);
  assert.deepEqual(phases, ["wallet", "pending"]);
});

test("a repriced transaction uses the replacement receipt", async () => {
  const { chain } = mockChain();
  chain.brainW.tick = async () => ({ hash: "0xold", wait: async () => { throw { code: "TRANSACTION_REPLACED", cancelled: false, receipt: receipt("0xnew") }; } });
  assert.equal((await chain.tick(8)).hash, "0xnew");
});

test("snapshot fields are read at one confirmed block", async () => {
  const { chain } = mockChain();
  const blocks = [];
  const view = (value) => async ({ blockTag }) => { blocks.push(blockTag); return value; };
  chain.provider = { getBlockNumber: async () => 12345 };
  chain.brain = {
    brainState: view({ v: [1n], bias: [0n], headingHist: [2n], pendingInput: [0n], step: 10n, energy: 5n, alive: false, generation: 1n, posX: 512n, posY: -256n, headX: 10n, headY: 20n }),
    activeStimulus: view({ channel: 0n, param: 0n, strength: 0n, untilStep: 0n, active: false }),
    totalSpikes: view(55n), totalBurned: view(1200n), lineageLength: view(1n),
  };
  chain.token.totalSupply = view(99999n);
  const state = await chain.readState();
  assert.deepEqual(blocks, Array(6).fill(12345));
  assert.equal(state.alive, false);
  assert.equal(state.posX, 512);
  assert.equal(state.posY, -256);
  assert.equal(state.totalBurned, 1200n);
  assert.equal(state.energyRaw, 5n);
});

test("energy retains exact uint64 precision for feed limit checks", async () => {
  const { chain } = mockChain();
  const rawEnergy = (1n << 64n) - 2n;
  chain.provider = { getBlockNumber: async () => 12345 };
  chain.brain = {
    brainState: async () => ({ v: [], bias: [], headingHist: [], pendingInput: [], step: 0n, energy: rawEnergy, alive: true, generation: 0n, posX: 0n, posY: 0n, headX: 0n, headY: 0n }),
    activeStimulus: async () => ({ channel: 0n, param: 0n, strength: 0n, untilStep: 0n, active: false }),
    totalSpikes: async () => 0n, totalBurned: async () => 0n, lineageLength: async () => 0n,
  };
  chain.token.totalSupply = async () => 0n;
  const state = await chain.readState();
  assert.equal(state.energyRaw, rawEnergy);
  assert.notEqual(BigInt(state.energy), rawEnergy);
});

test("wallet synchronization reads accounts and network without prompting", async () => {
  const originalWindow = globalThis.window;
  const requests = [];
  globalThis.window = { ethereum: { request: async ({ method }) => {
    requests.push(method);
    if (method === "eth_accounts") return ["0x0000000000000000000000000000000000000001"];
    if (method === "eth_chainId") return "0x38";
    throw new Error(`Unexpected wallet request: ${method}`);
  } } };
  try {
    const chain = new Chain();
    const wallet = await chain.syncWallet();
    assert.equal(wallet.address, "0x0000000000000000000000000000000000000001");
    assert.equal(wallet.wrongNetwork, false);
    assert.deepEqual(requests, ["eth_accounts", "eth_chainId"]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("world food approval targets FlyWorld for only the chosen amount", async () => {
  const { chain, calls } = mockChain();
  const spender = [];
  chain.tokenW.approve = async (address, amount) => { spender.push(address); calls.push(["approve", amount]); return transaction(); };
  chain.worldW = { placeFood: async (x, y, amount) => { calls.push(["food", x, y, amount]); return transaction(); } };
  await chain.placeFood(-10, 20, 600n, undefined, async () => { calls.push(["validate"]); });
  assert.deepEqual(calls, [["approve", 600n], ["validate"], ["food", -10, 20, 600n]]);
  assert.equal(spender[0].toLowerCase(), "0xd730e65bdc1cbd40f720a36eed71e2028bf20eb4");
});

test("world revival approves price plus food and rechecks lifecycle", async () => {
  const { chain, calls } = mockChain();
  chain.worldW = { resurrect: async (food) => { calls.push(["revive", food]); return transaction(); } };
  await chain.resurrectWorld(1000n, 100000n, undefined, async () => { calls.push(["validate"]); });
  assert.deepEqual(calls, [["approve", 101000n], ["validate"], ["revive", 1000n]]);
});

test("denied world event queries propagate instead of returning empty history", async () => {
  const { chain } = mockChain();
  const ranges = [];
  chain.provider = {
    getBlockNumber: async () => 10000,
    getLogs: async (range) => { ranges.push(range); throw new Error("Archive requests require a personal token."); },
  };
  await assert.rejects(chain.worldEvents(40000), /Archive requests/);
  assert.equal(ranges[0].fromBlock, 8001);
  assert.equal(ranges[0].toBlock, 10000);
});

test("event reads reject an oversized range before contacting the RPC", async () => {
  const { chain } = mockChain();
  chain.provider = { getLogs: async () => { throw new Error("Should not contact RPC"); } };
  await assert.rejects(chain.readEvents("core", 1, 2001), /at most 2,000/);
});
