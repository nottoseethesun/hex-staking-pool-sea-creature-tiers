/**
 * @file public/dashboard-update.js
 * @description Sync/status controller. Polls GET /api/status to drive the header
 * status badge, the header Sync button, and the finder "Update" button. The
 * badge always shows status — data freshness when idle, a live progress bar
 * while a sync runs. While a sync runs the header button toggles to "Stop Sync"
 * (POST /api/update/stop cancels it at the next checkpoint-safe boundary);
 * otherwise both triggers are enabled only when the cache is stale (a later UTC
 * day, or never synced) — the HEX pool rolls over at 00:00 UTC, so same-UTC-day
 * data has nothing to fetch. When a sync finishes, the page reloads to pick up
 * the report.
 */

let sawUpdating = false;
// Whether the last status poll saw a complete scan on disk — gates the "Re-Scan"
// label and the "Are You Sure?" confirm (a re-scan re-traces every OA wallet).
let lastHasCompleteScan = false;

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

/** Set exactly one freshness/state class on the badge. */
function setBadgeState(badge, state) {
  badge.classList.remove("is-syncing", "is-fresh", "is-stale");
  badge.classList.add(state);
}

/**
 * Set the header Sync/Stop button's label, enabled state, and tooltip.
 * @param {string} label button text ("Sync", "Re-Scan", or "Stop Sync")
 * @param {boolean} disabled
 * @param {string} [title]
 */
function setSyncBtn(label, disabled, title) {
  const btn = document.getElementById("syncBtn");
  btn.textContent = label;
  btn.disabled = disabled;
  if (title !== undefined) btn.title = title;
}

/**
 * Enable/disable the finder "Update" trigger (and optionally its tooltip).
 * @param {boolean} disabled
 * @param {string} [title]
 */
function setUpdateBtn(disabled, title) {
  const btn = document.getElementById("updateBtn");
  btn.disabled = disabled;
  if (title !== undefined) btn.title = title;
}

/**
 * Data-freshness label for the idle badge. Fresh vs stale flips at the UTC-day
 * boundary, so a stale cache is reported in whole UTC days behind.
 * @param {object} s
 * @returns {string}
 */
function idleLabel(s) {
  if (!s.hasCompleteScan) return "Not Synced Yet";
  if (!s.updateEnabled) return "Up to Date";
  const d = s.staleDays || 1;
  return `Stale · ${d} day${d === 1 ? "" : "s"} behind`;
}

/**
 * Tooltip for the sync triggers.
 * @param {object} s
 * @returns {string}
 */
function syncTitle(s) {
  if (!s.updateEnabled) return "Cache is current for today (UTC).";
  if (!s.hasCompleteScan) return "No local data yet — run the initial sync.";
  return "Cache is stale (a new UTC day) — sync to bring it current.";
}

/**
 * The status message shown while no report is loaded. Owned here (not set once
 * at render) so it tracks a sync starting or finishing.
 * @param {boolean} updating
 * @returns {string}
 */
export function noDataText(updating) {
  return updating
    ? "Initial scan in progress — the pool will appear here when it " +
        "finishes. Watch the progress badge above."
    : "No on-chain data yet. Use Sync (top-right) to scan Ethereum and " +
        "PulseChain; the first full scan takes a while.";
}

/**
 * Keep the no-data message accurate while no report is loaded; a no-op once a
 * report loads (the data panels own the screen then).
 * @param {object} s status object from /api/status
 */
function updateNoDataMessage(s) {
  if (!document.body.classList.contains("no-report")) return;
  document.getElementById("status").textContent = noDataText(s.updating);
}

/**
 * Apply a status object to the badge + sync buttons.
 * @param {object} s
 */
function applyStatus(s) {
  const badge = document.getElementById("syncBadge");
  const fill = badge.querySelector(".sync-fill");
  const label = badge.querySelector(".sync-label");
  badge.hidden = false;
  lastHasCompleteScan = Boolean(s.hasCompleteScan);
  updateNoDataMessage(s);
  if (s.updating) {
    sawUpdating = true;
    document.body.classList.add("syncing");
    setBadgeState(badge, "is-syncing");
    // While syncing, the header button becomes a live Stop control; the finder
    // Update trigger is disabled (one stop control is enough).
    setSyncBtn("Stop Sync", false, "Stop the running sync.");
    setUpdateBtn(true, "A sync is running.");
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
  fill.style.width = "0";
  if (sawUpdating) {
    sawUpdating = false;
    window.location.reload();
    return;
  }
  label.textContent = idleLabel(s);
  setBadgeState(
    badge,
    s.hasCompleteScan && !s.updateEnabled ? "is-fresh" : "is-stale",
  );
  setSyncBtn(
    s.hasCompleteScan ? "Re-Scan" : "Sync",
    !s.updateEnabled,
    syncTitle(s),
  );
  setUpdateBtn(!s.updateEnabled, syncTitle(s));
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

/** Trigger a sync, then resume polling. */
async function doSync() {
  setSyncBtn("Sync", true);
  setUpdateBtn(true);
  try {
    const res = await fetch("/api/update", { method: "POST" });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setSyncBtn("Sync", true, b.error || "Sync failed to start.");
    }
  } catch {
    // ignore; the next poll resyncs the button state
  }
  void poll();
}

/** Ask the server to stop the running sync, then resume polling. */
async function doStop() {
  setSyncBtn("Stopping…", true);
  try {
    await fetch("/api/update/stop", { method: "POST" });
  } catch {
    // ignore; the next poll resyncs the button state
  }
  void poll();
}

/** Show the "Are You Sure?" confirmation before an expensive full re-scan. */
function openRescanConfirm() {
  document.getElementById("rescanModal").hidden = false;
}

/** Hide the re-scan confirmation. */
function closeRescanConfirm() {
  document.getElementById("rescanModal").hidden = true;
}

/**
 * Start a sync, but when a complete scan already exists, confirm first — a
 * re-scan re-traces every OA wallet (the days-long cost), so it must not fire on
 * a stray click. The initial scan (no cache yet) starts without a prompt.
 */
function requestSync() {
  if (lastHasCompleteScan) openRescanConfirm();
  else void doSync();
}

/** Wire the sync triggers (header toggles start/stop) and start polling. */
export function initSync() {
  document.getElementById("syncBtn").addEventListener("click", () => {
    if (document.body.classList.contains("syncing")) void doStop();
    else requestSync();
  });
  document.getElementById("updateBtn").addEventListener("click", requestSync);
  document.getElementById("rescanConfirmBtn").addEventListener("click", () => {
    closeRescanConfirm();
    void doSync();
  });
  document
    .getElementById("rescanCancelBtn")
    .addEventListener("click", closeRescanConfirm);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("rescanModal").hidden) {
      closeRescanConfirm();
    }
  });
  void poll();
}
