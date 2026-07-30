/**
 * @file src/report/markdown.js
 * @description Renders out/report.md — the human-facing report. Each view (ETH,
 * PLS, Combined) gets a headline, the Sea Creature Table (designed so any staker
 * can find themselves by T-Share total), and a top-50 non-OA ranking. Written
 * from the summary object; no chain access.
 */

"use strict";

const { tsharesGrouped, formatPercent, groupThousands } = require("./format");
const { classify } = require("./leagues");
const { checksum } = require("../chain/address");

/** HEX shareRate is scaled by 1e5; Hearts per HEX is 1e8. */
const SHARE_RATE_SCALE = 100000n;
const HEARTS_PER_HEX = 100000000n;
const TOP_N = 50;

/**
 * Approximate HEX needed today to mint `sharesRaw` shares (orientation only).
 * @param {bigint} sharesRaw
 * @param {string} shareRate globalInfo shareRate
 * @returns {string}
 */
function hexForShares(sharesRaw, shareRate) {
  if (!shareRate || shareRate === "0") return "—";
  const hearts = (sharesRaw * BigInt(shareRate)) / SHARE_RATE_SCALE;
  return groupThousands((hearts / HEARTS_PER_HEX).toString());
}

/**
 * Strip trailing zeros (and a dangling dot) from a decimal string.
 * @param {string} s
 * @returns {string}
 */
function trimZeros(s) {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * The "% of pool" label for a tier.
 * @param {object} tier
 * @returns {string}
 */
function tierPctLabel(tier) {
  if (tier.id === "plankton") return "below Shell";
  return `${trimZeros(formatPercent(BigInt(tier.num), BigInt(tier.den), 7))}%`;
}

/**
 * Render the Sea Creature Table for a view.
 * @param {object[]} tiers
 * @param {string} poolNonOaStr
 * @param {string} shareRate
 * @returns {string[]}
 */
function renderTierTable(tiers, poolNonOaStr, shareRate) {
  const poolNonOa = BigInt(poolNonOaStr);
  const lines = [
    "| League | % of pool | Min T-Shares (≥) | ~HEX for a new stake today |" +
      " Wallets in tier | Cumulative wallets | Tier aggregate T-Shares |" +
      " Tier % of non-OA pool |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const t of tiers) {
    const minShares = BigInt(t.minShares);
    const tierShares = BigInt(t.tierShares);
    lines.push(
      `| ${t.emoji} ${t.name} | ${tierPctLabel(t)} |` +
        ` ${tsharesGrouped(minShares)} | ${hexForShares(minShares, shareRate)} |` +
        ` ${groupThousands(String(t.wallets))} |` +
        ` ${groupThousands(String(t.cumulativeWallets))} |` +
        ` ${tsharesGrouped(tierShares)} |` +
        ` ${formatPercent(tierShares, poolNonOa, 4)}% |`,
    );
  }
  return lines;
}

/**
 * Render the top-50 non-OA stakers table for a view.
 * @param {object} view
 * @param {Record<string, boolean>} contractFlags
 * @returns {string[]}
 */
function renderTop50(view, contractFlags) {
  const poolNonOa = BigInt(view.poolNonOaShares);
  const lines = [
    "| Rank | Address | T-Shares | League | Contract? |",
    "| ---: | --- | ---: | --- | :-: |",
  ];
  view.ranking.slice(0, TOP_N).forEach(([addr, s], i) => {
    const shares = BigInt(s);
    const league = classify(shares, poolNonOa);
    const flag = contractFlags[addr];
    const isC = flag === undefined ? "?" : flag ? "yes" : "no";
    lines.push(
      `| ${i + 1} | \`${checksum(addr)}\` | ${tsharesGrouped(shares)} |` +
        ` ${league.emoji} ${league.name} | ${isC} |`,
    );
  });
  return lines;
}

/**
 * Render one view section.
 * @param {string} title
 * @param {object} view
 * @param {string} shareRate
 * @param {Record<string, boolean>} contractFlags
 * @returns {string[]}
 */
function renderView(title, view, shareRate, contractFlags) {
  return [
    `## ${title} view`,
    "",
    `- Pool total: **${tsharesGrouped(BigInt(view.poolTotalShares))}** T-Shares`,
    `- OA cluster excluded: **${tsharesGrouped(BigInt(view.oaExcludedShares))}**` +
      ` T-Shares across ${groupThousands(String(view.oaStakerCount))} stakers`,
    `- Non-OA pool: **${tsharesGrouped(BigInt(view.poolNonOaShares))}**` +
      ` T-Shares across ${groupThousands(String(view.nonOaStakerCount))} stakers`,
    "",
    "### Sea Creature Table",
    "",
    ...renderTierTable(view.tiers, view.poolNonOaShares, shareRate),
    "",
    `### Top ${TOP_N} non-OA stakers`,
    "",
    ...renderTop50(view, contractFlags),
    "",
  ];
}

/**
 * Render the full report markdown.
 * @param {object} summary
 * @param {Record<string, boolean>} contractFlags
 * @returns {string}
 */
function renderMarkdown(summary, contractFlags) {
  const { chains, views } = summary;
  const lines = [
    "# HEX Sea-Creature League — Report",
    "",
    `> ${summary.disclaimer}`,
    "",
    "As-of (pinned tip, ~64 blocks behind head):",
    "",
    `- Ethereum: block ${chains.eth.block} (${chains.eth.timeUtc})`,
    `- PulseChain: block ${chains.pls.block} (${chains.pls.timeUtc})`,
    "",
    "Boundary rule: a wallet belongs to the highest tier whose **Min T-Shares**" +
      " it meets or exceeds (exact integer comparison; T-Shares shown to 3" +
      " decimals). Percent thresholds are of the non-OA staked pool.",
    "",
    ...renderView("Ethereum", views.eth, chains.eth.shareRate, contractFlags),
    ...renderView("PulseChain", views.pls, chains.pls.shareRate, contractFlags),
    ...renderView("Combined (ETH + PLS)", views.combined, null, contractFlags),
    "---",
    "",
    "Notes: `~HEX for a new stake today` is a rough orientation figure from the" +
      " current base share rate; Longer-Pays-Better / Bigger-Pays-Better bonuses" +
      " reduce the actual HEX required. The Combined view spans two share rates," +
      " so its ~HEX column is omitted. OA-cluster stakers are excluded from all" +
      " rankings and tiers; see `oa_wallets.csv` for the evidence-backed cluster.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

module.exports = {
  renderMarkdown,
  hexForShares,
  tierPctLabel,
  renderTierTable,
};
