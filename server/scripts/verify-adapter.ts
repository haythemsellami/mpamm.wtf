/**
 * Live adapter verification checklist (docs/adapters.md → "Verifying your adapter"):
 *
 *   npm -w server run verify-adapter -- <venueId>
 *
 * Exercises the adapter against the REAL chain — discovery, quoting, log
 * decoding — and prints a PASS/WARN/FAIL report plus a ready-to-paste test
 * fixture (raw log + decoded fill). Read-only; no DB writes. Paste the output
 * into your PR.
 */
import { ASSETS, PAIRS, pairOf } from '@shared';
import { config } from '../src/config.js';
import { publicClient, getLogsChunked, probeChain } from '../src/chain/rpc.js';
import { UsdPricer } from '../src/pricer.js';
import { ADAPTERS, REFERENCES, validateRegistry } from '../src/venues/registry.js';
import type { AdapterContext, LogBundle } from '../src/venues/adapter.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const results: Array<[level: 'PASS' | 'WARN' | 'FAIL', msg: string]> = [];
const pass = (m: string) => results.push(['PASS', m]);
const warn = (m: string) => results.push(['WARN', m]);
const fail = (m: string) => results.push(['FAIL', m]);

const venueId = process.argv[2];
if (!venueId) {
  console.error('usage: npm -w server run verify-adapter -- <venueId>');
  process.exit(2);
}

validateRegistry();
const adapter = ADAPTERS.find((a) => a.venues().some((v) => v.id === venueId));
if (!adapter) {
  console.error(`no adapter declares venue '${venueId}' — registered: ${ADAPTERS.flatMap((a) => a.venues().map((v) => v.id)).join(', ')}`);
  process.exit(2);
}
const meta = adapter.venues().find((v) => v.id === venueId)!;
console.log(`\n■ verifying '${meta.name}' (${venueId}, role ${meta.role}) against ${config.rpcHttp.replace(/(:\/\/[^/]+).*/, '$1/…')}\n`);

const probe = await probeChain();
if (!probe.ok) { console.error(`chain probe failed: ${probe.reason}`); process.exit(1); }
pass(`chain reachable (block ${probe.block})`);

