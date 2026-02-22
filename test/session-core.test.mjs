import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";

const ROOT = process.cwd();

async function loadSessionCoreModule() {
  const source = readFileSync(
    resolve(ROOT, "src/lib/core/sessionMenu/sessionCore.ts"),
    "utf8",
  );

  const transformed = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });

  const encoded = Buffer.from(transformed.code, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

function sampleSessions() {
  return [
    {
      name: "alpha",
      entries: [{ url: "https://a.dev", title: "A", scrollX: 0, scrollY: 0 }],
      savedAt: 1,
    },
    {
      name: "beta",
      entries: [{ url: "https://b.dev", title: "B", scrollX: 0, scrollY: 0 }],
      savedAt: 2,
    },
  ];
}

test("sessionCore default state is clean", async () => {
  const core = await loadSessionCoreModule();
  const state = core.createSessionTransientState();

  assert.equal(state.isRenameModeActive, false);
  assert.equal(state.isOverwriteConfirmationActive, false);
  assert.equal(state.isDeleteConfirmationActive, false);
  assert.equal(state.isLoadConfirmationActive, false);
  assert.equal(state.pendingLoadSummary, null);
  assert.equal(state.pendingLoadSessionName, "");
  assert.equal(state.pendingDeleteSessionName, "");
  assert.equal(state.sessionListFocusTarget, "filter");
});

test("sessionCore load confirmation transition stores plan context", async () => {
  const core = await loadSessionCoreModule();
  const initial = core.createSessionTransientState();
  const summary = { sessionName: "alpha", totalCount: 1, replaceCount: 1, openCount: 1, reuseCount: 0, slotDiffs: [], reuseMatches: [] };

  const next = core.startSessionLoadConfirmation(initial, "alpha", summary);

  assert.equal(next.isLoadConfirmationActive, true);
  assert.equal(next.pendingLoadSessionName, "alpha");
  assert.deepEqual(next.pendingLoadSummary, summary);
  assert.equal(next.isDeleteConfirmationActive, false);
  assert.equal(next.pendingDeleteSessionName, "");
});

test("sessionCore delete confirmation transition clears conflicting transient modes", async () => {
  const core = await loadSessionCoreModule();
  const summary = { sessionName: "alpha", totalCount: 1, replaceCount: 1, openCount: 1, reuseCount: 0, slotDiffs: [], reuseMatches: [] };
  const withLoad = core.startSessionLoadConfirmation(core.createSessionTransientState(), "alpha", summary);
  const withRename = core.startSessionRenameMode(withLoad);
  const withOverwrite = core.startSessionOverwriteConfirmation(withRename);

  const next = core.startSessionDeleteConfirmation(withOverwrite, "beta");

  assert.equal(next.isRenameModeActive, false);
  assert.equal(next.isLoadConfirmationActive, false);
  assert.equal(next.pendingLoadSessionName, "");
  assert.equal(next.pendingLoadSummary, null);
  assert.equal(next.isOverwriteConfirmationActive, false);
  assert.equal(next.isDeleteConfirmationActive, true);
  assert.equal(next.pendingDeleteSessionName, "beta");
});

test("sessionCore deriveSessionListViewModel keeps selected row or falls back to top visible", async () => {
  const core = await loadSessionCoreModule();
  const sessions = sampleSessions();
  const state = core.createSessionTransientState();

  const selected = core.deriveSessionListViewModel(sessions, [1], 1, "", state);
  assert.equal(selected.selectedSessionIndex, 1);
  assert.equal(selected.selectedSession.name, "beta");
  assert.equal(selected.shouldSyncSessionIndex, false);

  const fallback = core.deriveSessionListViewModel(sessions, [1], 0, "", state);
  assert.equal(fallback.selectedSessionIndex, 1);
  assert.equal(fallback.selectedSession.name, "beta");
  assert.equal(fallback.shouldSyncSessionIndex, true);
});

test("sessionCore deriveSessionListViewModel prioritizes pending delete preview target", async () => {
  const core = await loadSessionCoreModule();
  const sessions = sampleSessions();
  const deleteState = core.startSessionDeleteConfirmation(core.createSessionTransientState(), "alpha");

  const vm = core.deriveSessionListViewModel(sessions, [1], 1, "be", deleteState);

  assert.equal(vm.titleText, "Load Sessions (1)");
  assert.equal(vm.selectedSession.name, "beta");
  assert.equal(vm.previewTargetSession.name, "alpha");
});

test("sessionCore hasActiveSessionConfirmation only tracks confirm sub-modes", async () => {
  const core = await loadSessionCoreModule();

  const clean = core.createSessionTransientState();
  assert.equal(core.hasActiveSessionConfirmation(clean), false);

  const overwrite = core.startSessionOverwriteConfirmation(clean);
  assert.equal(core.hasActiveSessionConfirmation(overwrite), true);

  const clearedOverwrite = core.stopSessionOverwriteConfirmation(overwrite);
  assert.equal(core.hasActiveSessionConfirmation(clearedOverwrite), false);

  const summary = { sessionName: "alpha", totalCount: 1, replaceCount: 1, openCount: 1, reuseCount: 0, slotDiffs: [], reuseMatches: [] };
  const withLoad = core.startSessionLoadConfirmation(clean, "alpha", summary);
  assert.equal(core.hasActiveSessionConfirmation(withLoad), true);

  const withDelete = core.startSessionDeleteConfirmation(clean, "beta");
  assert.equal(core.hasActiveSessionConfirmation(withDelete), true);
});
