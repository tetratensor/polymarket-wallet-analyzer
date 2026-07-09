import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, quantile, pearson, spearman, ranks, histogram, inferUtcOffset, analyzeTrades,
} from '../lib/stats.js';

test('mean and quantile', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(mean([])));
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5); // interpolated
  assert.equal(quantile([10], 0.9), 10);
  assert.equal(quantile([0, 10], 0.25), 2.5);
});

test('pearson known values', () => {
  // perfectly linear
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3], [6, 4, 2]) + 1) < 1e-12);
  // hand-derived: sxy=3.5, sxx=8.75, syy=5 -> r = 3.5/sqrt(43.75)
  assert.ok(Math.abs(pearson([1, 2, 3, 5], [2, 1, 4, 3]) - 3.5 / Math.sqrt(43.75)) < 1e-12);
  // zero variance -> NaN
  assert.ok(Number.isNaN(pearson([1, 1, 1], [1, 2, 3])));
});

test('ranks with ties (fractional)', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.deepEqual(ranks([5, 5, 5]), [2, 2, 2]);
});

test('spearman known values', () => {
  // monotonic but nonlinear -> rho = 1
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 4, 9, 100]) - 1) < 1e-12);
  // verified against scipy.stats.spearmanr([1,2,3,4,5],[5,6,7,8,7]) = 0.8207826816681233
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]) - 0.8207826816681233) < 1e-9);
});

test('histogram edges: half-open bins, inclusive last edge, out-of-range ignored', () => {
  const edges = [0, 10, 20, 30];
  assert.deepEqual(histogram([0, 5, 10, 15, 29.999, 30], edges), [2, 2, 2]);
  assert.deepEqual(histogram([-1, 31], edges), [0, 0, 0]);
  assert.deepEqual(histogram([], edges), [0, 0, 0]);
});

test('inferUtcOffset finds quiet window and maps to offset', () => {
  // Simulate a trader in UTC+0: asleep 01:00-08:00, active otherwise
  const hours = new Array(24).fill(20);
  for (let h = 1; h < 8; h++) hours[h] = 0;
  const r = inferUtcOffset(hours);
  assert.equal(r.sleepStartUtc, 1);
  assert.equal(r.utcOffset, 0);
  assert.equal(r.confidence, 'high');

  // Same trader shifted to UTC+8 (asleep 01-08 local = 17-24 UTC)
  const hours8 = new Array(24).fill(20);
  for (let h = 0; h < 7; h++) hours8[(17 + h) % 24] = 0;
  const r8 = inferUtcOffset(hours8);
  assert.equal(r8.sleepStartUtc, 17);
  assert.equal(r8.utcOffset, 8);
});

test('inferUtcOffset: insufficient or uniform data', () => {
  assert.equal(inferUtcOffset(new Array(24).fill(1)).confidence, 'none'); // total 24 < 30
  const uniform = new Array(24).fill(100);
  const r = inferUtcOffset(uniform);
  assert.equal(r.confidence, 'low');
});

test('analyzeTrades end-to-end aggregation', () => {
  const trades = [
    // 2026-01-05 was a Monday; 10:30 UTC
    { t: Date.UTC(2026, 0, 5, 10, 30) / 1000, side: 'BUY', price: 0.5, size: 100, usdc: 50 },
    { t: Date.UTC(2026, 0, 5, 10, 45) / 1000, side: 'BUY', price: 0.25, size: 400, usdc: 100 },
    { t: Date.UTC(2026, 0, 6, 22, 0) / 1000, side: 'SELL', price: 0.8, size: 100, usdc: 80 },
  ];
  const s = analyzeTrades(trades);
  assert.equal(s.counts.total, 3);
  assert.equal(s.counts.buys, 2);
  assert.equal(s.counts.sells, 1);
  assert.equal(s.volume.total, 230);
  assert.equal(s.volume.buy, 150);
  assert.equal(s.betSize.median, 75);
  assert.equal(s.betSize.max, 100);
  assert.equal(s.entryPrice.median, 0.375);
  assert.equal(s.exitPrice.median, 0.8);
  assert.equal(s.hourCounts[10], 2);
  assert.equal(s.hourCounts[22], 1);
  assert.equal(s.dowHour[1][10], 2); // Monday 10:00 UTC
  assert.equal(s.dowHour[2][22], 1); // Tuesday 22:00 UTC
  assert.equal(s.sizeVsEntry.n, 2);
  // two points -> perfect (anti)correlation: price down, size up
  assert.equal(s.sizeVsEntry.pearson, -1);
  assert.equal(s.sizeVsEntry.spearman, -1);
});
