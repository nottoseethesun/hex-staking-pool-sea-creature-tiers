/**
 * @file public/dashboard-init.js
 * @description Dashboard bootstrap: wire the finder, the sync/Update controller,
 * and the Help menu (all work regardless of report state), then fetch the report
 * summary and render the data panels. Reads only the read-only GET endpoints.
 */

import { renderView } from "./dashboard-render.js";
import { initFinder } from "./dashboard-whereami.js";
import { initSync } from "./dashboard-update.js";
import { initDisclaimer, initHelp } from "./dashboard-help.js";

const DATA_PANELS = ["headlinePanel", "tierPanel", "topPanel"];

let summary = null;
let currentView = "combined";

/** Render the current view if data is loaded. */
function render() {
  if (summary) renderView(summary, currentView);
}

/** Wire the ETH / PLS / Combined tabs. */
function initTabs() {
  const tabs = document.querySelectorAll(".view-tab");
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      currentView = btn.dataset.view;
      for (const b of tabs) b.classList.toggle("is-active", b === btn);
      render();
    });
  }
}

/**
 * Render the honest "no data yet" state. Never invents numbers — the data
 * panels stay hidden until a real report exists — and adapts to whether an
 * initial sync is running, so it never says "click Sync" mid-sync.
 * @param {HTMLElement} status
 */
async function showNoData(status) {
  let updating = false;
  try {
    const s = await (await fetch("/api/status")).json();
    updating = s.updating === true;
  } catch {
    // Best-effort; fall back to the idle message.
  }
  const running =
    "Initial scan in progress — the pool will appear here when it " +
    "finishes. Watch the progress badge above.";
  const idle =
    "No on-chain data yet. Use Sync (top-right) to scan Ethereum and " +
    "PulseChain; the first full scan takes a while.";
  status.textContent = updating ? running : idle;
}

/** Fetch the summary and populate the data panels. */
async function load() {
  const status = document.getElementById("status");
  try {
    const res = await fetch("/api/summary");
    if (!res.ok) {
      await showNoData(status);
      return;
    }
    summary = await res.json();
    document.getElementById("disclaimer").textContent =
      summary.disclaimer || "";
    document.getElementById("buildInfo").textContent =
      `Ethereum tip ${summary.chains.eth.block} · PulseChain tip ${summary.chains.pls.block}`;
    status.hidden = true;
    for (const id of DATA_PANELS) document.getElementById(id).hidden = false;
    render();
  } catch (err) {
    status.textContent = `Failed to load report: ${err.message}`;
  }
}

initTabs();
initFinder();
initSync();
initHelp();
initDisclaimer();
void load();
