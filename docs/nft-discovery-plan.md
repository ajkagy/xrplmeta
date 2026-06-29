# NFT Discovery — Implementation Plan

Status: proposal · Target: `xrplmeta` 2.x · Author: generated audit/design pass

## 1. Executive summary

xrplmeta is a passive XRPL indexer: it ingests ledger state + transactions, derives
metrics, lets crawlers enrich metadata, builds a denormalized cache, and serves a
read API. This pipeline is **fully built for fungible tokens (IOU/MPT)** and **only
half-built for NFTs (XLS-20)**.

What exists today for NFTs is *raw ledger bookkeeping* — we know which NFTs exist,
who owns them, what offers are open, and which sales happened. What does **not**
exist is a *discovery layer*: collections, decoded mint attributes, off-chain
metadata (name/image/traits), computed stats (floor/volume/holders/supply), a cache,
and any API surface. `server_info` even hardcodes `total_nfts: 0`
([src/srv/procedures/server.js](../src/srv/procedures/server.js)).

**Conclusion: NFT discovery does not exist. This plan adds it by mirroring the
existing token pipeline stage-for-stage.**

## 2. What exists today (verified)

| Stage | Fungible tokens | NFTs |
|---|---|---|
| Ledger-state parse/diff | `RippleState`→[state/tokens.js](../src/ledger/state/tokens.js) | `NFTokenPage`→[state/nfts.js](../src/ledger/state/nfts.js), `NFTokenOffer`→[state/nftoffers.js](../src/ledger/state/nftoffers.js) |
| Transaction events | [events/tokens.js](../src/ledger/events/tokens.js) | [events/nfts.js](../src/ledger/events/nfts.js): `NFTokenAcceptOffer`→`nftExchanges`, `NFTokenModify`→URI update |
| Metric snapshots | `tokenSupply/Holders/Trustlines/Marketcap` via [tokenmetrics.js](../src/db/helpers/tokenmetrics.js) | **none** |
| Derived | [derived/](../src/ledger/derived/index.js) marketcap | **none** |
| Metadata storage | `tokenProps` + crawlers | **none** (URI stored raw on the NFT row only) |
| Icon/image cache | [cache/icons.js](../src/cache/icons.js) | **none** |
| Denormalized cache | `cache.tokens` via [cache/worker.js](../src/cache/worker.js)+[tokens.js](../src/cache/tokens.js) | **none** |
| API | ~15 procedures in [api.js](../src/srv/api.js) | **zero** |

Existing NFT tables: `NFToken` (id, issuer, owner, tokenId, uri), `NFTokenOffer`,
`NFTokenExchange` — see [core.json](../src/db/schemas/core.json) lines 678–798.

### Gaps in the raw layer worth fixing as part of this work
- The `NFToken` row stores **no taxon, flags, transferFee, mint ledger, or serial**.
  All of these are encoded in the 32-byte `NFTokenID` and can be decoded without any
  extra ledger data — but the **taxon is XOR-scrambled** with the token sequence and
  must be unscrambled (`taxon = scrambledTaxon ^ ((384160001 * seq + 2459) mod 2^32)`).
  Without taxon there is no concept of a *collection*.
- Mint/burn are only implicitly captured (an NFT appearing/disappearing from an
  `NFTokenPage` in [state/nfts.js](../src/ledger/state/nfts.js) `diff()`). There is no
  first-seen/burned ledger recorded, so supply-over-time and "newly minted" can't be
  computed.
- `applyNFTokenExchanges` records a sale but **not the sale price** — it stores the
  offer reference but the denormalized amount needed for floor/volume lives on the
  (now-deleted) offer. Need to snapshot `amountToken`/`amountValue` onto the exchange
  row, mirroring how `tokenExchanges` stores price inline.

## 3. Design principles

1. **Mirror the token pipeline.** Reuse `writePoint`/`readPoint`, the cache-todo
   queue, the procedure/sanitizer/route conventions, and the metric-series helpers.
   Do not invent new patterns.
