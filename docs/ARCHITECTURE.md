# Architecture Guide

This repository is intentionally browser-primitive and framework-free, with a Ghostty-inspired UX target:

- Runtime UI: Shadow DOM + native DOM APIs
- Runtime logic: plain TypeScript modules
- Extension APIs: `webextension-polyfill` for Firefox/Chrome parity

## High-Level Runtime Model

- `src/entryPoints/background/background.ts`
  - Thin orchestration layer for background startup.
  - Registers domain handlers from `src/lib/background/*`.
- `src/entryPoints/contentScript/contentScript.ts`
  - Bootstraps in-page overlays and message handling.
- `src/entryPoints/optionsPage/*`
  - Keybinding settings UI.
- `src/entryPoints/toolbarPopup/*`
  - Lightweight browser-action popup.

All feature modules live in `src/lib/*` and are imported by entryPoints.

## Module Layers

- `src/lib/shared/*`
  - Cross-feature contracts and primitives (`keybindings`, `runtimeMessages`, `panelHost`, `helpers`).
- `src/lib/background/*`
  - Background-only domains and routers (`tabManagerDomain`, `bookmarkDomain`, `runtimeRouter`, `commandRouter`, etc.).
- `src/lib/<feature>/*`
  - Feature-local logic and UI.
  - Current features: `tabManager`, `searchCurrentPage`, `searchOpenTabs`, `bookmarks`, `history`, `addBookmark`, `help`.

Rule of thumb:
- Feature modules can use `shared`.
- Feature modules should not depend on internals of other features.

## Data Flow Pattern

1. User input in content script / overlay.
2. Message to background if browser privileges are required.
3. Background mutates/reads state and replies.
4. Overlay updates local state and re-renders visible UI.

This keeps privileged state centralized and UI logic decoupled.

## UI Performance Pattern

- Single active overlay host (`createPanelHost` + `registerPanelCleanup`).
- Virtualized result lists for heavy panes.
- `requestAnimationFrame` throttling for preview/detail/scroll-driven updates.
- `withPerfTrace` markers + `perfBudgets.json` thresholds for filter/render hotspots.
- Responsive panel layout with media queries and compositor-friendly containers.

## Store-Readiness Guardrails

- `npm run verify:compat`
  - Manifest permissions and command constraints.
  - MV2 Gecko metadata checks for AMO.
  - Core command and asset sanity checks.
- `npm run verify:upgrade`
  - Fixture-based storage migration checks for upgrade safety.
- `npm run verify:store`
  - Store listing + privacy + manifest consistency checks.
- `npm run ci`
  - `lint` + `test` + `typecheck` + `verify:compat` + `verify:upgrade` + `verify:store` + Firefox/Chrome builds.

## Contributor Path (Recommended)

1. Pick a feature folder in `src/lib/*`.
2. Trace its entrypoint call path.
3. Add/adjust runtime message contracts only in `src/lib/shared/runtimeMessages.ts`.
4. Keep UI changes inside feature CSS/TS + `panelHost` primitives.
5. Run `npm run ci` before opening a PR.

## Future Refactor Directions

- Add per-feature perf dashboards in options/dev mode using `globalThis.__HT_PERF_STATS__`.
- Expand responsive smoke tests from CSS assertions to browser-level viewport tests.
- Continue splitting large feature overlays into smaller UI state modules where complexity grows.
