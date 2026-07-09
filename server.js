import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllTrades } from './lib/fetchTrades.js';
import { fetchClosedPositions, fetchOpenPositions, fetchPnlSeries } from './lib/fetchPositions.js';
import { analyzeTrades, analyzePnl } from './lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/lib', express.static(path.join(__dirname, 'lib')));
app.use('/vendor/echarts.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'echarts', 'dist', 'echarts.min.js'))
);

const cache = new Map(); // key -> { at, promise }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50; // payloads can be tens of MB for whale wallets

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.promise;
}

function cacheSet(key, promise) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    cache.delete(oldestKey);
  }
  cache.set(key, { at: Date.now(), promise });
}

function parseWalletInput(raw) {
  const s = String(raw || '').trim();
  // allow pasting a profile URL like https://polymarket.com/profile/0xabc...
  const m = s.match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0].toLowerCase() : null;
}

app.get('/api/analyze', async (req, res) => {
  const wallet = parseWalletInput(req.query.wallet);
  if (!wallet) {
    return res.status(400).json({ error: 'Provide a valid wallet address (0x…, 40 hex chars) or Polymarket profile URL.' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);

  // Cache the in-flight promise, not just the result, so concurrent requests
  // for the same wallet share one upstream fetch instead of stampeding.
  const key = `${wallet}:${days}`;
  let promise = cacheGet(key);
  if (!promise) {
    promise = buildPayload(wallet, days);
    cacheSet(key, promise);
    promise.catch(() => cache.delete(key)); // don't cache failures
  }

  try {
    res.json(await promise);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Failed to fetch data: ${err.message}` });
  }
});

async function buildPayload(wallet, days) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - days * 86400;

  const [raw, closedRaw, openRaw, pnlSeries] = await Promise.all([
    fetchAllTrades(wallet, { startTs, endTs }),
    fetchClosedPositions(wallet, { startTs, endTs }),
    fetchOpenPositions(wallet),
    fetchPnlSeries(wallet, { days }),
  ]);

  // The closed-positions `timestamp` is when Polymarket recorded settlement,
  // which for losing positions can be a batch sweep weeks after the market
  // ended (verified). Keying the window on that timestamp drags in old bets,
  // so we only keep settled positions the wallet actually traded in-window.
  const tradedAssets = new Set(raw.map((t) => t.asset));
  const closedPositions = closedRaw
    .filter((p) => tradedAssets.has(p.asset))
    .map((p) => ({
      t: p.timestamp,
      betUsdc: p.avgPrice * p.totalBought,
      pnl: p.realizedPnl,
      entryPrice: p.avgPrice,
      title: p.title || '',
      outcome: p.outcome || '',
    }));

  const openSummary = {
    count: openRaw.length,
    value: openRaw.reduce((a, p) => a + (p.currentValue || 0), 0),
    unrealizedPnl: openRaw.reduce((a, p) => a + (p.cashPnl || 0), 0),
  };

  const trades = raw.map((t) => ({
    t: t.timestamp,
    side: t.side, // 'BUY' | 'SELL'
    price: t.price,
    size: t.size,
    usdc: t.price * t.size,
    title: t.title || '',
    outcome: t.outcome || '',
    slug: t.eventSlug || t.slug || '',
  }));

  const profile = raw.length
    ? { name: raw[0].name || raw[0].pseudonym || '', pseudonym: raw[0].pseudonym || '' }
    : null;

  return {
    wallet,
    days,
    range: { startTs, endTs },
    profile,
    summary: analyzeTrades(trades),
    trades,
    pnl: {
      settled: analyzePnl(closedPositions),
      positions: closedPositions,
      open: openSummary,
      series: pnlSeries,
    },
  };
}

app.listen(PORT, () => {
  console.log(`Polymarket wallet analyzer running at http://localhost:${PORT}`);
});