2. **The collection (issuer + taxon) is the primary discovery entity**, analogous to
   a "token". Individual NFTs are secondary (like holders are to a token).
3. **Everything heavy is incremental + yielding.** Follow the just-fixed props/diff
   model: chunked transactions, `setImmediate` yields, conditional cache-dirtying,
   no unbounded `IN(...)`. NFT collections can be large (10k–100k items).
4. **Off-chain metadata is best-effort and sandboxed.** URI fetching is the only new
   *outbound* surface; it must reuse [lib/fetch.js](../src/lib/fetch.js) with
   `validateUrls`, byte caps, and an IPFS-gateway allowlist (SSRF risk).
5. **Ship in phases**; each phase is independently useful and shippable.

## 4. Schema additions

New definitions in [core.json](../src/db/schemas/core.json) (+ a migration in
[src/db/migrations/index.js](../src/db/migrations/index.js)):

- **`NFTokenCollection`** — the discovery entity.
  `{ id, issuer→Account, taxon:int, supply:int?, burned:int?, firstSeenLedger:int }`,
  unique `[issuer, taxon]`. This is the NFT analog of `Token`.
- **`NFTokenCollectionProp`** — metadata, analog of `tokenProps`.
  `{ id, collection→NFTokenCollection, key, value:any, source }`, unique
  `[collection, key, source]`. Reuse the *exact* prop-diff machinery in
  [db/helpers/props.js](../src/db/helpers/props.js) (generalize it to a third subject
  type, or add `diffMultiCollectionProps`).
- Extend **`NFToken`**: add `taxon:int`, `flags:int`, `transferFee:int`,
  `serial:int` (token sequence), `mintLedgerSequence:int`, `burnLedgerSequence:int?`,
  and a `collection→NFTokenCollection` FK. Add index `[collection]` and
  `[issuer, taxon]`.
- Extend **`NFTokenExchange`**: add `amountToken→Token`, `amountValue:xfl`,
  `isSellOffer:bool`, `seller→Account`, `buyer→Account` so floor/volume/price-history
  are queryable without the deleted offer. Index `[nft, ledgerSequence]` already
  exists; add `[collection, ledgerSequence]` (denormalize collection onto the row, or
  join through `nft`).
- **Per-collection metric tables** (point-in-time, same shape as `tokenSupply`):
  `nftCollectionFloor`, `nftCollectionVolume`, `nftCollectionHolders`,
  `nftCollectionSupply`. Driven by `writePoint`/`readPoint`.
- **`cache.nftCollections`** (+ `cache.nftCollectionProps`) — denormalized read model,
  analog of `cache.tokens`. Lives in the cache DB schema.
- **`NFTokenMetadataFetch`** (cache DB) — per-NFT/collection fetch bookkeeping:
  `{ subjectId, uri, status, fetchedLedger, attempts, nextAttemptAt, contentHash }`
  so we don't refetch immutable URIs and can back off failures.

## 5. Ingestion changes (ledger pipeline)

### 5.1 Decode NFTokenID (new util `src/xrpl/nftoken.js`)
Pure function `decodeNFTokenId(hex) → { flags, transferFee, issuer, taxon, serial }`
incl. the taxon unscramble. Unit-tested against known mainnet NFTokenIDs. Used by
both state and events code (replaces the ad-hoc `slice(8,48)` issuer extraction in
[state/nfts.js](../src/ledger/state/nfts.js):12 and
[state/nftoffers.js](../src/ledger/state/nftoffers.js):11).

### 5.2 NFT state ([state/nfts.js](../src/ledger/state/nfts.js))
- On an NFT entering a page (mint or transfer-in): upsert the `NFToken` row with
  decoded taxon/flags/fee/serial; **find-or-create its `NFTokenCollection`** and link
  it; set `mintLedgerSequence` when first seen; bump `collection.supply` (forward) /
  decrement (backwards).
- On leaving with no destination page (burn): set `owner=null`,
  `burnLedgerSequence`, bump `collection.burned`.
