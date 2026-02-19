// Center-screen toast notification for brief user feedback messages.

/** Show a temporary toast at the center of the screen, fading after 1.5s */
export function showFeedback(message: string): void {
  const existing = document.getElementById("ht-feedback-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ht-feedback-toast";
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    padding: "8px 20px",
    background: "#2d2d2d",
    color: "#e0e0e0",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
    fontFamily:
      "'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: "13px",
    zIndex: "2147483647",
    boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
    transition: "opacity 0.3s",
    opacity: "1",
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}
