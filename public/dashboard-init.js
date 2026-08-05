/**
 * @file public/dashboard-init.js
 * @description Dashboard bootstrap: wire the finder, the sync/Update controller,
 * and the Help menu (all work regardless of report state), then fetch the report
 * summary and render the data panels. Reads only the read-only GET endpoints.
 */

import { renderView } from "./dashboard-render.js";
import { initFinder } from "./dashboard-whereami.js";
import { initSync, noDataText } from "./dashboard-update.js";
import { initDisclaimer, initHelp } from "./dashboard-help.js";
import { initScanDetails } from "./dashboard-scan-details.js";
import { initSecrets, checkPreflight } from "./dashboard-secrets.js";

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
  // Veil the data-dependent region and show the status message above it. The
  // message text (idle vs. syncing) is owned by noDataText so the status poll
  // keeps it accurate as a sync starts or finishes.
  document.body.classList.add("no-report");
  status.hidden = false;
  try {
    const s = await (await fetch("/api/status")).json();
    status.textContent = noDataText(s.updating === true);
  } catch {
    status.textContent = noDataText(false);
  }
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
    document.body.classList.remove("no-report");
    status.hidden = true;
    for (const id of DATA_PANELS) document.getElementById(id).hidden = false;
    render();
  } catch (err) {
    document.body.classList.add("no-report");
    status.textContent = `Failed to load report: ${err.message}`;
  }
}

initTabs();
initFinder();
initSync();
initHelp();
initScanDetails();
initSecrets();
initDisclaimer();
void load();
void checkPreflight();