- Mark the collection dirty for cache + queue metric recompute
  (`markCacheDirtyForNFTCollection*`, new entries in [cache/todo.js](../src/cache/todo.js)).
- Keep all writes inside the existing per-ledger transaction in
  [ledger/sync.js](../src/ledger/sync.js); these are bounded per ledger so no extra
  yielding is needed here.

### 5.3 NFT events ([events/nfts.js](../src/ledger/events/nfts.js))
- In `applyNFTokenExchanges`, snapshot price onto the exchange row (`amountToken`,
  `amountValue`, `isSellOffer`, buyer/seller) from the parsed deleted offer.
- Detect explicit `NFTokenMint`/`NFTokenBurn`/`NFTokenCreateOffer` only if we want
  mint-time metadata (URI, issuer-set fields) earlier than the page diff provides —
  optional; the page diff already covers existence.
- Queue a floor/volume recompute for the affected collection.

### 5.4 Derived ([ledger/derived/](../src/ledger/derived/index.js))
Add `updateNFTFloorFromOffer` / `updateNFTVolumeFromExchange`, wired into
`updateDerived` via `pullNewItems` (extend [db/helpers/heads.js](../src/db/helpers/heads.js)
to track `nftExchanges` / `nftOffers` heads). Floor = min active sell-offer
`amountValue` (normalized to XRP/USD) per collection; volume = rolling sum of
exchange values.

## 6. Off-chain metadata pipeline (new `src/cache/nftmeta.js` + crawler)

This is the genuinely new subsystem. Two stages, both queue-driven like the icon cache:

1. **URI fetch worker** (new worker alongside [cache/worker.js](../src/cache/worker.js)
   `startIconCacheWorker`): pulls `nft.metadata` / `collection.metadata` todos,
   resolves the URI (decode hex→utf8; map `ipfs://CID` → a configured gateway),
   fetches JSON via [lib/fetch.js](../src/lib/fetch.js) (`validateUrls:true`, json byte
   cap, redirect cap), parses XLS-24-style metadata (`name`, `description`, `image`,
   `attributes`), and writes `nftProps`/collection props via the prop-diff helpers.
   Respects `NFTokenMetadataFetch` backoff; treats `ipfs://` content as immutable
   (hash the body, never refetch unchanged).
2. **Image cache**: reuse [cache/icons.js](../src/cache/icons.js) almost verbatim —
   the `image` URL from metadata becomes an "icon" for the NFT/collection; sharp
   resizes to the same size ladder; served by the existing `/icon/:file` route.

SSRF/DoS controls (must-have): URL allowlist for IPFS gateways, block private/link-
local ranges (already partpossible via `validateUrls`), per-host rate limit
(`limiter`), max attribute count/size, and a hard cap on NFTs enqueued per collection
for metadata (collections can have 100k+ items — fetch lazily / on-demand for the long
tail, eagerly only for collection-level + top NFTs).

## 7. Cache layer

Extend [cache/worker.js](../src/cache/worker.js) `startMetaCacheWorker` switch with new
task types: `collection.props`, `collection.metrics.floor|volume|holders|supply`,
`nft.props`. Add `updateCacheForNFTCollection*` in a new
[src/cache/nfts.js](../src/cache/nfts.js) mirroring [cache/tokens.js](../src/cache/tokens.js):
compute 24h/7d volume + floor change, holder count, supply, join props, write
`cache.nftCollections`. Keep the existing throttling/yield/load-aware backoff — NFT
recompute must not starve HTTP either.

## 8. API surface

Add procedures in [src/srv/procedures/nft.js](../src/srv/procedures/nft.js), compose
them in [api.js](../src/srv/api.js), add sanitizers in
[src/srv/sanitizers/nft.js](../src/srv/sanitizers/nft.js) (validate issuer, taxon,
tokenId hex, sort keys), and routes in [http.js](../src/srv/http.js). All read from the
cache, all paginated with the existing `sanitizeLimitOffset` caps:

