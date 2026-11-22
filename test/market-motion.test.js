import test from "node:test";
import assert from "node:assert/strict";
import { nextMarketPrice } from "../src/market-motion.js";

const reference = 150_000_000;
const bounds = { lower: reference - 500_000, upper: reference + 500_000 };

const move = (previous, magnitudeSample, directionSample, extra = {}) =>
  nextMarketPrice({
    previous,
    reference,
    volatilityBps: 80,
    magnitudeSample,
    directionSample,
    ...extra
  });

test("market steps stay inside the half-lira admin reference band", () => {
  for (let i = 0; i < 100; i++) {
    const next = move(reference, (i % 10) / 10, (i % 7) / 7);
    assert.ok(next >= bounds.lower && next <= bounds.upper);
  }
});

test("step sizes vary instead of repeating a fixed half-lira jump", () => {
  const steps = [
    move(reference, 0.05, 0.1),
    move(reference, 0.35, 0.9),
    move(reference, 0.75, 0.2),
    move(reference, 0.95, 0.8)
  ].map(price => Math.abs(price - reference));
  assert.ok(new Set(steps).size > 1);
  assert.ok(steps.every(step => step > 0 && step < 500_000));
});

test("movement turns inward at the upper and lower boundaries", () => {
  const upper = bounds.upper;
  const lower = bounds.lower;
  assert.ok(move(upper, 0.5, 0.0) < upper);
  assert.ok(move(lower, 0.5, 0.99) > lower);
});

test("distance from reference biases movement back without fixing direction", () => {
  const high = reference + 400_000;
  const low = reference - 400_000;
  assert.ok(nextMarketPrice({
    previous: high, reference, volatilityBps: 80,
    magnitudeSample: 0.5, directionSample: 0.8
  }) < high);
  assert.ok(nextMarketPrice({
    previous: low, reference, volatilityBps: 80,
    magnitudeSample: 0.5, directionSample: 0.2
  }) > low);
});

test("invalid movement samples are rejected", () => {
  assert.throws(() => move(reference, 1, 0.5), /invalid/);
  assert.throws(() => move(0, 0.5, 0.5), /invalid/);
});
