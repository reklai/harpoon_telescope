# Contributing

## Local Setup

1. `npm ci`
2. `npm run lint`
3. `npm run test`
4. `npm run typecheck`
5. `npm run verify:compat`
6. `npm run build:firefox` or `npm run build:chrome`

## Naming Conventions

### Files and Folders

- `src/entrypoints/*`: use **kebab-case** for browser-facing entrypoint paths and asset names.
- `src/lib/*`: keep feature folders in existing **camelCase** style (`tabManager`, `searchCurrentPage`, etc.).
- Keep filename and primary export aligned where practical:
  - `tabManager.ts` -> `openTabManager(...)`
  - `options-page.ts` -> options page bootstrap logic

### Functions

- Use verb-based names for actions:
  - `open...`, `render...`, `load...`, `save...`, `remove...`, `handle...`
- Use `ensure...Loaded` for lazy initialization guards.
- Avoid ambiguous abbreviations in exported API names.

### Variables

- Booleans: prefix with `is`, `has`, `can`, or `should`.
- Arrays/collections: use plural nouns (`sessions`, `entries`, `filters`).
- Message payload objects: prefer descriptive names (`receivedMessage` instead of `m`).
- Avoid one-letter variable names except short-lived loop indexes (`i`, `j`) in obvious loops.

### Constants

- Use `UPPER_SNAKE_CASE` for constants shared across a module.
- Keep constant names domain-specific (`MAX_TAB_MANAGER_SLOTS`, `PANEL_DEBOUNCE_MS`).

## Module Boundaries

- `src/entrypoints/*`: thin startup/adaptor layers only.
- `src/lib/shared/*`: cross-feature utilities and shared state helpers.
- Feature modules should depend on `shared`, not on other feature internals unless necessary.

## Engineering Promise Guardrails

- Keep runtime UI framework-free: prefer browser primitives, Shadow DOM, and plain TypeScript.
- New overlays must compose from `createPanelHost()`, `getBaseStyles()`, and `registerPanelCleanup()`.
- Treat UI smoothness as a default requirement: avoid full-list rerenders, prefer rAF-throttled work, and keep compositor-friendly panel containers.
- Preserve Firefox/Chrome parity when touching commands, permissions, or manifests.

## Pull Request Checklist

- Naming follows this guide.
- Any renamed path/function has all references updated.
- `npm run lint` passes.
- `npm run test` passes.
- `npm run typecheck` passes.
- `npm run verify:compat` passes.
- `npm run build:firefox` and `npm run build:chrome` pass.
- `README.md` and/or this file updated if contributor-facing structure changed.
