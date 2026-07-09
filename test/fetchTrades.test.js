import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllTrades } from '../lib/fetchTrades.js';

/**
 * Builds a mock of the Polymarket /trades endpoint over a fixed trade set:
 * newest-first ordering, start/end inclusive filtering, limit/offset paging,
 * and the real API's max-offset-3000 rule.
 */
function mockApi(allTrades) {
  const sorted = [...allTrades].sort((a, b) => b.timestamp - a.timestamp);
  return async (url) => {
    const u = new URL(url);
    const start = Number(u.searchParams.get('start'));
    const end = Number(u.searchParams.get('end'));
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    if (offset > 3000) {
      return { ok: false, status: 400, text: async () => 'max historical activity offset of 3000 exceeded' };
    }
    const inRange = sorted.filter((t) => t.timestamp >= start && t.timestamp <= end);
    const page = inRange.slice(offset, offset + limit);
    return { ok: true, status: 200, json: async () => page };
  };
}

function makeTrades(n, { perSecond = 1, startTs = 1_700_000_000 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: startTs + Math.floor(i / perSecond),
      transactionHash: `0x${i.toString(16)}`,
      asset: 'a',
      side: 'BUY',
      price: 0.5,
      size: 1,
    });
  }
  return out;
}

test('fetches everything when under one page', async () => {
  const all = makeTrades(37);
  const got = await fetchAllTrades('0xabc', {
    startTs: 1_699_999_000, endTs: 1_800_000_000, fetchImpl: mockApi(all),
  });
  assert.equal(got.length, 37);
});

test('fetches exactly all trades across the 3000-offset cap (no dupes, no loss)', async () => {
  const all = makeTrades(9137, { perSecond: 3 }); // forces 3 cursor windows
  const got = await fetchAllTrades('0xabc', {
    startTs: 1_699_999_000, endTs: 1_800_000_000, fetchImpl: mockApi(all),
  });
  assert.equal(got.length, 9137);
  // every original trade present exactly once
  const seen = new Set(got.map((t) => t.transactionHash));
  assert.equal(seen.size, 9137);
});

test('identical duplicate fills (same tx/price/size/second) are preserved, not deduped away', async () => {
  const all = makeTrades(4500, { perSecond: 5 });
  // make two fills fully identical
  all[100] = { ...all[101] };
  const got = await fetchAllTrades('0xabc', {
    startTs: 1_699_999_000, endTs: 1_800_000_000, fetchImpl: mockApi(all),
  });
  assert.equal(got.length, 4500);
});

test('respects the time range strictly', async () => {
  const all = makeTrades(100); // one per second from 1_700_000_000
  const got = await fetchAllTrades('0xabc', {
    startTs: 1_700_000_010, endTs: 1_700_000_019, fetchImpl: mockApi(all),
  });
  assert.equal(got.length, 10);
  assert.ok(got.every((t) => t.timestamp >= 1_700_000_010 && t.timestamp <= 1_700_000_019));
});

test('throws instead of returning partial data when one second exceeds the cap', async () => {
  const all = makeTrades(5000, { perSecond: 5000 }); // all in one second
  await assert.rejects(
    fetchAllTrades('0xabc', { startTs: 1_699_999_000, endTs: 1_800_000_000, fetchImpl: mockApi(all) }),
    /Pagination stuck/
  );
});
