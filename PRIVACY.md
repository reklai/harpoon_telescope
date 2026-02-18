# Privacy Policy — Harpoon Telescope

**Last updated:** February 19, 2026

## Summary

Harpoon Telescope does not collect, transmit, or share any user data. Everything stays in your browser.

## Data Storage

The extension stores the following data locally in your browser using `browser.storage.local`:

- **Harpoon list** — URLs and scroll positions of your pinned tabs (up to 6)
- **Saved sessions** — named snapshots of your harpoon list (up to 3)
- **Frecency data** — visit frequency and recency scores for open tabs (up to 50 entries)
- **Keybinding preferences** — your custom keyboard shortcuts and navigation mode setting

This data never leaves your browser. It is not sent to any server, API, or third party.

## Data Collection

None. The extension:

- Does not collect analytics or telemetry
- Does not track browsing history beyond the frecency scores stored locally
- Does not use cookies
- Does not make network requests (no remote servers, no APIs, no pings)
- Does not load remote code or scripts
- Does not use `eval()` or dynamic code execution
- Does not fingerprint users or devices

## Permissions Explained

| Permission | Why it's needed |
|------------|----------------|
| `tabs` | Read tab titles and URLs to display in harpoon and frecency lists, and to switch between tabs |
| `activeTab` | Access the current page's content for in-page search (Telescope) |
| `storage` | Save your harpoon list, sessions, frecency data, and keybinding preferences locally |
| `<all_urls>` | Inject the content script that provides keyboard shortcuts and search overlays on any page |

## Third Parties

There are none. No third-party services, SDKs, libraries that phone home, or external dependencies that transmit data. The only runtime dependency (`webextension-polyfill`) is a local compatibility shim that makes no network requests.

## Data Deletion

All stored data can be cleared by:

1. Uninstalling the extension (removes all extension storage automatically)
2. Clearing your browser's extension storage via developer tools

## Changes to This Policy

If this policy changes, the update will be published here alongside the extension update. The "Last updated" date at the top will reflect the most recent revision.

## Contact

If you have questions about this privacy policy, open an issue on the project's GitHub repository.
