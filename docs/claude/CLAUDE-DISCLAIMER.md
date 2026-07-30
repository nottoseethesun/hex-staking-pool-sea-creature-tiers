# Disclaimer

The single source of the disclaimer text is `src/disclaimer.js`. Edit the wording
there only; it flows unchanged to the CLI (a one-line notice), the dashboard
footer (via `GET /api/summary`), the README, and this document.

## Current text

> This application provides purely educational and informational content
> assembled from public on-chain data. It does not attempt to provide market
> intelligence, actionable or otherwise. The underlying data may be incomplete,
> delayed, or incorrect. Nothing that this application provides or contains is or shall
> be considered to be financial, investment, tax, or legal advice, nor any
> recommendation, suggestion, or inducement to buy, sell, or hold any asset. It is
> not affiliated with, endorsed by, or sponsored by HEX or its creators. This is
> read-only software: it holds no private keys, custodies no funds, and sends no
> transactions. It is provided "as is", without warranty of any kind.

## Editorial discipline

- The framing is deliberate: **educational and informational only, not market
  intelligence, and never financial advice or an inducement to trade.** Do not
  soften or reframe it into investment guidance.
- Because the tool is read-only and unaffiliated, there is no broker-dealer,
  custody, fee, or MEV surface — do not import that kind of language.
- Keep the one-line CLI notice and the full text consistent; both derive from
  `src/disclaimer.js`.
