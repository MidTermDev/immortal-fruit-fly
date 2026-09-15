import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseEther } from "ethers";
import ts from "typescript";

const externalRequire = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const compile = (filename) => ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

const hook = { exports: {} };
new Function("module", "exports", "require", compile(path.join(sourceRoot, "hooks/useWorld.ts")))(hook, hook.exports, (id) => id.startsWith("@/") ? {} : externalRequire(id));
const { worldFoodAmount } = hook.exports;

function fixture(overrides = {}) {
  return {
    info: { alive: true, generation: 0, lastAgeMs: 1000, lastEnergy: 500, totalBurned: 0n, foodCount: 10, tps: parseEther("1"), minFood: parseEther("60"), resPrice: parseEther("100000"), arena: 120 },
    chainStatus: "live", frame: null, spikes: null, live: "offline",
    wallet: { address: "0x0000000000000000000000000000000000000001", balance: parseEther("1000000"), wrongNetwork: false, connecting: false },
    transaction: { phase: "idle", label: "", message: "" }, busy: false,
    ...overrides,
  };
}

function renderCare(state, amount = "1000") {
  let stateIndex = 0;
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const record = { exports: {} };
    const localRequire = (id) => {
      if (id === "@/hooks/useWorld") return { useWorld: () => state, worldFoodAmount };
      // Set only the editable field's initial state; React performs the render.
      if (id === "react") return { ...React, useState: (initial) => React.useState(stateIndex++ === 0 ? amount : initial) };
      if (id === "./WorldStage") return { __esModule: true, default: () => null };
      if (id === "next/link") return { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
      if (id.startsWith("@/")) return load(path.resolve(sourceRoot, `${id.slice(2)}.ts`));
      if (id.startsWith(".")) return load(path.resolve(path.dirname(filename), `${id}.tsx`));
      return externalRequire(id);
    };
    new Function("module", "exports", "require", compile(filename))(record, record.exports, localRequire);
    cache.set(filename, record.exports);
    return record.exports;
  }
  const Dashboard = load(path.join(sourceRoot, "components/WorldCareDashboard.tsx")).default;
  return renderToStaticMarkup(React.createElement(Dashboard));
}

function submit(html) {
  const found = html.match(/<button\b([^>]*class="feed-submit"[^>]*)>([\s\S]*?)<\/button>/);
  assert.ok(found, "Expected the feeding action");
  return { disabled: /\bdisabled(?:=|\s|$)/.test(found[1]), text: found[2].replace(/<[^>]*>/g, "") };
}

test("food placement remains available with an offline stream and live contract", () => {
  const html = renderCare(fixture());
  assert.equal(submit(html).disabled, false);
  assert.match(submit(html).text, /Place food/);
  assert.match(html, /Food is placed at the arena center\. Energy is added when eaten\./);
  assert.match(html, /1,000 seconds of food/);
  assert.match(html, /Live stream unavailable/);
  assert.ok(html.includes('href="/feed/"'));
  assert.ok(html.includes('href="/feed/world/"'));
  assert.ok(html.includes('href="/world/"'));
  assert.ok(html.includes('href="https://bscscan.com/address/0xD730E65Bdc1cBd40f720a36EeD71e2028Bf20EB4"'));
});

test("contract lifecycle decides between placement and revival even when a stream disagrees", () => {
  const state = fixture({ frame: { alive: false }, live: "live" });
  assert.match(submit(renderCare(state)).text, /Place food/);
  state.info.alive = false;
  state.frame.alive = true;
  const html = renderCare(state);
  assert.match(submit(html).text, /Revive the fly/);
  assert.match(html, /101,000 FLY will be burned/);
  assert.match(html, /1,000 seconds of energy/);
  assert.doesNotMatch(html, /Food is placed at the arena center/);
});

test("revival uses the full exact price plus food and its own minimum", () => {
  const state = fixture();
  state.info.alive = false;
  state.info.resPrice = parseEther("100000.123456789123456789");
  const html = renderCare(state, "1");
  assert.equal(submit(html).disabled, false);
  assert.match(html, /100,001\.123456789123456789 FLY will be burned/);
});

test("custom food decimals preserve their full burn amount", () => {
  const html = renderCare(fixture(), "1000.123456789123456789");
  assert.equal(submit(html).disabled, false);
  assert.match(html, /1,000\.123456789123456789 FLY will be burned/);
});

test("contract minimum, invalid values and uint64 overflow block spending", () => {
  for (const amount of ["59", "0", "-1", "1e3", "NaN", "1.0000000000000000001", (1n << 64n).toString()]) {
    const html = renderCare(fixture(), amount);
    assert.equal(submit(html).disabled, true, amount);
    assert.match(html, /aria-invalid="true"/);
  }
});

test("insufficient or unknown balances block placement and revival", () => {
  const state = fixture();
  state.wallet.balance = parseEther("999");
  assert.equal(submit(renderCare(state)).disabled, true);
  state.wallet.balance = parseEther("1000");
  assert.equal(submit(renderCare(state)).disabled, false);
  state.info.alive = false;
  assert.equal(submit(renderCare(state)).disabled, true);
  state.wallet.balance = null;
  const html = renderCare(state);
  assert.equal(submit(html).disabled, true);
  assert.match(html, /Balance unavailable/);
});

test("unavailable or stale chain state disables spending despite a live stream", () => {
  for (const chainStatus of ["loading", "offline", "stale"]) {
    assert.equal(submit(renderCare(fixture({ chainStatus, live: "live" }))).disabled, true);
  }
});

test("connection and network switching stay available before amount validation", () => {
  const state = fixture({ wallet: { address: null, balance: null, wrongNetwork: false, connecting: false } });
  let button = submit(renderCare(state, "invalid"));
  assert.equal(button.disabled, false);
  assert.match(button.text, /Connect wallet/);
  state.wallet.address = "0x0000000000000000000000000000000000000001";
  state.wallet.wrongNetwork = true;
  button = submit(renderCare(state, "invalid"));
  assert.equal(button.disabled, false);
  assert.match(button.text, /Switch network/);
});

test("pending writes lock the form, and confirmation links a receipt without claiming food was eaten", () => {
  const state = fixture({ busy: true, transaction: { phase: "pending", label: "Place food", message: "Waiting for confirmation…" } });
  assert.equal(submit(renderCare(state)).disabled, true);
  state.busy = false;
  state.transaction = { phase: "confirmed", label: "Place food", message: "Confirmed on-chain. The live server will read the event.", hash: `0x${"b".repeat(64)}` };
  const html = renderCare(state);
  assert.equal(submit(html).disabled, false);
  assert.ok(html.includes(`href="https://bscscan.com/tx/${state.transaction.hash}"`));
  assert.match(html, /1,000 seconds of food/);
  assert.doesNotMatch(html, /1,000 seconds of energy/);
});