// meta checks
if (/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) pass('venue id is kebab-case'); else fail(`invalid venue id '${meta.id}'`);
if (/^#[0-9A-Fa-f]{6}$/.test(meta.color.light) && /^#[0-9A-Fa-f]{6}$/.test(meta.color.dark)) pass('both theme colors set'); else fail('color.light/color.dark must be #rrggbb');
if (meta.role === 'venue') {
  if (meta.sinceUtc) pass(`sinceUtc = ${meta.sinceUtc}`); else fail('display venues need sinceUtc (per-day views + gas anchor)');
  if (adapter.backfillFromUtc) pass(`backfillFromUtc = ${adapter.backfillFromUtc}`); else warn('no backfillFromUtc — lifetime volume will not backfill');
}

// warm the CEX references (quotes anchor on pairMid)
console.log('… warming CEX reference feeds');
await REFERENCES.start();
const t0 = Date.now();
while (Date.now() - t0 < 25_000 && Object.values(ASSETS).some((a) => REFERENCES.assetUsd(a.key) <= 0)) await sleep(500);
const cold = Object.values(ASSETS).filter((a) => REFERENCES.assetUsd(a.key) <= 0).map((a) => a.key);
if (cold.length) warn(`reference mids not warm for ${cold.join(',')} — quotes for those pairs will be absent`);
else pass('reference mids warm');

const ctx: AdapterContext = {
  client: publicClient,
  getLogs: getLogsChunked,
  pricer: new UsdPricer((k) => REFERENCES.assetUsd(k), (m) => REFERENCES.midForPair(m)),
  config,
  note: (code, msg) => console.log(`  [adapter] ${code}: ${msg}`),
};

// discovery
try {
  await adapter.discover(ctx);
  pass('discover() completed');
} catch (e) {
  fail(`discover() threw: ${(e as Error).message}`);
}

// quotes
if (adapter.quote) {
  try {
    const quoteBlock = await publicClient.getBlockNumber();
    const rows = (await adapter.quote(ctx, config.sizesUsd, quoteBlock)).filter((r) => r.venueId === venueId);
    if (!rows.length) warn('quote() returned 0 rows for this venue (no pools/books live, or references cold?)');
    const byMarket = new Map<string, number>();
    for (const r of rows) byMarket.set(r.market, (byMarket.get(r.market) ?? 0) + 1);
    console.log(`  quotes: ${rows.length} row(s) across ${byMarket.size} market(s): ${[...byMarket.keys()].join(', ')}`);
    for (const r of rows) {
      if (!pairOf(r.market)) fail(`quote row for UNREGISTERED market ${r.market}`);
      const worst = Math.max(Math.abs(r.bidBps), Math.abs(r.askBps));
      if (worst > 500) warn(`${r.market} $${r.sizeUsd}: |bps| ${worst.toFixed(0)} vs mid — decode/scaling bug or genuinely wide venue?`);
    }
    if (rows.length) {
      const s = rows[0];
      console.log(`  sample: ${s.market} $${s.sizeUsd} bid ${s.bidBps.toFixed(1)}bps ask ${s.askBps.toFixed(1)}bps (fee ${s.feeBps}bps${s.oneSided ? ', one-sided' : ''})`);
      pass('quote() emits registered-pair rows');
    }
  } catch (e) {
    fail(`quote() threw: ${(e as Error).message}`);
  }
} else if (meta.role === 'venue') warn('no quote() — venue will not appear on the Execution tab');

// log tail + decode over a recent window
let sources: ReturnType<typeof adapter.logSources> = [];
try { sources = adapter.logSources(); } catch (e) { fail(`logSources() threw after discovery: ${(e as Error).message}`); }
if (meta.role === 'baseline') {
  if (sources.length === 0) pass('baseline is quote-only (no log sources)');
  else fail('baseline venues must not declare log sources');
} else if (!sources.length) {
  warn('logSources() is empty — no fills will ever be tailed');
} else {
  console.log(`  log sources: ${sources.map((s) => `${s.key}(${s.kind ?? 'fills'})`).join(', ')}`);
  const head = (await publicClient.getBlockNumber()) - 5n;
  const SPAN = 3_000n; // ~20 min of Monad
  const bundle: LogBundle = {};
  try {
    for (const s of sources) bundle[s.key] = (await getLogsChunked({ address: s.address as any, fromBlock: head - SPAN, toBlock: head, events: s.events as any })) as any[];
    const nLogs = Object.values(bundle).reduce((a, l) => a + l.length, 0);
    const tsOf = () => Date.now(); // checklist only — daily bucketing precision is irrelevant here
    const fills = (await adapter.decode(ctx, bundle, tsOf, new Set())).filter((f) => f.venueId === venueId);
    console.log(`  last ${SPAN} blocks: ${nLogs} log(s) → ${fills.length} fill(s)`);
    if (!nLogs) warn(`no logs in the last ${SPAN} blocks — quiet venue or wrong addresses/events?`);
    for (const f of fills) {
      if (!pairOf(f.market)) fail(`fill for UNREGISTERED market ${f.market}`);
      if (!(f.usd > 0) || !(f.baseAmount > 0)) fail(`fill ${f.id}: non-positive usd/baseAmount`);
      if (!f.pxApprox && !(f.execPx > 0)) fail(`fill ${f.id}: non-positive execPx without pxApprox`);
      if (!f.id.includes(f.txHash.toLowerCase()) && !f.id.includes(f.txHash)) warn(`fill id '${f.id}' doesn't embed the tx hash — is it deterministic?`);
    }
    if (fills.length) {
      const f = fills[0];
      pass('decode() produces well-formed fills');
      console.log(`  sample fill: ${f.market} ${f.side} $${f.usd.toFixed(2)} @ ${f.execPx} (${f.id})`);
      const rawKey = Object.keys(bundle).find((k) => bundle[k].some((l: any) => String(l.transactionHash).toLowerCase() === f.txHash.toLowerCase()));
      const raw = rawKey ? bundle[rawKey].find((l: any) => String(l.transactionHash).toLowerCase() === f.txHash.toLowerCase()) : undefined;
      if (raw) {
        console.log('\n  ── paste-ready test fixture (docs/adapters.md → Tests) ──');
        console.log('  raw log:', JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
        console.log('  decoded:', JSON.stringify(f));
      }
      console.log(`\n  → hand-verify this fill on the explorer: https://monadscan.com/tx/${f.txHash}`);
    }
  } catch (e) {
    fail(`tail/decode failed: ${(e as Error).message}`);
  }
}

// gas sources
if (adapter.gasSources) {
  try {
    const gs = adapter.gasSources();
    pass(`gasSources(): ${gs.map((g) => `${g.mode}@${Array.isArray(g.address) ? g.address.length + ' addrs' : g.address.slice(0, 10)}…`).join(', ')}`);
  } catch {
    warn('gasSources() threw (destination not resolved yet?) — the gas tracker will retry after discovery');
  }
} else if (meta.role === 'venue') {
  warn('no gasSources() — say in your PR who pays for quote updates and why it is not the venue');
}

REFERENCES.stop();

console.log('\n■ report');
for (const [lvl, msg] of results) console.log(`  ${lvl === 'PASS' ? '✓' : lvl === 'WARN' ? '⚠' : '✗'} ${lvl}  ${msg}`);
const fails = results.filter(([l]) => l === 'FAIL').length;
console.log(`\n${fails ? `✗ ${fails} failure(s)` : '✓ all checks passed'} · ${results.filter(([l]) => l === 'WARN').length} warning(s)\n`);
process.exit(fails ? 1 : 0);
