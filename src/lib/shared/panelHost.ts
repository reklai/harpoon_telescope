// Shadow DOM panel host — creates an isolated overlay container with focus
// trapping so keyboard input stays in the panel (not the address bar).

export interface PanelHost {
  host: HTMLDivElement;
  shadow: ShadowRoot;
}

// Active panel cleanup — called before opening a new panel so the previous
// panel's keydown listener (registered on document) is properly removed.
let activePanelCleanup: (() => void) | null = null;

/** Register a cleanup function for the currently open panel.
 *  Called by each overlay after setup so createPanelHost can tear it down. */
export function registerPanelCleanup(fn: () => void): void {
  activePanelCleanup = fn;
}

/** Create a full-viewport Shadow DOM host for overlay panels.
 *  Cleans up and removes any existing panel first — only one panel at a time. */
export function createPanelHost(): PanelHost {
  // Clean up previous panel's event listeners before removing DOM
  if (activePanelCleanup) {
    activePanelCleanup();
    activePanelCleanup = null;
  }
  const existing = document.getElementById("ht-panel-host");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ht-panel-host";
  host.tabIndex = -1;
  host.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;width:100dvw;height:100dvh;z-index:2147483647;pointer-events:auto;contain:layout style paint;overscroll-behavior:contain;isolation:isolate;";
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  // Reclaim focus when it escapes the panel (e.g. to browser chrome).
  // Must check both host.contains() and shadowRoot.contains() because
  // Shadow DOM children aren't found by host.contains().
  let reclaimId = 0;
  host.addEventListener("focusout", (e: FocusEvent) => {
    const related = e.relatedTarget as Node | null;
    const staysInPanel =
      related &&
      (host.contains(related) || host.shadowRoot!.contains(related));
    if (!staysInPanel) {
      cancelAnimationFrame(reclaimId);
      reclaimId = requestAnimationFrame(() => {
        if (document.getElementById("ht-panel-host")) {
          host.focus({ preventScroll: true });
        }
      });
    }
  });

  // Prevent clicks on the transparent backdrop from shifting focus behind the overlay
  host.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.target === host) {
      e.preventDefault();
    }
  });

  return { host, shadow };
}

export function removePanelHost(): void {
  const host = document.getElementById("ht-panel-host");
  if (host) host.remove();
}

/** Fully dismiss the active panel — cleanup listeners + remove DOM. */
export function dismissPanel(): void {
  if (activePanelCleanup) {
    activePanelCleanup();
    activePanelCleanup = null;
  }
  removePanelHost();
}

/** Generate the vim mode badge HTML for panel titlebars */
export function vimBadgeHtml(config: KeybindingsConfig): string {
  const isVim = config.navigationMode === "vim";
  return `<span class="ht-vim-badge ${isVim ? "on" : "off"}">vim</span>`;
}

/** Shared overlay shell styles used by all panels */
export function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :host {
      all: initial;
      --ht-font-mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
      --ht-color-bg: #1e1e1e;
      --ht-color-bg-elevated: #252525;
      --ht-color-bg-soft: #3a3a3c;
      --ht-color-bg-detail-focus: #1a2230;
      --ht-color-bg-detail-focus-header: #1e2a3a;
      --ht-color-bg-code: #1a1a1a;
      --ht-color-text: #e0e0e0;
      --ht-color-text-soft: #c0c0c0;
      --ht-color-text-muted: #808080;
      --ht-color-text-title: #a0a0a0;
      --ht-color-text-detail-focus: #a0c0e0;
      --ht-color-text-dim: #666;
      --ht-color-text-faint: #555;
      --ht-color-text-strong: #fff;
      --ht-color-accent: #0a84ff;
      --ht-color-accent-soft: rgba(10,132,255,0.1);
      --ht-color-accent-active: rgba(10,132,255,0.15);
      --ht-color-accent-soft-strong: rgba(10,132,255,0.12);
      --ht-color-accent-soft-faint: rgba(10,132,255,0.08);
      --ht-color-accent-alt: #af82ff;
      --ht-color-accent-alt-soft: rgba(175,130,255,0.15);
      --ht-color-success: #32d74b;
      --ht-color-tree-cursor: #4ec970;
      --ht-color-tree-cursor-bg: rgba(78,201,112,0.15);
      --ht-color-tree-cursor-bg-soft: rgba(78,201,112,0.18);
      --ht-color-tree-cursor-bg-strong: rgba(78,201,112,0.20);
      --ht-color-danger: #ff5f57;
      --ht-color-warning: #febc2e;
      --ht-color-mark-bg: #f9d45c;
      --ht-color-mark-fg: #1e1e1e;
      --ht-color-border: rgba(255,255,255,0.1);
      --ht-color-border-soft: rgba(255,255,255,0.06);
      --ht-color-border-faint: rgba(255,255,255,0.04);
      --ht-color-border-ultra-faint: rgba(255,255,255,0.03);
      --ht-color-hover: rgba(255,255,255,0.06);
      --ht-color-focus-active: rgba(255,255,255,0.13);
      --ht-color-surface: rgba(255,255,255,0.08);
      --ht-color-surface-dim: rgba(255,255,255,0.04);
      --ht-color-surface-strong: rgba(255,255,255,0.15);
      --ht-shadow-overlay: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
      --ht-radius: 10px;
      font-family: var(--ht-font-mono);
      font-size: 13px;
      color: var(--ht-color-text);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    .ht-backdrop {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      width: 100dvw; height: 100dvh;
      background: rgba(0, 0, 0, 0.55);
    }

    .ht-titlebar {
      display: flex; align-items: center;
      padding: 10px 14px;
      background: var(--ht-color-bg-soft);
      border-bottom: 1px solid var(--ht-color-border-soft);
      border-radius: var(--ht-radius) var(--ht-radius) 0 0;
      user-select: none;
    }
    .ht-traffic-lights {
      display: flex; gap: 7px; margin-right: 14px; flex-shrink: 0;
    }
    .ht-dot {
      width: 12px; height: 12px; border-radius: 50%;
      cursor: pointer; border: none;
      transition: filter 0.15s;
    }
    .ht-dot:hover { filter: brightness(1.2); }
    .ht-dot-close { background: var(--ht-color-danger); }
    .ht-titlebar-text {
      flex: 1; text-align: center; font-size: 12px;
      color: var(--ht-color-text-title); font-weight: 500;
    }

    .ht-vim-badge {
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 2px 6px; border-radius: 4px;
      text-transform: uppercase; flex-shrink: 0;
      line-height: 1; margin-left: 8px;
    }
    .ht-vim-badge.on {
      background: var(--ht-color-success); color: #1a1a1a;
    }
    .ht-vim-badge.off {
      background: var(--ht-color-surface); color: var(--ht-color-text-dim);
    }

    .ht-footer {
      display: flex; gap: 16px; padding: 8px 14px;
      background: var(--ht-color-bg-elevated); border-top: 1px solid var(--ht-color-border-soft);
      font-size: 11px; color: var(--ht-color-text-muted); flex-wrap: wrap;
      border-radius: 0 0 var(--ht-radius) var(--ht-radius); justify-content: center;
    }
    .ht-footer-row {
      display: flex; gap: 16px; justify-content: center; width: 100%; flex-wrap: wrap;
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
}
