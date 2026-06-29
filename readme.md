
# Beacon

**Beacon** is a full-featured indexer and metadata API for the XRP Ledger. It tracks every asset class — IOU & MPT tokens, AMM pools, Single-Asset Vaults, Price Oracles, and full NFT (XLS-20) discovery with collections, floor/volume metrics and off-chain metadata — and serves it over a JSON REST and WebSocket API, just like [rippled](https://github.com/XRPLF/rippled). It connects to one or multiple rippled or [clio](https://github.com/XRPLF/clio) nodes, tracks updates in real time, and backfills historical data.

## Credits & attribution

Beacon is a fork of **[xrplmeta](https://github.com/xrplmeta/node)** — the XRP Ledger metadata node — and full credit for the original project and its foundational architecture goes to its author. Beacon builds on that foundation with substantial additions: full NFT discovery (collections, supply/holders/floor/volume metrics, off-chain XLS-24 metadata and a hard-capped, LRU-evicting image cache), activated AMM / Vault / Oracle indexing, a worker-thread API layer, and extensive correctness, performance and security hardening.

> **Licensing note:** the upstream xrplmeta project publishes no explicit license, so its code is under default copyright ("all rights reserved"). Beacon is offered in good faith as an attributed derivative. If you plan to redistribute or operate it, please respect the original author's rights and consider contacting them to clarify licensing terms.



📖 **API reference → [`docs/api.md`](docs/api.md)** — the NFT discovery, AMM, and pool-aware endpoints. (Inherited token/ledger endpoints follow the upstream [xrplmeta API](https://xrplmeta.org/docs).)

## Technical Overview

On the first launch
- The server will create its SQLite database files in the config specified data directory
- It will then create a full snapshot of the most recent ledger

From there on
- It will sync itself with the live transaction stream
- Backfill ledger history simultaneously
- Scrape additional metadata sources, such as [Bithomp](https://bithomp.com), [XRP Scan](https://xrpscan.com) and [Xaman](https://xaman.dev)

The indexer also tracks AMM pools, Single-Asset Vaults, and Price Oracles, and is designed to handle new XRPL amendments gracefully — unknown ledger entry types are recorded for follow-up rather than crashing sync, and new transaction types from future amendments don't require schema changes.



## The Config File

When starting the node for the first time, it will automatically create a directory called `.xrplmeta` in the user's home directory. A copy of [`config.template.toml`](config.template.toml) will be put there, and used.

Alternatively, you can specify which config file to use using

    node src/run.js --config /path/to/config.toml

The config file uses "stanzas" for configuring each relevant component, such as the [public server API](src/srv) and the [crawlers](src/crawl/crawlers). Delete or comment the respective stanza to disable the component.

Review the comments in [`config.template.toml`](config.template.toml) for further explanation of the individual parameters.

### Tuning snapshot speed

`snapshot_chunk_size` in the `[LEDGER]` section controls how many ledger objects the indexer fetches per `ledger_data` request during the initial snapshot. Public rippled/clio endpoints cap this at 256; admin or no-rate-limit endpoints accept higher values (5000–20000 typical). If a chunk size is rejected as `invalidParams`, the indexer automatically halves it and retries.

For faster backfill, increase `connections` per `[[LEDGER.SOURCE]]` — each connection runs a parallel backfill worker.



## API Documentation

Beacon's added & changed endpoints are documented in **[`docs/api.md`](docs/api.md)**:

- **NFT discovery** — `/v2/nfts/collections`, `/v2/nfts/collection/:issuer/:taxon`, `.../nfts`, `.../offers`, `.../exchanges`, `/v2/nft/:tokenId`, and the `/v2/nft/:tokenId/image` thumbnail route
- **AMM pools** — `/v2/amms`, `/v2/amm/:account`, `/v2/amm/:account/series`, plus the `pool` field on token summaries, the `pool`/`pool_source` flags on token holders, and the `only_pools`/`exclude_pools` filters
- **`server_info`** NFT totals, and the list-limit / range-clamping changes

The inherited token / ledger / server endpoints follow the upstream [xrplmeta API](https://xrplmeta.org/docs).

The node listens for incoming HTTP connections on the port specified in the config file. Connections are either served as REST queries or upgraded to a WebSocket connection.



## Install

Clone this repository and install the dependencies:

    git clone https://github.com/ajkagy/xrplmeta.git
    cd xrplmeta
    npm install

Start the node with:

    node src/run.js

A template configuration file will be placed in your user directory on first launch. Edit `~/.xrplmeta/config.toml` and set at minimum `[NODE].data_dir` to a real path before running again.

Run the unit tests with:

    npm test



## Requirements

- **Node.js 20.x, 22.x, 23.x, 24.x, or 25.x** (the `better-sqlite3` native binding is built against these — Node 21 also works if rebuilt from source)

- **Build tools** for the native SQLite extension (`sqlite-xfl.node`) and `better-sqlite3`:
  - Linux: `sudo apt-get install build-essential python3`
  - macOS: `xcode-select --install`
  - Windows: Visual Studio C++ Build Tools and Python 3

  `npm install` runs `scripts/check-buildtools.js` as a preflight and will tell you up front if anything is missing.

- **An internet connection** to one or more rippled/clio nodes (configured in `[[LEDGER.SOURCE]]`)

- **Disk storage**: 3+ GB minimum for the initial snapshot. Full historical backfill consumes much more — plan for tens of GB to hundreds depending on how far back you backfill.



## Project layout

| Path | What's there |
|---|---|
| `src/` | Main source: ledger sync, snapshot, state handlers, server, crawlers |
| `src/db/schemas/` | JSON-Schema definitions for the SQLite databases (`core.db`, `cache.db`) |
| `src/db/migrations/` | Migration scaffolding for schema changes that can't be expressed in JSON |
| `src/ledger/state/` | One module per LedgerEntryType (AccountRoot, RippleState, AMM, Vault, Oracle, MPToken, NFTokenPage/Offer, …) |
| `vendor/` | Vendored copies of `@xrplkit/xfl`, `@xrplkit/txmeta`, `@xrplkit/xls26`, `@structdb/sqlite`, and `@structdb/codec`. Owned in-tree to eliminate supply-chain risk from alpha/single-maintainer packages |
| `deps/sqlite-extensions/xfl.c` | Native SQLite extension for XRPL Floating Point math |
| `scripts/check-buildtools.js` | Preflight that verifies the local toolchain before `node-gyp rebuild` runs |
| `test/unit/` | Mocha unit tests; run with `npm test` |
| `test/live/` | Live-network integration tests; run with `npm run livetest -- <case>` |
| `docs/api.md` | API reference |



## Database migrations

The SQLite schema can be evolved in two ways:

1. **Adding new columns to existing tables** — handled automatically. On startup, the indexer inspects each table and runs `ALTER TABLE ADD COLUMN` for any field declared in the JSON schema that isn't yet present. No manual migration required for additive column changes.

2. **Type changes, dropped columns, new UNIQUE constraints, primary key changes** — must be handled via a manual migration in `src/db/migrations/`. The migration runner records applied IDs in a `SchemaMigration` table so each migration runs exactly once.

If you ever see startup fail with `no such column: …`, pull the latest code (the auto-migrate covers most cases) or check `src/db/migrations/index.js` for the migration that needs to be added.
