# Privacy Policy — TabScope

**Last updated:** February 25, 2026

## Summary

TabScope does not collect, transmit, or share any user data. Everything stays in your browser.
No account is required. No cloud sync is used.

## Data Storage

The extension stores the following data locally in your browser using `browser.storage.local`:

- **Harpoon list** (`tabManagerList`) — URLs and scroll positions of your pinned tabs (up to 4)
- **Saved sessions** (`tabManagerSessions`) — named snapshots of your harpoon list (up to 4)
- **Frecency data** (`frecencyData`) — visit frequency and recency scores for open tabs (up to 50 entries)
- **Keybinding preferences** (`keybindings`) — your custom global and panel shortcuts
- **Storage schema version** (`storageSchemaVersion`) — migration/versioning metadata

This data never leaves your browser. It is not sent to any server, API, or third party.

## Data Processing (In-Memory, Not Sent Anywhere)

To provide features, the extension processes some data in memory at runtime:

- **Current page content** for in-page search (for example headings, links, code blocks, and visible text)
- **Open tab metadata** (title/URL) for tab manager and frecency ranking
- **Keyboard input and runtime messages** to execute actions and render overlays

This processing happens locally in the browser and is not transmitted externally.

## Data Collection

None. The extension:

- Does not collect analytics or telemetry
- Does not access browser history APIs
- Does not use cookies
- Does not make network requests (no remote servers, no APIs, no pings)
- Does not load remote code or scripts
- Does not use `eval()` or dynamic code execution
- Does not fingerprint users or devices

## Permissions Explained

| Permission | Why it's needed |
|------------|----------------|
| `tabs` | Read tab titles and URLs to display in harpoon and frecency lists, and to switch between tabs |
| `activeTab` | Access the active page context for current-page actions |
| `storage` | Save your harpoon list, sessions, frecency data, keybinding preferences, and schema version locally |
| `<all_urls>` | Inject the content script that provides keyboard shortcuts and search overlays on pages where you use the extension |

## Third Parties

There are none. No third-party services, SDKs, libraries that phone home, or external dependencies that transmit data. The only runtime dependency (`webextension-polyfill`) is a local compatibility shim that makes no network requests.

## Data Sharing

None. TabScope does not sell, rent, transfer, or disclose your data to third parties.

## Data Retention

Data remains in local extension storage until you remove it (for example by uninstalling the extension or clearing extension storage).

## Data Deletion

All stored data can be cleared by:

1. Uninstalling the extension (removes all extension storage automatically)
2. Clearing your browser's extension storage via developer tools

## Changes to This Policy

If this policy changes, the update will be published here alongside the extension update. The "Last updated" date at the top will reflect the most recent revision.

## Contact

If you have questions about this privacy policy, open an issue on the project's GitHub repository.
