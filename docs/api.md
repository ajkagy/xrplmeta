# Beacon API

Beacon serves a JSON **REST + WebSocket** API. The base token / ledger / server
endpoints follow the upstream [xrplmeta](https://github.com/xrplmeta/node) API
(reference: https://xrplmeta.org/docs); **this document covers Beacon's additions and
changes** — full NFT discovery, AMM / pool data, pool-aware token fields, and a few
behavioural changes.

Most endpoints are exposed under `/v2/...` over HTTP **and** via a WebSocket procedure
of the same name (without the `/v2/` prefix; pass path params like `issuer` / `taxon` /
`token_id` in the params object). The NFT image route `/v2/nft/:tokenId/image` is the
only HTTP-only endpoint.

---

## New: NFT discovery endpoints

Beacon indexes every XLS-20 NFT, groups them into collections by `(issuer, taxon)`,
computes per-collection metrics, and — when `[NFTS.METADATA]` is configured — enriches
collections and NFTs with off-chain XLS-24 metadata plus a hard-capped image thumbnail
cache. All of these (except the image route) are also reachable as WebSocket procedures
of the same name.

> Collection identity is always `(issuer, taxon)` (on-chain). `name` / `image` are
> optional off-chain enrichment and may be `null`. Floor and volume are quoted in
> **XRP** (IOU-priced offers/sales are excluded).

### `GET /v2/nfts/collections`

List / rank NFT collections.

| Param | Type | Description |
|---|---|---|
| `sort_by` | string | One of `supply`, `holders`, `floor`, `volume_24h`, `volume_7d`, `volume_all`, `trades_24h`, `trades_7d`. Default `volume_24h` (descending). |
| `name_like` | string | Substring match on the collection's off-chain name (matches only enriched collections). |
| `issuer` | string | Exact issuer (classic address) filter. Combines with `name_like`. |
| `limit` | integer | Page size, default `50`, max `1000`. |
| `offset` | integer | Pagination offset. |

```json
{
  "count": 18420,
  "collections": [
    {
      "issuer": "rIssuer...",
      "taxon": 7,
      "name": "Cool Cats",          // null until enriched
      "image": "https://ipfs.io/ipfs/Qm.../collection.png",   // null until enriched
      "supply": 4096,
      "holders": 1730,
      "floor": "12.5",              // lowest active open XRP sell offer (drops→XRP)
      "volume": { "h24": "1500", "d7": "9800", "all": "412300" },
      "trades": { "h24": 14, "d7": 92 }
    }
  ]
}
```

### `GET /v2/nfts/collection/:issuer/:taxon`

One collection summary — same shape as a `collections[]` entry. `404 notFound` if no
such collection exists.

### `GET /v2/nfts/collection/:issuer/:taxon/nfts`

The **live** NFTs in a collection (burned / transferred-out NFTs are excluded, so
`count` matches the collection's `supply`), ordered by serial.

| Param | Type | Description |
|---|---|---|
| `limit` | integer | default `100`, max `1000` |
| `offset` | integer | pagination offset |

Returns `{ "count": N, "nfts": [ <NFT object>, ... ] }` (NFT object documented below).

### `GET /v2/nft/:tokenId`

A single NFT plus its active offers.

```json
{
  "token_id": "000813...",
  "issuer": "rIssuer...",
  "owner": "rOwner...",          // null if burned
  "taxon": 7,
  "serial": 1234,
  "flags": 8,
  "transfer_fee": 500,
  "uri": "ipfs://Qm.../1.json",  // raw on-chain URI (hex-decoded), or null
  "mint_ledger": 91000000,
  "burn_ledger": null,
  "name": "Cool Cat #1234",      // off-chain; null until enriched
  "description": "...",
  "media_url": "https://ipfs.io/ipfs/Qm.../1.png",  // resolved primary media
  "media_type": "image",         // image | video | audio | model | html | other
  "image": "https://ipfs.io/ipfs/Qm.../1.png",      // set only for image media
  "thumbnail": "https://your-node/v2/nft/000813.../image",  // null unless image media
  "offers": [
    {
      "offer_id": "AE0A...",
      "account": "rOwner...",
      "amount": "12.5",
      "token": { "currency": "XRP" },
      "is_sell": true,
      "destination": null,       // set for private / brokered offers
      "expiration": null,        // unix time, or null
      "ledger_index": 91000500
    }
  ]
}
```
`404 notFound` if the NFT isn't indexed.

### `GET /v2/nfts/collection/:issuer/:taxon/offers`

Active offers across the collection, cheapest first.

| Param | Type | Description |
|---|---|---|
| `limit` / `offset` | integer | pagination (`limit` default `100`, max `1000`) |

Returns `{ "count": N, "offers": [...] }` where each offer is the object shown above,
plus a `token_id` field.

### `GET /v2/nfts/collection/:issuer/:taxon/exchanges`

Sale history for the collection.

| Param | Type | Description |
|---|---|---|
| `sequence_start`/`sequence_end` **or** `time_start`/`time_end` | integer | range (defaults to the full available range) |
| `newest_first` | flag | return newest sales first |
| `limit` / `offset` | integer | pagination (`limit` default `100`, max `1000`) |

```json
{
  "count": 92,
  "exchanges": [
    {
      "tx_hash": "...",
      "token_id": "000813...",
      "seller": "rSeller...",
      "buyer": "rBuyer...",
      "amount": "12.5",
      "token": { "currency": "XRP" },
      "is_sell": true,
      "ledger_index": 91000700
    }
  ]
}
```

### `GET /v2/nft/:tokenId/image`

Serves a **cached thumbnail** of the NFT's image, lazily fetched + resized on first
request and stored in a hard-capped, LRU-evicted on-disk cache.

| Status | Meaning |
|---|---|
| `200` | thumbnail bytes (`image/png`) |
| `302` | redirect to the source image (when `[NFTS.MEDIA] disabled = true`) |
| `404` | no image for this NFT (non-image media, or not yet enriched) |
| `503` | image cache busy / node overloaded — retry (honours `Retry-After`) |
| `400` | malformed token id |

`?size=` selects which configured thumbnail size to serve (`nfts.media.sizes`, default
`256`). Only **image** media is cached; video / audio / 3D media is URL-only — use the
NFT's `media_url`. The on-disk cache never exceeds `nfts.media.max_bytes`.

---

## New: AMM endpoints

### `GET /v2/amms`

List all AMM pools the indexer has observed.

**Query parameters**

| Param | Type | Description |
|---|---|---|
| `limit` | integer | Page size, default `50`, max `1000` |
| `offset` | integer | Pagination offset |
| `sequence` / `time` | integer | Ledger sequence or unix time at which to report pool reserves (defaults to latest) |
| `token` | string | Filter pools containing this asset, e.g. `USD:rIssuer...` or `XRP` |

**Response**

```json
{
  "count": 312,
  "pools": [
    {
      "account": "rPoolPseudo...",
      "asset1": { "currency": "USD", "issuer": "rIssuer..." },
      "asset2": { "currency": "XRP" },
      "lpTokenCurrency": "0344B6B...",
      "tradingFee": 500,
      "asset1Balance": "10000",
      "asset2Balance": "5000",
      "ledgerSequence": 91234567
    }
  ]
}
```

### `GET /v2/amm/:account`

Fetch one AMM pool by its pseudo-account address.

**Path params**

- `:account` — XRPL classic address of the AMM pool's pseudo-account.

**Query params**

- `sequence` / `time` — point-in-time. Defaults to latest.

Returns the same shape as one entry in `/v2/amms` `pools[]`, or `404 notFound` if no pool exists at that address.

### `GET /v2/amm/:account/series`

Historical reserve depth for an AMM pool.

**Query params**

| Param | Type | Description |
|---|---|---|
| `sequence_start` / `sequence_end` | integer | Inclusive sequence range |
| `time_start` / `time_end` | integer | Inclusive unix-time range |
| `points` | integer | Approximate number of samples to return across the range (default `50`) |

You must provide either a `sequence_*` range OR a `time_*` range (not both).

**Response**

```json
{
  "account": "rPoolPseudo...",
  "asset1": { "currency": "USD", "issuer": "rIssuer..." },
  "asset2": { "currency": "XRP" },
  "series": [
    { "ledgerSequence": 91000000, "asset1Balance": "9900", "asset2Balance": "5050" },
    { "ledgerSequence": 91500000, "asset1Balance": "10100", "asset2Balance": "4951" }
  ]
}
```

---

## Changed: token responses

The cached token response (`GET /v2/token/:token`, items inside `GET /v2/tokens`, etc.) now
includes a `pool` object when the token's issuer is a known pseudo-account.

```json
{
  "currency": "0344B6B...",
  "issuer": "rPoolPseudo...",
  "token_type": "IOU",
  "pool": {
    "source": "amm",
    "account": "rPoolPseudo...",
    "asset1": { "currency": "USD", "issuer": "rIssuer..." },
    "asset2": { "currency": "XRP" },
    "trading_fee": 500,
    "asset1_balance": "10000",
    "asset2_balance": "5000",
    "lp_token_currency": "0344B6B..."
  },
  "meta": { ... },
  "metrics": { ... }
}
```

`pool.source` is one of `amm`, `vault`, or `unknown`. The detailed `account`/`asset*`/`trading_fee`
sub-fields are only populated when `pool.source === "amm"` and the AMM record is currently in the
indexer's pool table.

---

## Changed: token holders

`GET /v2/token/:token/holders` now annotates pool accounts:

```json
{
  "holders": [
    { "account": "rAlice...",        "balance": "10000", "percent": 66.7 },
    { "account": "rPoolPseudo...",   "balance": "5000",  "percent": 33.3, "pool": true, "pool_source": "amm" }
  ]
}
```

Regular wallet holders are unchanged.

---

## New: pool filters on `/v2/tokens`

The token list now accepts two mutually-exclusive flags:

| Param | Effect |
|---|---|
| `only_pools` | return only tokens whose issuer is a pool pseudo-account (LP tokens etc.) |
| `exclude_pools` | hide all pool-issued tokens, returning only "ordinary" issuer tokens |

These work on `/v2/tokens`, `/v2/tokens/iou`, and `/v2/tokens/mpt`.

Examples:
```
GET /v2/tokens/iou?exclude_pools&limit=20    # ranked IOU list without AMM LP token noise
GET /v2/tokens?only_pools&sort_by=supply     # browse AMM LP tokens by supply
```

---

## Changed: holder count semantics

When an IOU or MPT participates in an AMM pool, the AMM's pseudo-account is no longer
counted in the `holders` metric of that token. Reserves it holds are still included in
`supply` (the issuer issued them — they're just not held by a human wallet).

Concretely: a token held by 100 real wallets and 1 AMM pool will report `holders: 100`,
not `holders: 101`. The pool's contribution is visible via the new pool-aware endpoints
above.

`trustlines` is unchanged — the AMM's trustline literally exists on-ledger, so it counts.

---

## Changed: `server_info`

`GET /v2` (and `/v2/info`, `/v2/server`, and the v1 root `/`) now reports NFT totals
and the Beacon version:

```json
{
  "server_version": "1.0.0",
  "total_tokens": 51234,
  "total_ious": 50012,
  "total_mpts": 1221,
  "total_nfts": 8204113,
  "total_nft_collections": 18420,
  "available_range": { "sequence": { "start": 32570, "end": 91234567 }, "time": { "start": ..., "end": ... } },
  "trustlists": [ ... ]
}
```

`total_nfts` counts all indexed NFTs (including burned). The v1 root (`/`) keeps its
legacy shape and omits `total_ious` / `total_mpts`.

---

## Changed: list limits & range clamping

- The maximum `limit` on list endpoints (`/v2/tokens`, `/v2/tokens/iou`, `/v2/tokens/mpt`,
  `/v2/token/:token/holders`) is now **`1000`** (previously `100000`) — a single request
  can no longer pull an unbounded page and stall the server.
- A positive `sequence_end` / `time_end` on range endpoints is now **honoured**.
  Previously the upper bound was silently clamped to the latest ledger; this affects
  token exchanges / series and the new NFT exchanges endpoint.
- Bad pagination/range params (`limit`, `offset`, `sequence_*`, `time_*`) that aren't
  non-negative integers are now rejected with `400 invalidParam` instead of silently
  coercing.

---

## Pseudo-account taxonomy

The indexer recognises two pseudo-account sources today:

| Source | Detected via | Notes |
|---|---|---|
| `amm` | `AccountRoot.Flags & lsfAMM` (`0x02000000`) | AMM amendment |
| `vault` | The `Account` field on `Vault` ledger entries | SingleAssetVault amendment |

If a future amendment introduces another kind of pseudo-account, add a detection branch
to `src/ledger/state/pseudoaccounts.js:collectPseudoFromDeltas`.
