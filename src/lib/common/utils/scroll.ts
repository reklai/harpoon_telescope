// Scroll-to-text and temporary highlight for navigating to grep matches.
// Accepts an optional WeakRef<Node> to skip the DOM walk when a cached
// reference is available from the line cache.

/** Scroll the page to the first text node containing the given text,
 *  positioned at 1/3 from the top of the viewport.
 *  If nodeRef is provided and still alive, skips the DOM tree walk. */
export function scrollToText(text: string, nodeRef?: WeakRef<Node>): void {
  if (!text) return;

  // Fast path: use cached node reference
  const cached = nodeRef?.deref();
  if (cached) {
    const el = cached instanceof HTMLElement
      ? cached
      : cached.parentElement;
    if (el && document.body.contains(el)) {
      scrollToElement(el, text);
      return;
    }
  }

  // Slow path: walk all text nodes to find the target
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.includes(text)) {
      scrollToElement(node, text);
      return;
    }
  }
}

/** Scroll a node into view and apply a temporary highlight */
function scrollToElement(node: Node, text: string): void {
  const range = document.createRange();
  // For element nodes, select contents; for text nodes, select the node itself
  if (node.nodeType === Node.TEXT_NODE) {
    range.selectNodeContents(node);
  } else {
    // HTMLElement — find the text node inside
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      if (textNode.textContent?.includes(text)) {
        range.selectNodeContents(textNode);
        highlightTextNode(textNode, text);
        const rect = range.getBoundingClientRect();
        window.scrollTo({
          top: window.scrollY + rect.top - window.innerHeight / 3,
          behavior: "smooth",
        });
        return;
      }
    }
    // Fallback: scroll to the element itself
    range.selectNodeContents(node);
  }

  const rect = range.getBoundingClientRect();
  window.scrollTo({
    top: window.scrollY + rect.top - window.innerHeight / 3,
    behavior: "smooth",
  });

  if (node.nodeType === Node.TEXT_NODE) {
    highlightTextNode(node, text);
  }
}

/** Temporarily wrap matched text in a yellow <mark>, fading out after 2s */
function highlightTextNode(node: Node, text: string): void {
  const parent = node.parentElement;
  if (!parent) return;
  const content = node.textContent || "";
  const idx = content.indexOf(text);
  if (idx === -1) return;

  const range = document.createRange();
  range.setStart(node, idx);
  range.setEnd(node, idx + text.length);

  const highlight = document.createElement("mark");
  Object.assign(highlight.style, {
    background: "#f9d45c",
    color: "#1e1e1e",
    borderRadius: "3px",
    padding: "0 2px",
    transition: "opacity 0.5s",
  });

  try {
    range.surroundContents(highlight);
    setTimeout(() => {
      highlight.style.opacity = "0";
      setTimeout(() => {
        const textNode = document.createTextNode(highlight.textContent || "");
        highlight.parentNode?.replaceChild(textNode, highlight);
        // Normalize to prevent text node fragmentation on subsequent searches
        textNode.parentNode?.normalize();
      }, 500);
    }, 2000);
  } catch (_) {
    // Can fail on complex DOM structures (e.g. crossing element boundaries)
  }
}
