# Architecture Guide

This repository is intentionally browser-primitive and framework-free, with a Ghostty-inspired UX target:

- Runtime UI: Shadow DOM + native DOM APIs
- Runtime logic: plain TypeScript modules
- Extension APIs: `webextension-polyfill` for Firefox/Chrome parity

## High-Level Runtime Model

- `src/entrypoints/background/background.ts`
  - Owns persistent extension state and browser API orchestration.
  - Handles commands and runtime messages.
- `src/entrypoints/content-script/content-script.ts`
  - Bootstraps in-page overlays and message handling.
- `src/entrypoints/options-page/*`
  - Keybinding settings UI.
- `src/entrypoints/toolbar-popup/*`
  - Lightweight browser-action popup.

All feature modules live in `src/lib/*` and are imported by entrypoints.

## Module Layers

- `src/lib/shared/*`
  - Cross-feature contracts and primitives (`keybindings`, `runtimeMessages`, `panelHost`, `helpers`).
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
- Responsive panel layout with media queries and compositor-friendly containers.

## Store-Readiness Guardrails

- `npm run verify:compat`
  - Manifest permissions and command constraints.
  - MV2 Gecko metadata checks for AMO.
  - Core command and asset sanity checks.
- `npm run ci`
  - `lint` + `test` + `typecheck` + `verify:compat` + Firefox/Chrome builds.

## Contributor Path (Recommended)

1. Pick a feature folder in `src/lib/*`.
2. Trace its entrypoint call path.
3. Add/adjust runtime message contracts only in `src/lib/shared/runtimeMessages.ts`.
4. Keep UI changes inside feature CSS/TS + `panelHost` primitives.
5. Run `npm run ci` before opening a PR.

## Future Refactor Directions

- Extract domain-specific message handlers in background (tab manager, bookmarks, history) into separate modules while keeping `background.ts` as the router.
- Introduce shared design tokens in `panelHost` CSS variables to centralize visual tuning.
- Add lightweight performance marks (`performance.now`) around filter/render hotspots for regression tracking.
