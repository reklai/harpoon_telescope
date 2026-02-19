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
    "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:auto;";
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

/** Shared macOS Terminal.app styles used by all overlay panels */
export function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :host {
      all: initial;
      font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 13px;
      color: #e0e0e0;
    }

    .ht-backdrop {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.55);
    }

    .ht-titlebar {
      display: flex; align-items: center;
      padding: 10px 14px;
      background: #3a3a3c;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px 10px 0 0;
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
    .ht-dot-close { background: #ff5f57; }
    .ht-titlebar-text {
      flex: 1; text-align: center; font-size: 12px;
      color: #a0a0a0; font-weight: 500;
    }

    .ht-vim-badge {
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 2px 6px; border-radius: 4px;
      text-transform: uppercase; flex-shrink: 0;
      line-height: 1; margin-left: 8px;
    }
    .ht-vim-badge.on {
      background: #32d74b; color: #1a1a1a;
    }
    .ht-vim-badge.off {
      background: rgba(255,255,255,0.08); color: #666;
    }

    .ht-footer {
      display: flex; gap: 16px; padding: 8px 14px;
      background: #252525; border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 11px; color: #808080; flex-wrap: wrap;
      border-radius: 0 0 10px 10px; justify-content: center;
    }
    .ht-footer-row {
      display: flex; gap: 16px; justify-content: center; width: 100%; flex-wrap: wrap;
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
  `;
}
