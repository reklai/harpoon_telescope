# Store Listing — Harpoon Telescope

## Release To-Do (Top Priority First)

1. Tab Manager and Session Manager reliability sign-off (release gate).
2. Validate rapid-switch stability: repeated slot jumps (`Alt+1..4`) and cycle keys (`Alt+-`, `Alt+=`) must not freeze, lock input, or miss jumps.
3. Validate scroll-location fidelity: jump, reopen-closed-tab, and session load (reused and newly opened tabs) must restore saved `scrollX/scrollY` reliably.
4. Validate panel-open reliability after focus changes (switch browser <-> IDE repeatedly): every panel must open instantly without requiring tab swaps.
5. Run full verification suite before packaging: `npm run ci`.
6. Build both store targets: `npm run build:firefox`, then `npm run build:chrome`.
7. Run store-policy and manifest consistency checks: `npm run verify:store`, then `npm run verify:compat`.
8. Finalize store assets and metadata (icons, screenshots, promo text, privacy links, support URL).
9. Submit Firefox package to AMO with `STORE.md` copy + permissions rationale + privacy policy.
10. Submit Chrome package to Chrome Web Store with same listing copy adapted to CWS form fields.
11. Post-submission smoke test on production listing builds in both browsers.
12. Regression-check composability layer paths before release (`src/lib/core/*` state transitions + `src/lib/adapters/runtime/*` API boundaries).

Use this content when submitting to Firefox Add-ons (AMO) and Chrome Web Store.
Category: **Productivity**

---

## Extension Name

Harpoon Telescope

## Summary (short — 132 characters max for AMO)

Pin your most-used tabs, search any page instantly, switch tabs by frequency. Built-in j/k aliases. No data collection.

## Description

### For AMO and Chrome Web Store (copy the text below the line)

---

**Stop losing tabs. Start navigating.**

Harpoon Telescope gives you three tools to take control of your browser tabs — no mouse required.

**Pin your key tabs**
Anchor up to 4 tabs to numbered slots. Jump to any of them instantly with a keyboard shortcut. Your scroll position is saved and restored automatically, so you land exactly where you left off. If a pinned tab gets closed, it reopens in place when you jump to it.

**Search the current page**
Press Alt+F to open a fast, fuzzy search overlay on any page. Results appear as you type, with a live preview pane showing the matched line in context. Use filters to narrow results by type:
- /headings — find section headers
- /links — find links
- /code — find code blocks
Filters combine freely: "/code /links api" searches both code and links for "api."

**Switch tabs by frequency**
Press Alt+Shift+F to see your most-used tabs ranked by how often and how recently you visit them. Type to filter the list by title or URL. Jump to any tab with Enter.

**Fully customizable keyboard shortcuts**
Every keybinding can be changed in the options page. Collision detection warns you before you create conflicts.

**Standard navigation aliases**
j/k aliases are always available for up/down movement on top of the standard arrow keys. List views also support Ctrl+D / Ctrl+U half-page movement.

**Predictable panel behavior**
Search, Tab Manager, and Sessions share the same list navigation semantics (arrow/j/k, wheel, half-page jumps) for consistent muscle memory.

**Sessions**
Press Alt+S to open the session menu (load view). Press Alt+Shift+S to open save-session directly. Keep up to 4 sessions. Save flow prevents duplicate names and duplicate-content saves.

**Privacy-first**
No data leaves your browser. No analytics, no tracking, no network requests. Everything is stored locally. See the full privacy policy for details.

Works on Firefox, Chrome, and Zen Browser.

---

## Tags / Keywords

tabs, productivity, keyboard, navigation, search, vim, harpoon, telescope, tab manager, shortcuts

## Additional notes for Chrome Web Store "Why do you need these permissions?"

- **tabs**: Read tab titles and URLs so the extension can display them in the tab manager and frecency list, and switch between tabs on your behalf.
- **activeTab**: Access the current page content to power the in-page search feature (Telescope).
- **storage**: Save your pinned tabs, sessions, frecency data, and keyboard shortcut preferences locally in the browser.
- **host_permissions (<all_urls>)**: Inject the content script on every page so keyboard shortcuts and search overlays work everywhere.
