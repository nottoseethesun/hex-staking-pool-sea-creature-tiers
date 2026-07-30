/**
 * @file public/dashboard-render.js
 * @description Renders a view's headline, Sea Creature Table, and top-50 from
 * the pre-formatted `display` block in summary.json. Builds every cell with
 * createElement + textContent (no innerHTML) and does no BigInt/number
 * formatting — all display strings come from the server.
 */

/**
 * Set an element's text by id.
 * @param {string} id
 * @param {string} text
 */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * Build a table cell.
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLTableCellElement}
 */
function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

/**
 * Render the headline stats.
 * @param {object} summary
 * @param {object} d display block
 */
function renderHeadline(summary, d) {
  setText(
    "asofEth",
    `block ${summary.chains.eth.block} · ${summary.chains.eth.timeUtc}`,
  );
  setText(
    "asofPls",
    `block ${summary.chains.pls.block} · ${summary.chains.pls.timeUtc}`,
  );
  setText("poolTotal", `${d.poolTotalTShares} T-Shares`);
  setText("poolNonOa", `${d.poolNonOaTShares} T-Shares`);
  setText(
    "oaExcluded",
    `${d.oaExcludedTShares} T-Shares (${d.oaStakerCount} stakers)`,
  );
  setText("stakerCount", d.nonOaStakerCount);
}

/**
 * Render the tier table rows.
 * @param {object[]} tiers
 */
function renderTiers(tiers) {
  const body = document.getElementById("tierBody");
  body.replaceChildren();
  for (const t of tiers) {
    const tr = document.createElement("tr");
    tr.append(
      cell(t.league, "tier-name"),
      cell(t.pct),
      cell(t.minTShares),
      cell(t.wallets),
      cell(t.cumulativeWallets),
      cell(t.tierTShares),
      cell(t.tierPct),
    );
    body.append(tr);
  }
}

/**
 * Render the top-50 rows.
 * @param {object[]} top
 */
function renderTop(top) {
  const body = document.getElementById("topBody");
  body.replaceChildren();
  for (const row of top) {
    const tr = document.createElement("tr");
    tr.append(
      cell(String(row.rank)),
      cell(row.addr, "mono"),
      cell(row.tshares),
      cell(row.league),
    );
    body.append(tr);
  }
}

/**
 * Render an entire view.
 * @param {object} summary
 * @param {string} view eth | pls | combined
 */
export function renderView(summary, view) {
  const d = summary.views[view].display;
  renderHeadline(summary, d);
  renderTiers(d.tiers);
  renderTop(d.top);
}
