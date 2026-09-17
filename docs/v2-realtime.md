# Realtime delivery and operating cost

This implements the six delivery/computation changes discussed for [v2.0 (#100)](https://github.com/haythemsellami/mpamm.wtf/issues/100). Quote processing can finish within a 300ms block interval, but complete block coverage also requires a fresh upstream head feed. These are separate measurements.

## Changes

| Area | Behavior |
| --- | --- |
| Demand | Compute the union of requested market/size combinations. Baseline quotes require an enabled baseline topic. No Execution viewers means no hot quote RPC work; ingestion, CEX reference sampling and markouts continue. Depth retains its independent market demand and full size grid. |
| Metric | A constructor-only `eth_call` reads the oracle and quotes each pool in one RPC round trip. No transaction, deployed contract, signing key or state override. Per-leg failures remain independent. Unsupported providers use the original two-call path with a 60s probe cooldown. |
| RPC scheduling | Multicall3 still aggregates contract reads. HTTP batching is off for live quotes by default, optionally enabled per adapter. Head polling is unbatched. A 250ms default deadline cancels expired quote work; one outstanding job per adapter prevents late work accumulating. Durable ingestion keeps its original retry/cursor rules. |
| Delivery | Filter before serialization; gzip once per topic and share the bytes. A versioned binary protocol does not depend on proxy negotiation of WebSocket extensions. Latest snapshots replace queued snapshots. Fill events preserve order; slow clients reconnect and resync. |
| History | SQLite aggregation runs in a read-only worker using one WAL snapshot for both passes. Existing TTL/inflight caches remain. Immutable aggregate URLs, shared gzip and an optional edge worker avoid repeat serialization and origin downloads. Corrections create new revisions. |
| Browser | One SharedWorker connection per origin serves the union of visible tabs. Fallback connections work without SharedWorker or gzip decoding. Hidden tabs stop after 60s and resynchronize on return. Bootstrap/fill/volume downloads are page-specific. |

Quotes remain pinned to an explicit block and a synchronously captured pair-terms CEX reference. Missing/expired results are absent, never replaced with stale prices. Fill finality margins, money math, schema version and atomic data/cursor transactions are unchanged. Legacy WebSocket clients retain full matrices; legacy `/api/quotes` and `/api/markets` return empty HTTP 200 snapshots during cold startup, then request full quote computation on demand and return 503 if unavailable.

Markets and baseline controls come from adapter discovery metadata, independently of the current quote selection. Alternate-size availability hints reuse the existing depth subscription instead of pricing the whole matrix. Quote history contains observed frames only: newly demanded pairs may warm up instead of showing an invented minute of prices. History expires after 60 seconds even while computation is idle. Legacy sockets wait for a fresh full matrix before receiving quotes. Reconnect/history races preserve newer live frames and fills, including overlapping REST requests, worker fallback and page restoration; replayed frames do not double-count spread samples.

Reference sampling runs every 100ms independently of markout aging. Markouts use binary horizon lookups in chronological reference history and one non-overlapping pass every 300ms. Each pass yields after 128 fills or about 2ms of work, checked between fills, and visits at most its initial pending count. This keeps a large pending set from occupying the quote/head event loop for a complete scan. Shutdown stops and awaits the active pass; persistence updates, unobservable horizons and buy/sell signs retain their existing semantics.

Quote adapters check cancellation before applying shared caches or outage notes. Lunarbase stages its validation results until parallel quote reads settle, retains its occupied slot through cancellation, and rejects older snapshots when a newer cache already exists. Bootstrap's empty quote placeholder does not reject the first completed stream frame merely because the chain head has advanced; subsequent observed frames remain monotonic. HTTP transport regressions exercise pinned calls and cancellation with batching both enabled and disabled.

Full quote plans explicitly select all venue roles; scoped plans select regular or baseline venues. When an adapter receives several market/size plans, its outage reporter evaluates their combined results once, in plan order. One failed market cannot flip a successfully quoting venue between unavailable and recovered, and canceled or rejected frames cannot commit partial health. Rejected plans retain the adapter's slot until every sibling has settled. The fill tail reads its boundary through the same isolated head lane as quote observation, retaining the five-block finality margin and cursor hold on failure.

## Measurements

Recorded September 17, 2026 on an Apple M4. Delivery/runtime tests use Node 24.11.1, matching the production major version; the live helper comparison used Node 26.8.2. Raw samples and methodology are in [delivery](benchmarks/v2-delivery.json), [runtime](benchmarks/v2-runtime.json), [Metric](benchmarks/v2-metric-live.json) and [live stream](benchmarks/v2-live-stream.json).

| Test | Previous path | New path |
| --- | --- | --- |
| 100-viewer quote replay, bytes/viewer/sec | 183.7 KB/s raw; 31.1 KB/s with negotiated deflate | 2.60 KB/s, selected MON/USDC $10k |
| Same replay, p95 loopback receipt latency | 38ms raw; 46ms deflate | 8ms |
| Same replay, whole-process CPU over 20 frames | 1,012ms raw; 3,127ms deflate | 326ms |
| Simulator quote matrix | 900 rows | 8 selected rows; 0 idle rows |
| RPC batch test, fast-call median | 84.9ms in a shared zero-wait batch with an 80ms sibling | 7.9ms unbatched; 9.2ms per-adapter batching |
| Metric live, median | 85.3ms, two RPC rounds | 41.7ms, one RPC round |
| 100k-fill analytics, main-loop p95 delay | 79.6ms | 2.4ms |
| 50k-fill markout burst, median full-pass time | 308.1ms | 63.8ms |
| Same burst, largest observed event-loop stall | 308.0ms | 3.1ms |
| Tail-head read alongside an 80ms log read, loopback median | 93.3ms, shared batch | 7.9ms, isolated head lane |

The delivery test replays the same recorded full quote matrix to 10 and 100 local clients, 20 frames at 300ms intervals. All clients received all 20 frames. V2 performed 20 compression jobs even with 100 viewers. The 98.6% reduction is **quote traffic for one selected topic**, not the complete bill: depth, state, history, TLS, bootstrap, concurrent different selections and remote networking are excluded. CPU includes both server and client decoding. Sequential replay RSS measurements are not evidence of memory savings.

The [follow-up replay](benchmarks/v2-review-delivery.json) after snapshot/reconnect fixes retained 98.6% fewer quote bytes and delivered every frame. At 100 viewers it measured 186.3 KB/s per viewer raw, 31.3 KB/s with legacy deflate, and 2.61 KB/s with shared gzip; v2 receipt p95 was 6ms on loopback. A [live handoff check](benchmarks/v2-review-live.json) verified four consecutive legacy frames contained Metric BTC/USDC and ETH/USDC at all four sizes, idle resubscription started with empty rows then received fresh executable quotes, and full REST quotes returned HTTP 200 with 108 rows. Other adapters are covered by generic/simulated tests rather than that live check.

The batching test deliberately models a provider returning a JSON-RPC batch only after its slowest member. Separating requests doubles HTTP request count in this two-call example; it does not claim that every provider behaves identically. `QUOTE_HTTP_BATCH=on` permits provider-specific comparison without restoring cross-adapter batching.

The [tail-head benchmark](benchmarks/v2-review-heads.json) uses the actual exported RPC clients against a loopback provider with a 5ms head read and an 80ms concurrent log read. After one warmup, twenty trials measured head p50/p95 at 93.3/94.2ms in the shared lane and 7.9/9.0ms in the isolated lane. No isolated head joined a log batch; both modes returned identical heads and logs. Isolation used 42 HTTP requests instead of 21 including warmup, so this demonstrates latency isolation rather than fewer requests. A regression also holds the log response indefinitely and verifies that the isolated head still completes.

The [protocol replay](benchmarks/v2-review-protocol-delivery.json) retained every frame and the 98.6% quote-byte reduction after explicit subprotocol selection: at 100 viewers, 184.5 KB/s per viewer raw versus 2.60 KB/s with shared gzip, with 8ms loopback receipt p95. Handshake regressions cover gzip, JSON, multiple offers, unsupported offers and legacy clients without a subprotocol.

A [live protocol check](benchmarks/v2-review-protocol-live.json) subscribed concurrently to BTC/USDC $1,000 over JSON and ETH/USDC $100 over gzip. Each received twelve executable Metric quote frames with the correct selection and uninterrupted sequence numbers. Three subsequent legacy snapshots and `/api/quotes` each contained 108 rows, including Metric's two live markets at all four sizes. The fill cursor advanced from 105662282 to 105662309 through the isolated head lane. This is a bounded local integration check; baseline roles remain covered by fixtures and browser tests, and the run does not establish full block coverage.

The [catalog replay](benchmarks/v2-review-catalog-history.json) compares the gateway at `89a26a2` with the corrected snapshot tracking using the same recorded catalog. The first unchanged state tick falls from 1,487 to 568 JSON bytes, or 460 to 313 gzip payload bytes. Both versions in that replay sent the same complete 2,833-byte initial snapshot; initial snapshots now also use negotiated compression. This catalog saving occurs once per new state subscription; it is not a recurring per-tick reduction. Regressions also preserve catalog updates through compression coalescing and concurrent subscriptions, and retain omitted catalogs in the browser.

Quote history and chart buffers are active only on Execution. Browser checks open Markouts, Volume and Leaderboard directly, visit Execution and return: each non-Execution entry makes zero quote-history requests, while Execution fetches history successfully and renders its charts. Unit checks also cover selection/registry changes, reconnects and history responses completing after leaving Execution.

A [live cancellation check](benchmarks/v2-review-cancellation-live.json) forces an unsupported-helper response and aborts after four successful fallback legs return at block 105666670. The canceled frame is rejected without committing a cooldown; the next quote immediately retries the helper. BTC/USDC and ETH/USDC $100 rows then match the original path at the same block in every field except timestamp. The check uses fixed test sizing anchors rather than live reference prices; it verifies fallback/cancellation behavior and row equivalence, not market-relative bps accuracy. Fixture tests also cover cancellation during oracle reads, rejected fallbacks and cooldown after a successful fallback.

Lunarbase discards both gates and quote legs when a newer snapshot has already been accepted. Its ordering boundary survives quarantine, preventing an older read from re-admitting an invalidated pool. Regressions exercise valid, invalid and failed reads completing after rediscovery, including a newer quarantine. Timeout and busy-slot quote frames remain visible in missing-venue telemetry but cannot advance or clear the core outage counters; completed empty results and genuine recoveries still do.

Analytics publication is serialized per history window, with independent windows encoding concurrently. A failed compression releases the next publication; unchanged content still reuses its immutable artifact. Hot head routing now covers startup, background boundary selection, adapter discovery and the depth worker as well as the main quote watcher and fill tail. Archive boundary checks continue using the archive pool.

The [live ordering check](benchmarks/v2-review-ordering-live.json) observed twelve executable Metric BTC/USDC $100 frames and eleven depth publications during a twelve-second local run that included startup. Depth advanced from block 105670892 to 105670917. Eight concurrent analytics requests returned one immutable revision, served compressed with HTTP 200. Lunarbase was paused at block 105670921; it correctly returned no quotes and remained registered. This verifies live integration; out-of-order executable Lunarbase reads are covered by fixtures, and the run does not establish full block coverage or a latency bound.

The [bootstrap delivery replay](benchmarks/v2-review-bootstrap-delivery.json) delivered all twenty frames to every client. At 100 viewers, selected quote traffic measured 2.61 KB/s per viewer versus 183.5 KB/s for the full raw matrix, with 8ms loopback receipt p95. The identical initial quote snapshot fell from 1,695 JSON bytes to 807 gzip payload bytes, encoded once for all 100 viewers. Initial snapshot bytes are recorded separately from the steady-stream measurement. A bounded per-peer queue preserves bootstrap ordering while compression runs; large state, quote and depth snapshots share their encoded payload across identical subscribers. Baseline registry construction happens once per quote publication rather than once per topic; a regression checks eight distinct topics require one state read.

A [live cold-start check](benchmarks/v2-review-bootstrap-live.json) verified both legacy REST endpoints returned empty HTTP 200 snapshots at block zero without waiting for quote demand. After startup, eight executable Metric quote frames and eleven depth publications arrived, and a second subscriber received compressed depth, quote and state bootstraps. The live payloads measured 715/552/776 bytes versus 2,579/992/1,674 JSON bytes, respectively. Metric retained MON/USDC in its admitted catalog while the full REST snapshot quoted only its live BTC/USDC and ETH/USDC markets. Fixture tests cover equivalent catalog retention during Capricorn quote-probe failures.

Unverified endpoint identity probes now use the same scoped transport and cancellation signal as the quote they precede. Canceled probes cannot commit endpoint health. Size-availability hints expire explicitly when depth stops updating. SharedWorker cleanup waits for acknowledgement before closing its port; an unresponsive worker retains the existing lease fallback. Worker-port readiness does not satisfy stream readiness: a stalled initial connection or reconnect falls back after five seconds. Explicit upstream-socket heartbeats keep healthy idle streams alive. Browser tests exercise prompt topic release, page restoration and direct-socket fallback.

Lunarbase settles every pool, size and bid/ask sibling before returning a rejected quote task. Regressions force sizing and leg failures with other reads held open, both before and after the deadline, and verify that the adapter slot and shared state stay protected until the last sibling settles. A [live settlement check](benchmarks/v2-review-settlement-live.json) at block 105678864 forced a local sizing failure while holding completion of two real pool-quote reads. The 20ms deadline returned an empty frame while the slot remained occupied; releasing both reads rejected the canceled task and made the slot reusable. The pool was paused and still retained its fill source. This checks settlement and cancellation, not executable prices or a latency bound.

Full legacy snapshots require every requested adapter to complete; deadline, rejected-task and occupied-slot frames remain available on v2 with their existing telemetry but cannot complete a legacy handoff or replace its complete matrix. `/api/bootstrap` and `/api/fills` return retryable HTTP 503 until persisted history has loaded. The browser retries independently of socket reconnection and retains fills arriving during failed requests. Legacy startup endpoints keep their empty HTTP 200 contract. State cannot regress behind bootstrap or a newer stream frame, and SharedWorker replay excludes aged snapshots and disconnected caches.

Uniswap's discovered catalog and the monotonic admitted catalogs for Metric and Capricorn survive transient discovery-read failures independently of current quotability. Metric coalesces concurrent plans at the same block/client/signal into one constructor call, then splits results back into the original leg order. Unsupported helpers share their probe and wait for all fallback results before committing cooldown. A later plan waits for an active probe instead of duplicating it.

The [live concurrent-plan comparison](benchmarks/v2-review-metric-plans-live.json) at block 105682776 compares the adapter at `dfb0b10` with the shared path. BTC/USDC $100 and ETH/USDC $1,000 results match exactly except timestamps. Constructor calls fall from two to one. Injecting an unsupported-helper response also reduces attempted probes from two to one while retaining four real fallback multicalls. This uses fixed test sizing anchors and one observation per case; it establishes request counts and row equivalence, not a latency improvement estimate.

The Metric test alternates call order at the same pinned block over 12 trials after a warmup. All 72 leg results matched exactly: 48 executable quotes and 24 zero-output results; no failed legs. The zero-output seed pool was independently reported unfunded by live discovery. A real WBTC/USDC buy at block 105636167 returned deltas `-130896` and `100000000`: 8 base decimals give `0.00130896 WBTC`, 6 quote decimals give `100 USDC`, and `100 / 0.00130896 = 76396.52854174306 USDC/WBTC`. Both paths returned the same raw integers. The sample is small; raw tail timings are retained.

Analytics results matched exactly over 100,000 persisted fills. With a 128MB worker JS-heap cap, uncached aggregation after warmup took 1.19s vs 0.65s and used 1,160ms vs 719ms CPU; measured process RSS was 303MB vs 330MB in fresh child processes. This deliberately exchanges some compute time for bounded heap and a responsive main loop. The cap excludes native/typed-array memory. It is not a promise that a 512MB production instance can fit every 30-day dataset. Caching avoids repeating this computation per viewer; the edge regression serves 100 sequential requests from one origin response, and a corrected revision fetches independently.

The [one-million-fill run](benchmarks/v2-runtime-million.json) also produced identical results: main-loop p95 delay fell from 192.8ms to 0.66ms, while aggregation took 12.33s vs 11.23s and process CPU rose from 11.39s to 13.36s. Measured peak RSS was 395MB vs 461MB in the isolated benchmark. Production still needs headroom for ingestion, adapters, depth and sockets.

The [markout benchmark](benchmarks/v2-markouts.json) compares the previous synchronous linear scan with the actual updated `LiveDataSource` pass over 10,000 and 50,000 fills. All five horizons are due, with 1,201 reference samples at 100ms intervals. After warmup, three alternating trials produced exactly matching fill results. At 50,000 fills, median process CPU fell from 311.0ms to 82.3ms. The 2ms event-loop probe measured a largest stall of 3.1ms during yielding passes versus 308.0ms during synchronous passes. This synthetic burst excludes RPC, persistence, socket fanout, fixture construction and result hashing; it demonstrates reduced markout cost, not a production latency bound.

A [live markout check](benchmarks/v2-markout-live.json) observed 67 scoped quote frames and verified a Metric WBTC/USDC buy at block 105654798 against its receipt: deltas `-819873` and `627742813`, with on-chain decimals 8 and 6, give `0.00819873 WBTC`, `627.742813 USDC`, and `76565.8599563591 USDC/WBTC`. The pair-terms reference sample 28ms from the five-second horizon was `76540.93452806244`; `(mid / execPx - 1) × 10000` equals the emitted `-3.2554232801496052 bps`. Lunarbase's `paused()` was true at the checked block; it correctly emitted no quotes while retaining its fill sources. This validates its live gate, while executable quotes and ignored-cancellation races are covered by fixtures. The check is not a production load or block-coverage benchmark.

The live end-to-end sample used one Metric BTC/USDC $1k subscriber with gzip and no WebSocket compression extension. All 28 emitted frames contained executable Metric quotes; median compute was 44ms and maximum 162ms. The **HTTP-only pipeline delivered 28 of 60 blocks (46.7% coverage)**. Isolating the HTTP head lane did not eliminate those gaps; the measurement does not distinguish provider freshness from head-receiving behavior. This run validates processing and transport, **not full 300ms coverage**. Compare the provider's raw head feed with application observations, then measure `RPC_WS_URL`/HOT configurations before treating every-block delivery as achieved. Blockchain-to-browser latency includes provider observation delay and network transit in addition to these compute timings.

## Reproduce

Run benchmarks individually, without concurrent load generators. They write JSON to the specified path. The delivery fixture is public quote data; runtime uses a disposable database. Live commands use read-only RPC calls and a disposable local store.

```sh
npm ci
npm run typecheck
npm -w server run test
npm -w web run test
npm run build
npx playwright install chromium
npm -w web run test:e2e
node server/scripts/compile-metric-helper.mjs --check
npm -w server run benchmark:delivery -- /tmp/delivery.json
npm -w server run benchmark:runtime -- /tmp/runtime.json
BENCHMARK_FILLS=1000000 npm -w server run benchmark:runtime -- /tmp/runtime-million.json
npm -w server run benchmark:markouts -- /tmp/markouts.json
npm -w server run benchmark:heads -- /tmp/heads.json
npm -w server run benchmark:metric -- /tmp/metric.json
```

For the live stream test, run a local backend with `DATA_SOURCE=live VENUES=metric BACKFILL=off MARKOUT_BACKFILL=off GAS_METRIC=off DB_PATH=/tmp/mpamm-live-check.db API_PORT=8894 npm -w server run start`, then `npm -w server run benchmark:live -- ws://127.0.0.1:8894/stream /tmp/live-stream.json`. Configure the RPC/CEX environment normally; the report contains no provider URLs or credentials. Keep the configured node close to the deployment region.

## Protocol and rollout

A v2 connection sends a complete replacement subscription set:

```json
{"type":"subscribe","topics":[{"channel":"state"},{"channel":"quotes","market":"MON/USDC","sizeUsd":1000,"baseline":false},{"channel":"depth","market":"MON/USDC"}]}
```

Topics are validated against the market/size registry and bounded to 128 per connection. Responses wrap `{v:2, epoch, topic, seq, snapshot?, message}`. `mpamm.v2.gzip` receives gzip binary frames for larger messages, including initial snapshots, and ordinary JSON text for small events; `mpamm.v2.json` receives text. Epoch changes, connection drops and fill sequence gaps trigger a REST resync. State travels at most once per second; quote/depth cadence remains independent. `/api/health` exposes stream connection/topic counts, compression jobs, byte counters, coalescing and slow-client cuts, labeled `protocol: "v2"`; these counters exclude legacy sockets.

WebSocket negotiation explicitly prefers `mpamm.v2.gzip` when offered, otherwise `mpamm.v2.json`; unsupported protocols are not selected. A connection offering no subprotocol retains the legacy stream.

Unchanged analytics data reuses its existing immutable artifact and original `generatedAt`, even after the aggregation TTL expires. A regression checks 100 timestamp-only refreshes plus simultaneous requests reuse the same artifact; a corrected fill produces a new revision. The URL remains a hash of the exact bytes, so neither a refresh nor a restart changes a published response in place.

The backend and frontend ship together. The standalone [edge worker](../infra/analytics-cache-worker.ts) and [route configuration](../infra/wrangler.analytics.toml) are prepared for review, **not deployed by this PR**. After the backend deployment, deploy with `npx wrangler deploy --config infra/wrangler.analytics.toml` from an account authorized for the zone. It caches only immutable public aggregate successes; manifests, errors, personalized requests and live endpoints pass through. The [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) is local to an edge location and can evict objects. A first request/miss still reaches Render; validate cache hits and origin bytes before claiming bill reductions. The application works without this optional deployment.

Operator controls:

- `QUOTE_DEADLINE_MS=250`: tune against missing venues and frame tails; increasing it trades coverage for more complete slow-provider frames.
- `QUOTE_HTTP_BATCH=off`, `QUOTE_HTTP_BATCH_SIZE=8`: HTTP scheduling; Multicall3 remains active.
- `METRIC_BATCH_QUOTE=off`: restore the original Metric read path immediately.
- `ANALYTICS_WORKER_HEAP_MB=128`: worker JS heap budget. Monitor process RSS and 30-day aggregation success; native memory is additional.
- `RPC_WS_URL`, `HEAD_POLL_MS=75`: block observation and fallback. Check coverage as well as compute time.

Before rollout, compare measured byte rates, p95 head-to-frame latency, block coverage, missing venues, worker failures and RSS on the actual Render instance under representative selections/history load. A rollback redeploys the previous application image; there is no database migration or helper contract to undo. Disable the optional edge route independently if needed; content-addressed URLs never change existing results.

A Rust rewrite is outside this change. The measured egress reduction comes from demand, payload shape, shared compression and caching; changing language alone would not deliver it. A later Rust component should be justified by profiles of remaining CPU/memory work and an equivalent replay benchmark.
