# Store Listing — Harpoon Telescope

## Tonight Submission Roadmap (Do This In Order)

### 0) Your account prerequisites (you)

1. Chrome Web Store developer account: registered and paid one-time fee.
2. Chrome Web Store account: 2-Step Verification enabled.
3. Chrome Web Store account: contact email verified in dashboard settings.
4. AMO developer account: ready to submit listing.
5. YouTube upload access: ready for an unlisted promo video URL (required in CWS store listing flow).

### 1) Your required listing assets (you)

Chrome Web Store listing assets to prepare before upload:

1. Store icon: `128x128`.
2. Screenshots: at least one `1280x800` (up to five).
3. Small promo tile: `440x280` PNG/JPEG.
4. Promo video: YouTube URL.
5. Marquee promo tile: `1400x560` PNG/JPEG (optional but recommended).

AMO listing assets/content to prepare:

1. Clear screenshots that show core flows (recommended `1280x800`, 1.6:1 ratio).
2. Support URL and/or support email.
3. Privacy policy URL/text (use `PRIVACY.md` as source).
4. Accurate feature summary (no misleading claims).

### 2) Build and verification steps (run in repo)

1. Run full gate: `npm run ci`.
2. Build Firefox package target: `npm run build:firefox`.
3. Zip `dist/` as Firefox upload artifact (`.xpi` or `.zip` with `manifest.json` at root).
4. Build Chrome package target: `npm run build:chrome`.
5. Zip `dist/` as Chrome upload artifact.
6. Prepare AMO source archive (required for listed and unlisted submissions as of **November 3, 2025**).

Suggested command sequence:

```sh
VERSION=$(node -p "require('./package.json').version")
mkdir -p release

npm run ci

npm run build:firefox
(cd dist && zip -qr "../release/harpoon-telescope-firefox-v${VERSION}.xpi" .)

npm run build:chrome
(cd dist && zip -qr "../release/harpoon-telescope-chrome-v${VERSION}.zip" .)

git archive --format=zip -o "release/harpoon-telescope-source-v${VERSION}.zip" HEAD
```

### 3) Submit to AMO (Firefox) first

1. Upload Firefox package (`.xpi`/zip artifact from Firefox build).
2. Upload source archive when prompted.
3. Paste summary/description from this file.
4. Add permission rationale and privacy policy.
5. Submit for review.

### 4) Submit to Chrome Web Store

1. Dashboard -> Add new item -> upload Chrome zip package.
2. Fill **Store listing** tab (copy from this file).
3. Fill **Privacy** tab (must match behavior and privacy policy).
4. Fill **Distribution** and (if needed) **Test instructions**.
5. Submit for review (optionally use deferred publishing).

### 5) Post-submission checklist

1. Monitor reviewer emails for both stores.
2. If reviewer asks for clarification, respond with exact feature/permission mapping from this file.
3. After approval, install listing build from each store and do one smoke pass.

### Official reference docs (review before submitting)

- Chrome Web Store register/publish/listing:
  - https://developer.chrome.com/docs/webstore/register
  - https://developer.chrome.com/docs/webstore/publish
  - https://developer.chrome.com/docs/webstore/cws-dashboard-listing
  - https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
  - https://developer.chrome.com/docs/webstore/program-policies/two-step-verification/
- Firefox/AMO publish and policy guidance:
  - https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
  - https://extensionworkshop.com/documentation/publish/source-code-submission/
  - https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/

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

**Configurable keyboard shortcuts**
Global commands and panel actions are configurable in the options page. Collision detection warns you before you create conflicts.

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

tabs, productivity, keyboard, navigation, search, harpoon, telescope, tab manager, shortcuts, session manager

## Additional notes for Chrome Web Store "Why do you need these permissions?"

- **tabs**: Read tab titles and URLs so the extension can display them in the tab manager and frecency list, and switch between tabs on your behalf.
- **activeTab**: Access the current page content to power the in-page search feature (Telescope).
- **storage**: Save your pinned tabs, sessions, frecency data, and keyboard shortcut preferences locally in the browser.
- **host_permissions (<all_urls>)**: Inject the content script on every page so keyboard shortcuts and search overlays work everywhere.
