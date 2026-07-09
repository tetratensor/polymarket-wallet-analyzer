/**
 * Cross-source correctness audit for a wallet.
 *   node scripts/verify.mjs <wallet> [days]
 *
 * Checks our numbers against independent Polymarket endpoints:
 *  1. Fill completeness:  /trades (what we use) vs /activity type=TRADE row count
 *  2. Volume:             notional (price × shares) vs actual cash moved (usdcSize, incl. fees)
 *  3. Account PnL:        official user-pnl curve delta (profile-page graph)
 *  4. Settled bets PnL:   sum of /closed-positions realizedPnl in window
 *  5. Open positions:     sum of currentValue vs official /value portfolio endpoint
 *  6. Reference only:     lb-api leaderboard profit/volume (different internal definitions)
 */
import { fetchAllTrades } from '../lib/fetchTrades.js';
import { fetchClosedPositions, fetchOpenPositions, fetchPnlSeries } from '../lib/fetchPositions.js';

const wallet = (process.argv[2] || '').toLowerCase();
const days = parseInt(process.argv[3], 10) || 30;
if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
  console.error('usage: node scripts/verify.mjs <0x wallet> [days]');
  process.exit(1);
}
const endTs = Math.floor(Date.now() / 1000);
const startTs = endTs - days * 86400;

// /activity has the same 3000-offset cap as /trades; paginate with the same
// moving time cursor (drop the possibly-partial oldest second, refetch it).
async function fetchActivityTrades() {
  const out = [];
  let windowEnd = endTs;
  for (;;) {
    const windowRows = [];
    let done = false;
    for (let offset = 0; offset <= 3000; offset += 500) {
      const url = `https://data-api.polymarket.com/activity?user=${wallet}&type=TRADE&limit=500&offset=${offset}&start=${startTs}&end=${windowEnd}`;
      const page = await (await fetch(url)).json();
      if (!Array.isArray(page)) throw new Error(JSON.stringify(page).slice(0, 200));
      windowRows.push(...page.filter((r) => r.timestamp >= startTs && r.timestamp <= endTs));
      if (page.length < 500) { done = true; break; }
    }
    if (done) { out.push(...windowRows); break; }
    const oldest = windowRows.reduce((a, r) => (r.timestamp < a ? r.timestamp : a), Infinity);
    const keep = windowRows.filter((r) => r.timestamp > oldest);
    if (keep.length === 0) throw new Error('activity pagination stuck');
    out.push(...keep);
    windowEnd = oldest;
  }
  return out;
}

const pct = (a, b) => (b === 0 ? '—' : `${(100 * (a / b - 1)).toFixed(2)}%`);
const usd = (v) => `$${v.toFixed(2)}`;

console.log(`auditing ${wallet}, last ${days} days\n`);

const [trades, activity, closed, open, series] = await Promise.all([
  fetchAllTrades(wallet, { startTs, endTs }),
  fetchActivityTrades(),
  fetchClosedPositions(wallet, { startTs, endTs }),
  fetchOpenPositions(wallet),
  fetchPnlSeries(wallet, { days }),
]);

console.log('1) fill completeness');
console.log(`   /trades fills: ${trades.length}   /activity TRADE rows: ${activity.length}   ${trades.length === activity.length ? 'MATCH' : 'MISMATCH'}`);

const notional = trades.reduce((a, t) => a + t.price * t.size, 0);
const cash = activity.reduce((a, r) => a + (r.usdcSize || 0), 0);
console.log('\n2) volume');
console.log(`   notional (ours): ${usd(notional)}   cash moved incl. fees: ${usd(cash)}   fee drag: ${pct(cash, notional)}`);

console.log('\n3) account PnL (official curve delta over window)');
if (series.length >= 2) {
  console.log(`   ${usd(series[series.length - 1].p - series[0].p)}  (${series.length} curve points)`);
} else {
  console.log('   no curve data');
}

const tradedAssets = new Set(trades.map((t) => t.asset));
const closedTraded = closed.filter((p) => tradedAssets.has(p.asset));
console.log('\n4) settled bets PnL (dashboard definition: settled positions traded in window)');
console.log(`   ${usd(closedTraded.reduce((a, p) => a + p.realizedPnl, 0))} over ${closedTraded.length} positions`);
console.log(`   (all settlements recorded in window regardless of trade date: ${usd(closed.reduce((a, p) => a + p.realizedPnl, 0))} over ${closed.length} — includes Polymarket's late batch-recorded settlements of older bets)`);

const openValue = open.reduce((a, p) => a + (p.currentValue || 0), 0);
const official = await (await fetch(`https://data-api.polymarket.com/value?user=${wallet}`)).json();
const officialValue = official?.[0]?.value ?? NaN;
console.log('\n5) open portfolio value');
console.log(`   sum of positions: ${usd(openValue)}   official /value: ${usd(officialValue)}   diff: ${pct(openValue, officialValue)}`);

console.log('\n6) leaderboard reference (different internal definitions, not expected to match)');
for (const [name, api] of [['volume', 'volume'], ['profit', 'profit']]) {
  const w = days <= 7 ? '7d' : '30d';
  const d = await (await fetch(`https://lb-api.polymarket.com/${api}?window=${w}&limit=1&address=${wallet}`)).json();
  console.log(`   lb ${name} (${w}): ${d?.[0] ? usd(d[0].amount) : 'n/a'}`);
}
