/**
 * @file public/dashboard-help.js
 * @description The top-right Help menu, and the Disclaimer — which is both a
 * launch-gating modal (shown on every load with the app disabled behind it) and
 * a Help-menu item that re-opens the same text. Accepting ("I have read and
 * understood") unlocks the app; Cancel or the Escape key dismisses it, and on
 * first load that leaves the app disabled until the page is reloaded. The
 * disclaimer text comes from GET /api/disclaimer (single server-side source).
 */

let accepted = false;

/**
 * Close the help menu.
 * @param {HTMLElement} menu
 * @param {HTMLElement} btn
 */
function closeMenu(menu, btn) {
  menu.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

/** Fetch + cache the disclaimer text into the modal (once). */
async function populateDisclaimer() {
  const text = document.getElementById("discModalText");
  if (text.textContent) return;
  try {
    const d = await (await fetch("/api/disclaimer")).json();
    text.textContent = d.disclaimer || "";
  } catch {
    text.textContent = document.getElementById("disclaimer").textContent || "";
  }
}

/** Show the disclaimer modal (populating its text). */
function openDisclaimer() {
  void populateDisclaimer();
  document.getElementById("disclaimerModal").hidden = false;
}

/** True when the disclaimer modal is currently open. */
function disclaimerOpen() {
  return !document.getElementById("disclaimerModal").hidden;
}

/**
 * Dismiss the disclaimer without accepting (Cancel / Escape). On first load
 * (not yet accepted) this locks the app behind the "declined" overlay and the
 * user must reload to try again; after acceptance it simply closes.
 */
function dismissDisclaimer() {
  document.getElementById("disclaimerModal").hidden = true;
  if (!accepted) document.getElementById("lockOverlay").hidden = false;
}

/** Accept the disclaimer: unlock and reveal the app. */
function acceptDisclaimer() {
  accepted = true;
  document.getElementById("disclaimerModal").hidden = true;
  document.getElementById("lockOverlay").hidden = true;
  document.body.classList.remove("locked");
}

/**
 * Show the launch-gating disclaimer and wire its controls, including Escape to
 * dismiss. Called once on load; the page ships with body.locked so the app is
 * inert until the disclaimer is accepted.
 */
export function initDisclaimer() {
  document
    .getElementById("discAcceptBtn")
    .addEventListener("click", acceptDisclaimer);
  document
    .getElementById("discCancelBtn")
    .addEventListener("click", dismissDisclaimer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && disclaimerOpen()) dismissDisclaimer();
  });
  openDisclaimer();
}

/** Open the "How It Works" modal. */
function openHow() {
  document.getElementById("howModal").hidden = false;
}

/** Close the "How It Works" modal. */
function closeHow() {
  document.getElementById("howModal").hidden = true;
}

/** Wire the Help menu and its "How It Works" + Disclaimer items. */
export function initHelp() {
  const btn = document.getElementById("helpBtn");
  const menu = document.getElementById("helpMenu");
  btn.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.getElementById("showHowBtn").addEventListener("click", () => {
    closeMenu(menu, btn);
    openHow();
  });
  document.getElementById("tsharesInfoBtn").addEventListener("click", openHow);
  document.getElementById("howCloseBtn").addEventListener("click", closeHow);
  document.getElementById("showDisclaimerBtn").addEventListener("click", () => {
    closeMenu(menu, btn);
    openDisclaimer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("howModal").hidden) {
      closeHow();
    }
  });
  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      closeMenu(menu, btn);
    }
  });
}
