# Store Reference — Harpoon Telescope

This document is a reference for store-facing metadata, product claims, and permission rationale.

## Extension Name

Harpoon Telescope

## Summary (short — 132 characters max for AMO)

Pin your most-used tabs, search any page instantly, switch tabs by frequency. Built-in j/k aliases. No data collection.

## Description

Harpoon Telescope is a keyboard-first tab and page navigation extension.

Core capabilities:

- Anchor up to 4 tabs to numbered slots.
- Restore scroll position when jumping back to saved tabs.
- Search the current page with fuzzy matching and filter shortcuts (`/code`, `/headings`, `/img`, `/links`).
- Press Alt+Shift+F to open a frecency-ranked open-tabs switcher.
- Keep up to 4 sessions.
- Customize global and panel keybindings from the options page.

Privacy and behavior claims:

- No data leaves your browser.
- No analytics, tracking, or external network telemetry.
- Everything is stored locally via browser extension storage.
- Works on Firefox, Chrome, and Zen Browser.

## Tags / Keywords

tabs, productivity, keyboard, navigation, search, harpoon, telescope, tab manager, shortcuts, session manager

## Additional notes for Chrome Web Store "Why do you need these permissions?"

- **tabs**: Read tab titles and URLs so the extension can display tab-manager and frecency lists, and switch tabs.
- **activeTab**: Access current-page content for in-page search.
- **storage**: Save tab-manager entries, sessions, frecency data, and keybinding preferences.
- **host_permissions (<all_urls>)**: Inject content scripts on pages where overlays and keybind-driven UI run.
