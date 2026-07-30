/**
 * @file public/dashboard-update.js
 * @description Sync/status controller. Polls GET /api/status to drive the header
 * status badge and the two sync triggers (the header "Sync" button and the
 * finder "Update" button). The badge always shows status — data freshness when
 * idle, a live progress bar while a sync runs. Both buttons are enabled only when
 * the cache is stale (a later UTC day than the cache, or never synced) and not
 * already syncing; the HEX pool rolls over at 00:00 UTC, so same-UTC-day data has
 * nothing to fetch. When a sync finishes, the page reloads to pick up the report.
 */

let sawUpdating = false;

/** The two sync triggers, kept in lock-step. */
const SYNC_BUTTON_IDS = ["syncBtn", "updateBtn"];

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
 * Enable/disable both sync triggers together (and optionally set their tooltip).
 * @param {boolean} disabled
 * @param {string} [title]
 */
function setSyncButtons(disabled, title) {
  for (const id of SYNC_BUTTON_IDS) {
    const btn = document.getElementById(id);
    btn.disabled = disabled;
    if (title !== undefined) btn.title = title;
  }
}

/**
 * Data-freshness label for the idle badge. Fresh vs stale flips at the UTC-day
 * boundary, so a stale cache is reported in whole UTC days behind.
 * @param {object} s
 * @returns {string}
 */
function idleLabel(s) {
  if (!s.hasCompleteScan) return "Not Synced Yet";
  if (!s.updateEnabled) return "Up to date";
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
 * Apply a status object to the badge + sync buttons.
 * @param {object} s
 */
function applyStatus(s) {
  const badge = document.getElementById("syncBadge");
  const fill = badge.querySelector(".sync-fill");
  const label = badge.querySelector(".sync-label");
  badge.hidden = false;
  if (s.updating) {
    sawUpdating = true;
    document.body.classList.add("syncing");
    setBadgeState(badge, "is-syncing");
    setSyncButtons(true); // already syncing
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
  setSyncButtons(!s.updateEnabled, syncTitle(s));
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
  setSyncButtons(true);
  try {
    const res = await fetch("/api/update", { method: "POST" });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setSyncButtons(true, b.error || "Sync failed to start.");
    }
  } catch {
    // ignore; the next poll resyncs the button state
  }
  void poll();
}

/** Wire both sync triggers and start polling. */
export function initSync() {
  for (const id of SYNC_BUTTON_IDS) {
    document.getElementById(id).addEventListener("click", () => void doSync());
  }
  void poll();
}
