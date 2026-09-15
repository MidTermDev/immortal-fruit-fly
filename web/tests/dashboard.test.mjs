import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseEther } from "ethers";
import ts from "typescript";

const externalRequire = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function fixture(overrides = {}) {
  return {
    snapshot: { alive: true, energy: 10000, energyRaw: 10000n, step: 1200, generation: 0 },
    connection: "live",
    prices: { tokensPerStep: parseEther("1"), stimPrice: parseEther("100"), resurrectPrice: parseEther("100000"), stimTTL: 64, maxSteps: 32 },
    wallet: { address: "0x0000000000000000000000000000000000000001", balance: parseEther("1000000"), wrongNetwork: false, connecting: false },
    transaction: { phase: "idle", label: "", message: "" },
    busy: false,
    ...overrides,
  };
}

function renderDashboard(state) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const record = { exports: {} };
    const localRequire = (id) => {
      if (id === "@/hooks/useFly") return { useFly: () => state };
      // The render guard tests use the real dashboard/header. Only the canvas,
      // routing integration, and external wallet/data boundary are substituted.
      if (id === "./FlyStage") return { __esModule: true, default: () => null };
      if (id === "next/link") return { __esModule: true, default: ({ children, ...props }) => createElement("a", props, children) };
      if (id.startsWith("@/")) return load(path.resolve(sourceRoot, `${id.slice(2)}.ts`));
      if (id.startsWith(".")) return load(path.resolve(path.dirname(filename), `${id}.tsx`));
      return externalRequire(id);
    };
    new Function("module", "exports", "require", compiled)(record, record.exports, localRequire);
    cache.set(filename, record.exports);
    return record.exports;
  }
  const Fly = load(path.join(sourceRoot, "components/Fly.tsx")).default;
  return renderToStaticMarkup(createElement(Fly));
}

function button(html, className) {
  const found = html.match(new RegExp(`<button\\b([^>]*class="${className}"[^>]*)>([\\s\\S]*?)</button>`));
  assert.ok(found, `Expected the ${className} control`);
  return { disabled: /\bdisabled(?:=|\s|$)/.test(found[1]), text: found[2].replace(/<[^>]*>/g, "") };
}

test("a dead fly offers revival and prevents stimulus/tick spending", () => {
  const state = fixture();
  state.snapshot = { ...state.snapshot, alive: false, energy: 0, energyRaw: 0n };
  const html = renderDashboard(state);
  assert.match(html, /<h2>Revive the fly<\/h2>/);
  assert.equal(button(html, "feed-submit").disabled, false);
  assert.match(button(html, "feed-submit").text, /Revive the fly/);
  assert.equal(button(html, "interaction-submit").disabled, true);
  assert.equal(button(html, "advance-button").disabled, true);
  assert.match(html, /<summary class="wallet-button">/);
  assert.match(html, /101,000 FLY will be burned/);
});

for (const connection of ["offline", "stale"]) {
  test(`${connection} state prevents paid actions while keeping wallet access`, () => {
    const state = fixture({ connection });
    if (connection === "offline") state.snapshot = null;
    const html = renderDashboard(state);
    assert.equal(button(html, "feed-submit").disabled, true);
    assert.equal(button(html, "interaction-submit").disabled, true);
    assert.equal(button(html, "advance-button").disabled, true);
    assert.match(html, /<summary class="wallet-button">/);
    assert.match(html, />Retry<\/button>/);
  });
}

test("a disconnected visitor has an enabled connect action", () => {
  const state = fixture({ wallet: { address: null, balance: null, wrongNetwork: false, connecting: false } });
  const html = renderDashboard(state);
  assert.equal(button(html, "wallet-button").disabled, false);
  assert.equal(button(html, "wallet-button").text.includes("Connect wallet"), true);
  assert.equal(button(html, "feed-submit").disabled, false);
  assert.match(button(html, "feed-submit").text, /Connect wallet/);
});

test("insufficient FLY blocks token spending but leaves gas-only advance available", () => {
  const state = fixture();
  state.wallet = { ...state.wallet, balance: 0n };
  const html = renderDashboard(state);
  assert.equal(button(html, "feed-submit").disabled, true);
  assert.equal(button(html, "interaction-submit").disabled, true);
  assert.match(button(html, "interaction-submit").text, /Not enough FLY/);
  assert.equal(button(html, "advance-button").disabled, false);
});

test("pending transactions block duplicate action submissions", () => {
  const html = renderDashboard(fixture({ busy: true, transaction: { phase: "pending", label: "Feed", message: "Waiting for confirmation…" } }));
  assert.equal(button(html, "feed-submit").disabled, true);
  assert.equal(button(html, "interaction-submit").disabled, true);
  assert.equal(button(html, "advance-button").disabled, true);
  assert.match(html, /Waiting for confirmation/);
});

test("confirmed transactions expose the actual receipt link and release actions", () => {
  const hash = `0x${"a".repeat(64)}`;
  const html = renderDashboard(fixture({ transaction: { phase: "confirmed", label: "Feed", message: "Confirmed.", hash } }));
  assert.match(html, /role="status"/);
  assert.match(html, /Confirmed\./);
  assert.ok(html.includes(`href="https://bscscan.com/tx/${hash}"`));
  assert.equal(button(html, "feed-submit").disabled, false);
  assert.equal(button(html, "interaction-submit").disabled, false);
});
