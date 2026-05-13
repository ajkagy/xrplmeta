# xrplmeta API — recent additions

This document covers the endpoints and response fields added in the 2.24 line. The
canonical reference for all stable endpoints is still https://xrplmeta.org/docs.

All endpoints are exposed under `/v2/...` over HTTP, and via the WebSocket procedure
of the same name (without the `/v2/` prefix).

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

## Pseudo-account taxonomy

The indexer recognises two pseudo-account sources today:

| Source | Detected via | Notes |
|---|---|---|
| `amm` | `AccountRoot.Flags & lsfAMM` (`0x02000000`) | AMM amendment |
| `vault` | The `Account` field on `Vault` ledger entries | SingleAssetVault amendment |

If a future amendment introduces another kind of pseudo-account, add a detection branch
to `src/ledger/state/pseudoaccounts.js:collectPseudoFromDeltas`.
