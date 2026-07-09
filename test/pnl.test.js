import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePnl } from '../lib/stats.js';
import { fetchClosedPositions } from '../lib/fetchPositions.js';

test('analyzePnl core metrics', () => {
  const positions = [
    { betUsdc: 100, pnl: 50, entryPrice: 0.5 },   // win, roi 0.5
    { betUsdc: 200, pnl: -200, entryPrice: 0.25 }, // loss, roi -1
    { betUsdc: 50, pnl: 25, entryPrice: 0.85 },   // win, roi 0.5
    { betUsdc: 10, pnl: 0, entryPrice: 0.85 },    // breakeven
  ];
  const r = analyzePnl(positions);
  assert.equal(r.n, 4);
  assert.equal(r.totalPnl, -125);
  assert.equal(r.wins, 2);
  assert.equal(r.losses, 1);
  assert.equal(r.winRate, 0.5);
  assert.equal(r.grossProfit, 75);
  assert.equal(r.grossLoss, 200);
  assert.equal(r.profitFactor, 75 / 200);
  assert.equal(r.avgWin, 37.5);
  assert.equal(r.avgLoss, -200);
  assert.equal(r.biggestWin, 50);
  assert.equal(r.biggestLoss, -200);

  // bands: 0.25 -> band 2 (20-30¢); 0.5 -> band 5; 0.85 x2 -> band 8
  assert.equal(r.bands[2].count, 1);
  assert.equal(r.bands[2].totalPnl, -200);
  assert.equal(r.bands[2].winRate, 0);
  assert.equal(r.bands[5].count, 1);
  assert.equal(r.bands[5].winRate, 1);
  assert.equal(r.bands[8].count, 2);
  assert.equal(r.bands[8].winRate, 0.5);
  assert.equal(r.bands[8].totalPnl, 25);
  assert.equal(r.bands[0].count, 0);
  assert.equal(r.bands[0].winRate, null);
});

test('analyzePnl band edges: entryPrice 1.0 falls in the last band', () => {
  const r = analyzePnl([{ betUsdc: 10, pnl: 1, entryPrice: 1 }]);
  assert.equal(r.bands[9].count, 1);
});

test('analyzePnl empty input', () => {
  const r = analyzePnl([]);
  assert.equal(r.n, 0);
  assert.equal(r.totalPnl, 0);
  assert.ok(Number.isNaN(r.winRate));
});

function mockClosedApi(all) {
  // API sorts newest-first when sortBy=TIMESTAMP&sortDirection=DESC and clamps limit to 50
  const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp);
  return async (url) => {
    const u = new URL(url);
    const limit = Math.min(Number(u.searchParams.get('limit')), 50);
    const offset = Number(u.searchParams.get('offset')) || 0;
    return { ok: true, status: 200, json: async () => sorted.slice(offset, offset + limit) };
  };
}

test('fetchClosedPositions pages until it leaves the window, keeps exact range', async () => {
  const all = [];
  for (let i = 0; i < 400; i++) {
    all.push({ timestamp: 1_000_000 + i * 100, realizedPnl: i, avgPrice: 0.5, totalBought: 10 });
  }
  const startTs = 1_000_000 + 150 * 100; // keep newest 250
  const got = await fetchClosedPositions('0xabc', {
    startTs, endTs: 2_000_000, fetchImpl: mockClosedApi(all),
  });
  assert.equal(got.length, 250);
  assert.ok(got.every((p) => p.timestamp >= startTs));
});

test('fetchClosedPositions respects endTs upper bound', async () => {
  const all = [];
  for (let i = 0; i < 100; i++) {
    all.push({ timestamp: 1_000_000 + i * 100, realizedPnl: i });
  }
  const got = await fetchClosedPositions('0xabc', {
    startTs: 1_000_000, endTs: 1_002_000, fetchImpl: mockClosedApi(all),
  });
  assert.equal(got.length, 21); // timestamps 1_000_000 .. 1_002_000 inclusive
});
