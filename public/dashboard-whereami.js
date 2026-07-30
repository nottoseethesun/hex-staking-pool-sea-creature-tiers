/**
 * @file public/dashboard-whereami.js
 * @description "Find My Sea Creature Level": reads the T-Shares number, calls
 * GET /api/whereami (which reuses the server's lookup — no math in the browser),
 * and renders the result plus the distance to the next tier into a
 * fixed-height area (no layout shift). If the data is more than a week old, a
 * yellow warning dialog offers to Update first or proceed.
 */

const WEEK_HOURS = 24 * 7;

/**
 * Append a line of text to a container.
 * @param {HTMLElement} container
 * @param {string} text
 * @param {string} [className]
 */
function addLine(container, text, className) {
  const p = document.createElement("p");
  p.textContent = text;
  if (className) p.className = className;
  container.append(p);
}

/** Fetch the freshness status (best-effort). @returns {Promise<object>} */
async function fetchStatus() {
  try {
    return await (await fetch("/api/status")).json();
  } catch {
    return { hasCompleteScan: false, ageHours: null };
  }
}

/** Perform the lookup and render into the reserved result area. */
async function runFind() {
  const result = document.getElementById("whereResult");
  result.replaceChildren();
  const raw = document.getElementById("whereTshares").value.trim();
  const num = Number(raw);
  if (!raw || Number.isNaN(num) || num < 0) {
    addLine(result, "Enter your total T-Shares as a number.");
    return;
  }
  try {
    const res = await fetch(`/api/whereami?tshares=${encodeURIComponent(raw)}`);
    const data = await res.json();
    if (!res.ok) {
      addLine(result, data.error || "Lookup failed.");
      return;
    }
    const r = data.results.combined;
    addLine(
      result,
      `${r.league.emoji} ${r.league.name} — ${r.tshares} T-Shares`,
      "creature-line",
    );
    addLine(
      result,
      r.nextTier
        ? `${r.distanceToNextTier} more T-Shares to reach ${r.nextTier.emoji} ${r.nextTier.name}.`
        : "You are already in the top tier.",
      "next-line",
    );
  } catch (err) {
    addLine(result, `Lookup failed: ${err.message}`);
  }
}

/**
 * Open the stale-data warning dialog.
 * @param {() => void} onProceed
 */
function openStaleModal(onProceed) {
  const modal = document.getElementById("staleModal");
  modal.hidden = false;
  document.getElementById("staleProceedBtn").onclick = () => {
    modal.hidden = true;
    onProceed();
  };
  document.getElementById("staleUpdateBtn").onclick = () => {
    modal.hidden = true;
    document.getElementById("updateBtn").focus();
  };
}

/** Handle a find request, warning first if the data is over a week old. */
async function onFind() {
  const status = await fetchStatus();
  if (
    status.hasCompleteScan &&
    typeof status.ageHours === "number" &&
    status.ageHours > WEEK_HOURS
  ) {
    openStaleModal(() => void runFind());
  } else {
    void runFind();
  }
}

/** Wire the finder form. */
export function initFinder() {
  document.getElementById("whereForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void onFind();
  });
}
