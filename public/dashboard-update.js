/**
 * @file public/dashboard-update.js
 * @description Sync/status controller. Polls GET /api/status to drive the
 * Update button state (enabled only when a complete scan exists and the data is
 * over 24h old), and — while an update runs — disables the UI and shows the
 * pulsing "Syncing" badge doubling as a progress bar. When an update finishes,
 * the page reloads to pick up the fresh report.
 */

let sawUpdating = false;

/**
 * Format a duration in seconds as hrs:min (e.g. 5025 -> "1:23").
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatHrsMin(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/**
 * Apply a status object to the badge + Update button.
 * @param {object} s
 */
function applyStatus(s) {
  const badge = document.getElementById("syncBadge");
  const fill = badge.querySelector(".sync-fill");
  const label = badge.querySelector(".sync-label");
  const updateBtn = document.getElementById("updateBtn");
  if (s.updating) {
    sawUpdating = true;
    document.body.classList.add("syncing");
    badge.hidden = false;
    // Combined progress across both chains + report; no per-phase text. Show a
    // decimal below 10% so slow early stages (the full-range OA scans) visibly
    // move rather than sitting on a rounded "0%".
    const pctNum = (s.progress || 0) * 100;
    const pct =
      pctNum > 0 && pctNum < 10
        ? pctNum.toFixed(1)
        : String(Math.round(pctNum));
    fill.style.width = `${pct}%`;
    const eta =
      typeof s.etaSeconds === "number"
        ? ` · ~${formatHrsMin(s.etaSeconds)} left`
        : "";
    label.textContent = `Syncing… ${pct}%${eta}`;
    return;
  }
  document.body.classList.remove("syncing");
  badge.hidden = true;
  if (sawUpdating) {
    sawUpdating = false;
    window.location.reload();
    return;
  }
  updateBtn.textContent = "Update";
  updateBtn.disabled = !s.updateEnabled;
  updateBtn.title = s.updateEnabled
    ? "Bring the on-chain data up to date."
    : s.reason || "Update is not available yet.";
}

/** Schedule the next poll. @param {number} ms */
function schedule(ms) {
  setTimeout(() => void poll(), ms);
}

/** Poll status and reschedule. */
async function poll() {
  try {
    const s = await (await fetch("/api/status")).json();
    applyStatus(s);
    schedule(s.updating ? 1500 : 20000);
  } catch {
    schedule(8000);
  }
}

/** Trigger an update, then resume polling. */
async function doUpdate() {
  const btn = document.getElementById("updateBtn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/update", { method: "POST" });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      btn.title = b.error || "Update failed to start.";
    }
  } catch {
    // ignore; the next poll resyncs the button state
  }
  void poll();
}

/** Wire the Update button and start polling. */
export function initSync() {
  document
    .getElementById("updateBtn")
    .addEventListener("click", () => void doUpdate());
  void poll();
}
