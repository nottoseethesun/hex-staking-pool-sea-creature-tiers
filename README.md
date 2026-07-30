# HEX Sea-Creature League — Where Do You Swim?

[![CI](https://img.shields.io/github/actions/workflow/status/nottoseethesun/hex-staking-pool-sea-creature-tiers/ci.yml?branch=main&label=lint%20%2B%20tests)](../../actions/workflows/ci.yml)
[![Security Audit](https://img.shields.io/github/actions/workflow/status/nottoseethesun/hex-staking-pool-sea-creature-tiers/security-audit.yml?branch=main&label=security)](../../actions/workflows/security-audit.yml)

## Overview

**HEX Sea-Creature League** is a self-hosted, read-only tool that reads the HEX
contract on [Ethereum](https://ethereum.org) and
[PulseChain](https://pulsechain.com) directly over JSON-RPC, adds up every active
stake's T-Shares per wallet, sets aside the Origin-Address (OA) funding cluster,
and shows you the **sea-creature league** breakdown of the staking pool — for
Ethereum, PulseChain, and the two combined.

Every staker can find themselves in the **Sea Creature Table** from their own
T-Share total, from 🔱 Prosperous Poseidon at the top down through 🐋 Winning
Whale, 🦈 Super Shark, 🐬 Dabbing Dolphin, 🦑 Swifty Squid, 🐢 Tinkering Turtle,
🦀 Cool Crab, 🦐 Shy Shrimp, 🐚 Silent Shell, and 🦠 Plankton.

You run the software yourself, on your own machine, reading only public chain
data. It holds no keys, custodies no funds, and sends no transactions. The code
is open source and free to inspect, use, and modify ([License](#license)).

## Table of Contents

- [Overview](#overview)
- [Disclaimer](#disclaimer)
- [Screenshot](#screenshot)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Optional: Verify Download](#optional-verify-download)
- [Update](#update)
- [Uninstall](#uninstall)
- [Usage](#usage)
- [Configure](#configure)
- [Lint & Test](#lint--test)
- [Security](#security)
- [Development](#development)
- [License](#license)
- [Road Map](#road-map)
- [Donations](#donations)
- [Contributing](#contributing)

---

## Disclaimer

This application provides purely educational and informational content assembled
from public on-chain data. It does not attempt to provide market intelligence,
actionable or otherwise. The underlying data may be incomplete, delayed, or
incorrect. Nothing that this application provides or contains is or shall be
considered to be financial, investment, tax, or legal advice, nor any
recommendation, suggestion, or inducement to buy, sell, or hold any asset. It is
not affiliated with, endorsed by, or sponsored by HEX or its creators. This is
read-only software: it holds no private keys, custodies no funds, and sends no
transactions. It is provided "as is", without warranty of any kind.

---

## Screenshot

The dashboard shows the three league views over a HEX-brand night sky with a
sunrise horizon. Run `npm start` after generating a report to see it locally.

---

## Prerequisites

This is a **batch job**: it performs long, incremental scans and then serves a
static local dashboard. It is not latency-sensitive, so modest hardware is fine.

- Skills: only very basic Terminal ("shell") skills.
- Machine: any common 64-bit computer. A **Raspberry Pi 5** (with heat sink/fan,
  wired Ethernet) is a representative example of the *minimum* hardware — it is
  cited only to indicate the low bar, not as a guarantee.
- [Node.js](https://nodejs.org) 22+.
- A web browser (for the dashboard).
- Network access to two public RPC endpoints (defaults are provided).

---

## Install

### Production

```bash
# From an extracted release directory:
npm ci        # install exact pinned dependencies
# Optional: copy .env.example to .env only to override a default.
```

### Development

```bash
git clone https://github.com/nottoseethesun/hex-staking-pool-sea-creature-tiers.git
cd hex-staking-pool-sea-creature-tiers
npm install
cp .env.example .env   # optional
```

---

## Optional: Verify Download

If you downloaded a release tarball plus its `.sha256` sidecar, verify it before
trusting the code:

```bash
sha256sum -c hex-staking-pool-sea-creature-tiers-[version].tar.gz.sha256
```

You should see `OK`. Any other output means do not proceed — delete and
re-download.

---

## Update

Because the on-chain cache under `data/` is immutable, upgrading is safe and
re-runs are cheap. Extract the new release next to the old one, copy your `.env`
(and, if you want to keep the cache, your `data/` and `out/` directories)
forward, then `npm ci`. A fresh install simply re-scans from the deploy block on
first run.

---

## Uninstall

Stop the dashboard (Ctrl+C), then remove the directory:

```bash
rm -rf hex-staking-pool-sea-creature-tiers*
```

Nothing is written outside the project directory.

---

## Usage

After installing:

1. **First run only** — build the initial data set from the chain. This one
   command runs the full scan (it takes a while the first time and safely
   resumes from its last checkpoint if interrupted):

   ```bash
   node bin/hexleague.js update
   ```

2. **Start the dashboard:**

   ```bash
   npm start   # then open http://127.0.0.1:3693
   ```

3. **Find your sea creature.** Enter your total HEX staking-pool T-Shares (or a
   wallet address) and click **Find My Sea Creature Level**. The dashboard shows
   the Ethereum, PulseChain, and Combined league views. Once the data is more
   than 24 hours old, the in-dashboard **Update** button refreshes it in place,
   with a pulsing **Syncing** badge showing live progress.

> **Data freshness.** Much of the on-chain data may already be cached — so you
> can start right away, though it can be stale. Click the dashboard's **Update**
> button any time: it fetches only the remaining blocks needed to bring your
> local cache up to date.

### Command line, configuration & HTTP API

Everything the dashboard does is also available headless — the granular
`verify → scan → oa → report → whereami` command-line pipeline, all
configuration and RPC-failover options, and a **full read-only HTTP API** so
other applications can pull in a staker's sea-creature level programmatically.
See **[docs/server.md](docs/server.md)**.

---

## Configure

No configuration is required — every value has a working default. Most dashboard
users only ever set `PORT` or `HOST`, by copying `.env.example` to `.env` and
editing it. For the full set of tunables, RPC failover and backup endpoints, and
the HTTP API, see **[docs/server.md](docs/server.md)**.

---

## Lint & Test

```bash
npm run lint     # ESLint + Stylelint + html-validate + markdownlint + prettier + actionlint
npm test         # node --test
npm run check    # the full gate (lint + security audits + tests + coverage)
```

---

## Security

This tool is **read-only**. It never holds a private key, never custodies funds,
and never sends a transaction, so the wallet/fund-safety attack surface simply
does not exist here. Supply-chain hygiene is still enforced: `npm run check`
(and CI) run dependency-CVE, security-lint, and secret-scan audits. See
[docs/claude/CLAUDE-SECURITY.md](docs/claude/CLAUDE-SECURITY.md).

---

## Development

For the architecture and the engineering internals, see
[docs/architecture.md](docs/architecture.md) and
[docs/engineering.md](docs/engineering.md). The OA-wallet methodology is
documented in detail in
[docs/oa-wallet-estimation.md](docs/oa-wallet-estimation.md), and the full
functional specification in
[docs/hex-sea-creature-league-spec.md](docs/hex-sea-creature-league-spec.md).

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

---

## Road Map

Presented for direction only, with no commitment:

| Item | Description |
| ---- | ----------- |
| Historical snapshots | Optionally retain per-tip summaries to chart league drift over time. |
| Contract-staker labeling | Resolve known pooled-staking contracts (Maximus, Hedron) to friendlier labels. |
| Configurable ladders | Allow alternate threshold ladders alongside the canonical one. |

---

## Donations

If this tool is useful to you and you'd like to support its development,
donations are welcome on any EVM chain at:

`0x0000000000000000000000000000000000000000`

(Replace with your own address before publishing.)

---

## Contributing

Bug reports and ideas are welcome via the repository's Issues and Discussions.
Because this is a read-only analysis tool, correctness of the on-chain
accounting is the highest priority — please include enough detail to reproduce
any discrepancy.
