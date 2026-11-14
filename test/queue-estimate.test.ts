import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateStart, median, residual } from '../src/kernel/queue-estimate.js';

const repeat = (ms: number, n = 10) => Array.from({ length: n }, () => ms);

test('residual life: remaining time given elapsed, with an overdue floor', () => {
  assert.equal(residual(repeat(10_000), 8_000), 2_000);
  // Half the comparable runs took 4 s, half 20 s: after 5 s only the 20 s ones are comparable.
  assert.equal(residual([...repeat(4_000, 5), ...repeat(20_000, 5)], 5_000), 15_000);
  // Longer than every sample: expect it soon (a quarter of the median), never instantly.
  assert.equal(residual(repeat(1_000), 5_000), 250);
  assert.equal(residual(repeat(8_000), 60_000), 2_000);
  assert.equal(residual([], 1_000), null);
  assert.equal(median([3, 1, 2]), 2);
});

test('slot simulation: free slots, running work and runs ahead', () => {
  // A slot nobody ahead will take means the run starts now, even without evidence.
  assert.equal(estimateStart({ slots: 2, active: [{ sample: [], elapsed: 0 }], ahead: [] }), 0);
  // One slot, held by a 10 s run that has run 8 s: starts in about 2 s.
  assert.equal(
    estimateStart({ slots: 1, active: [{ sample: repeat(10_000), elapsed: 8_000 }], ahead: [] }),
    2_000,
  );
  // Two slots: a fast (1 s) and a slow (20 s) agent are running; one fast run is ahead.
  // It takes the fast slot at 1 s and frees it at 2 s, long before the slow one ends.
  assert.equal(
    estimateStart({
      slots: 2,
      active: [
        { sample: repeat(1_000), elapsed: 0 },
        { sample: repeat(20_000), elapsed: 0 },
      ],
      ahead: [repeat(1_000)],
    }),
    2_000,
  );
  // An agent without history borrows the median of everything known.
  assert.equal(
    estimateStart({ slots: 1, active: [{ sample: [], elapsed: 0 }], ahead: [repeat(4_000)] }),
    8_000,
  );
  assert.equal(
    estimateStart({ slots: 1, active: [{ sample: [], elapsed: 0 }], ahead: [[]] }),
    null,
  );
});

test('estimates never decrease with queue position', () => {
  const active = [
    { sample: repeat(3_000), elapsed: 1_000 },
    { sample: repeat(12_000), elapsed: 2_000 },
  ];
  const queue = [repeat(500), repeat(9_000), repeat(2_000), repeat(700), repeat(15_000)];
  let previous = -1;
  for (let i = 0; i <= queue.length; i++) {
    const start = estimateStart({ slots: 2, active, ahead: queue.slice(0, i) })!;
    assert.ok(start >= previous, `position ${i}`);
    previous = start;
  }
});
