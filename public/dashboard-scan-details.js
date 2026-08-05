/**
 * @file public/dashboard-scan-details.js
 * @description The Help -> "Scan Details" dialog. On open it fetches the
 * read-only GET /api/summary and renders, per chain, the pinned "scan tip"
 * (block number + the block's UTC time) plus scan statistics — including the OA
 * candidate-wallet count and the last measured OA inbound-sweep duration, which
 * together are the dominant cost of a re-scan. Every value comes straight from
 * the cache; nothing is invented (missing figures render as "—" / "not yet
 * measured") and opening the dialog never triggers a scan. DOM is built with
 * textContent / createElement (no interpolated innerHTML) per the dashboard XSS
 * rule.
 */

const CHAIN_LABELS = { eth: "Ethereum", pls: "PulseChain" };
const CHAINS = ["eth", "pls"];

/**
 * Group an integer with thousands separators, or "—" when absent.
 * @param {number|null|undefined} n
 * @returns {string}
 */
function fmtInt(n) {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}

/**
 * Format an ISO timestamp as "YYYY-MM-DD HH:MM UTC", or "—" when absent.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function fmtUtc(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Format a millisecond duration as "Hh Mm" / "Mm Ss", or "not yet measured".
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function fmtDuration(ms) {
  if (typeof ms !== "number" || ms <= 0) return "not yet measured";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/**
 * A table row: a label header cell plus one value cell per chain.
 * @param {string} label
 * @param {string[]} values
 * @returns {HTMLTableRowElement}
 */
function row(label, values) {
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.scope = "row";
  th.textContent = label;
  tr.appendChild(th);
  for (const v of values) {
    const td = document.createElement("td");
    td.textContent = v;
    tr.appendChild(td);
  }
  return tr;
}

/** Build the table head (Statistic | Ethereum | PulseChain). */
function buildHead() {
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const h of ["Statistic", ...CHAINS.map((c) => CHAIN_LABELS[c])]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

/**
 * Build the scan-details table from a summary object.
 * @param {object} summary out/summary.json contents
 * @returns {HTMLElement}
 */
function buildTable(summary) {
  const scan = (c) => (summary.scan || {})[c] || {};
  const view = (c) => (summary.views || {})[c] || {};
  const tip = (c) => (summary.chains || {})[c] || {};
  const day = (c) =>
    tip(c).currentDay ? fmtInt(Number(tip(c).currentDay)) : "—";
  const sweep = (c) =>
    fmtDuration(scan(c).oaSweep && scan(c).oaSweep.inboundMs);

  const rows = [
    ["Scan tip block", CHAINS.map((c) => fmtInt(tip(c).block))],
    ["Tip block time (UTC)", CHAINS.map((c) => fmtUtc(tip(c).timeUtc))],
    ["HEX day", CHAINS.map(day)],
    ["Non-OA stakers", CHAINS.map((c) => fmtInt(view(c).nonOaStakerCount))],
    ["OA wallets excluded", CHAINS.map((c) => fmtInt(view(c).oaStakerCount))],
    [
      "OA candidate wallets",
      CHAINS.map((c) => fmtInt(scan(c).candidateStakerCount)),
    ],
    ["Blocks scanned (span)", CHAINS.map((c) => fmtInt(scan(c).blockSpan))],
    ["Last OA sweep", CHAINS.map(sweep)],
  ];

  const wrap = document.createElement("div");
  wrap.className = "table-scroll";
  const table = document.createElement("table");
  table.appendChild(buildHead());
  const tbody = document.createElement("tbody");
  for (const [label, values] of rows) tbody.appendChild(row(label, values));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** Render the dialog body from /api/summary, or an honest empty state. */
async function renderScanDetails() {
  const body = document.getElementById("scanDetailsBody");
  body.replaceChildren();
  let summary;
  try {
    const res = await fetch("/api/summary");
    if (!res.ok) throw new Error("no report");
    summary = await res.json();
  } catch {
    const p = document.createElement("p");
    p.textContent =
      "No completed scan yet. Run a Sync first, then reopen Scan Details.";
    body.appendChild(p);
    return;
  }
  body.appendChild(buildTable(summary));
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    "A re-scan extends the scan over only the new blocks — it never re-reads " +
    "from the deploy block. It still re-checks the OA cluster's wallets (the " +
    "dominant cost), so the time scales with the gap since the last scan. " +
    '"Last OA sweep" is the measured time of the most recent sweep.';
  body.appendChild(note);
}

/** Open the Scan Details dialog (rendering fresh from /api/summary). */
function openScanDetails() {
  void renderScanDetails();
  document.getElementById("scanDetailsModal").hidden = false;
}

/** Close the Scan Details dialog. */
function closeScanDetails() {
  document.getElementById("scanDetailsModal").hidden = true;
}

/** Wire the Help -> Scan Details menu item, its close button, and Escape. */
export function initScanDetails() {
  const menu = document.getElementById("helpMenu");
  const helpBtn = document.getElementById("helpBtn");
  document
    .getElementById("showScanDetailsBtn")
    .addEventListener("click", () => {
      menu.hidden = true;
      helpBtn.setAttribute("aria-expanded", "false");
      openScanDetails();
    });
  document
    .getElementById("scanDetailsCloseBtn")
    .addEventListener("click", closeScanDetails);
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      !document.getElementById("scanDetailsModal").hidden
    ) {
      closeScanDetails();
    }
  });
}
