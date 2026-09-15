import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/WorldDashboard.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function render(history = []) {
  const record = { exports: {} };
  const state = { frame: null, spikes: null, live: "offline", info: null, chainStatus: "offline", events: [], historyStatus: "unavailable", history, streamError: "Stream unavailable", refresh() {} };
  const localRequire = (id) => {
    if (id === "@/hooks/useWorld") return { useWorld: () => state };
    if (id === "@/lib/config") return { CFG: { explorer: "https://bscscan.com", world: "0x0000000000000000000000000000000000000001" } };
    if (id === "@/lib/world-types") return { worldOrigin: () => null };
    if (id === "./SiteHeader" || id === "./WorldStage") return { __esModule: true, default: () => null };
    if (id === "./WatchSources") {
      const watch = { exports: {} };
      const watchSource = readFileSync(new URL("../src/components/WatchSources.tsx", import.meta.url), "utf8");
      const watchCompiled = ts.transpileModule(watchSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
      new Function("module", "exports", "require", watchCompiled)(watch, watch.exports, localRequire);
      return watch.exports;
    }
    if (id.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) };
    if (id === "next/link") return { __esModule: true, default: ({ children, ...props }) => createElement("a", props, children) };
    return require(id);
  };
  new Function("module", "exports", "require", compiled)(record, record.exports, localRequire);
  return renderToStaticMarkup(createElement(record.exports.default));
}

const sample = (step, receivedAt, mode = "walk") => ({ id: String(step), receivedAt, t_ms: step * 10, step, generation: 0, mode, alive: true, steer: step / 100, orn: [4, 7], rates: {}, events: [] });

test("the offline world offers its own history and does not invent graph samples", () => {
  const html = render();
  assert.match(html, /href="#world-history"/);
  assert.match(html, /href="\/world\/" aria-current="page"/);
  assert.match(html, /Waiting for observed samples/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /href="\/decisions\/"/);
});

test("received observations produce real mode changes and both signal charts", () => {
  const html = render([sample(10, 1700000000000), sample(20, 1700000001000), sample(30, 1700000002000, "cast")]);
  assert.match(html, /3 observed samples/);
  assert.match(html, /Casting/);
  assert.match(html, /First sample in view/);
  assert.equal((html.match(/class="signalChart"/g) || []).length, 2);
  assert.match(html, /Left: 4 Hz/);
  assert.match(html, /Right: 7 Hz/);
});

test("graphs break at a missing stream interval instead of joining unobserved time", () => {
  const html = render([sample(10, 1700000000000), sample(20, 1700000010000)]);
  const dataPaths = [...html.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(dataPaths.length, 3);
  for (const path of dataPaths) {
    assert.equal((path.match(/M/g) || []).length, 2);
    assert.equal((path.match(/L/g) || []).length, 0);
  }
});
