# Contributing

## Local Setup

1. `npm ci`
2. `npm run typecheck`
3. `npm run build:firefox` or `npm run build:chrome`

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

## Pull Request Checklist

- Naming follows this guide.
- Any renamed path/function has all references updated.
- `npm run typecheck` passes.
- `npm run build` passes.
- `README.md` and/or this file updated if contributor-facing structure changed.
