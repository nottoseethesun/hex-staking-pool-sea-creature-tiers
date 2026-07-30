/**
 * @file src/disclaimer.js
 * @description Single source of truth for the app's disclaimer text. Consumed
 * by the CLI, by the dashboard server (which serves it to the browser so the
 * client never re-states it), by the README, and by
 * docs/claude/CLAUDE-DISCLAIMER.md. Edit the wording HERE only.
 */

"use strict";

/** The disclaimer as ordered sentences (render as one or more paragraphs). */
const DISCLAIMER_SENTENCES = [
  "This application provides purely educational and informational content assembled from public on-chain data.",
  "It does not attempt to provide market intelligence, actionable or otherwise.",
  "The underlying data may be incomplete, delayed, or incorrect.",
  "Nothing that this application provides or contains is or shall be considered to be financial, investment, tax, or legal advice, nor any recommendation, suggestion, or inducement to buy, sell, or hold any asset.",
  "It is not affiliated with, endorsed by, or sponsored by HEX or its creators.",
  "This is read-only software: it holds no private keys, custodies no funds, and sends no transactions.",
  'It is provided "as is", without warranty of any kind.',
];

/** The full disclaimer as a single paragraph. */
const DISCLAIMER = DISCLAIMER_SENTENCES.join(" ");

/** A short one-line notice suitable for CLI output. */
const DISCLAIMER_SHORT =
  "Educational and informational only — not financial advice, and no inducement to buy, sell, or hold any asset; data may be incomplete or incorrect.";

module.exports = { DISCLAIMER, DISCLAIMER_SENTENCES, DISCLAIMER_SHORT };