- `GET /v2/nfts/collections` — list/search collections; sort by floor/volume/holders/
  supply; `name_like`, `issuer` filters. (analog of `/v2/tokens`)
- `GET /v2/nfts/collection/:issuer/:taxon` — one collection summary.
- `GET /v2/nfts/collection/:issuer/:taxon/series/:metric` — floor/volume/holders/
  supply time-series (reuse `readTokenMetricIntervalSeries` pattern).
- `GET /v2/nfts/collection/:issuer/:taxon/nfts` — NFTs in a collection (owner, uri,
  metadata), paginated.
- `GET /v2/nft/:tokenId` — single NFT (owner, decoded attrs, metadata, active offers).
- `GET /v2/nfts/collection/:issuer/:taxon/offers` and `/exchanges` — order book + sale
  history (reuse the range/limit sanitizers).
- Update [server.js](../src/srv/procedures/server.js) to report real `total_nfts` /
  `total_collections`.

Keep v1 untouched (NFTs are net-new, so only `/v2/...` routes).

## 9. Config & ops

Add a `[nfts]` block to [config.template.toml](../config.template.toml):
`disabled`, `metadata.gateways` (IPFS allowlist), `metadata.fetchInterval`,
`metadata.maxBytes`, `metadata.eagerTopN`, `metadata.concurrency`. Gate the whole
subsystem behind `disabled` so operators can run indexer-only. Env overrides for the
new worker mirror `XRPLMETA_CACHE_*`.

## 10. Testing

- Unit: `decodeNFTokenId` (incl. taxon unscramble) against fixtures; collection
  upsert/supply accounting forward **and** backwards (rollback); exchange price
  snapshotting; floor/volume derivation; metadata parse + SSRF rejection.
- State tests in the style of [test/unit/state/state.test.js](../test/unit/state/state.test.js):
  feed synthetic NFTokenMint/AcceptOffer/Burn deltas, assert collection rows, supply,
  floor, exchange price. Test backwards application (the indexer supports reorg/rewind
  via `ctx.backwards`).
- Live: a [test/live/cases](../test/live/cases) case that pulls a real collection and
  asserts non-empty metadata/floor.

## 11. Phasing (each phase shippable)

1. **Raw enrichment**: `decodeNFTokenId`, taxon/flags/serial on `NFToken`,
   collections table + linkage, mint/burn ledger, exchange price snapshot. No API yet.
   *Delivers: correct on-chain NFT/collection data + supply.*
2. **Metrics + derived**: floor/volume/holders/supply point tables + derived updates +
   cache.nftCollections + cache worker tasks. *Delivers: computed collection stats.*
3. **API**: collection list/summary/series/nfts/offers/exchanges + `server_info` counts.
   *Delivers: public NFT discovery endpoints.*
4. **Off-chain metadata**: URI fetch worker, IPFS gateway handling, nft/collection
   props, image cache. *Delivers: names/images/traits.*
5. **External crawlers (optional)**: enrich collection props from marketplaces, same
   `diffMultiCollectionProps` path.

## 12. Risk register

- **Scale**: popular collections have 10k–100k NFTs; metadata fan-out can be millions
  of fetches. Mitigation: collection-level + top-N eager, rest lazy/on-demand; immutable
  IPFS dedupe; hard caps + the chunked/yielding pattern from the props fix.
- **SSRF / malicious URIs**: NFT URIs are attacker-controlled. Mitigation: allowlist
  gateways, `validateUrls`, byte/redirect caps, no following to private IPs.
- **Taxon unscramble correctness**: get it wrong and collections fragment. Mitigation:
  fixture tests against known IDs before anything writes collections.
- **Reorg/backwards**: supply/floor counters must decrement correctly on rewind, like
  token metrics do. Mitigation: route all counters through `writePoint` + `ctx.backwards`
  and test rollback explicitly.
- **Metadata churn**: mutable HTTP URIs change. Mitigation: TTL + content-hash; never
  block ingestion on metadata.
