import test from "node:test";
import assert from "node:assert/strict";
import { nextMarketPrice } from "../src/market-motion.js";

const reference = 151_000_000;
const lower = reference;
const upper = reference + 500_000;

const move = (previous, magnitudeSample, directionSample, extra = {}) =>
  nextMarketPrice({
    previous,
    reference,
    volatilityBps: 80,
    magnitudeSample,
    directionSample,
    ...extra
  });

test("admin reference is the hard floor and price never exceeds +0.5 SYP", () => {
  for (let i = 0; i < 100; i++) {
    const next = move(reference + (i * 10_000), (i % 10) / 10, (i % 7) / 7);
    assert.ok(next >= lower && next <= upper);
  }
});

test("step sizes vary instead of repeating a fixed interval", () => {
  const steps = [
    move(reference, 0.05, 0.1),
    move(reference, 0.35, 0.9),
    move(reference, 0.75, 0.2),
    move(reference, 0.95, 0.8)
  ].map(price => price - reference);
  assert.ok(new Set(steps).size > 1);
  assert.ok(steps.every(step => step > 0 && step <= 500_000));
});

test("at the admin floor the next move is always upward", () => {
  assert.ok(move(lower, 0.5, 0.99) > lower);
  assert.ok(move(lower, 0.5, 0.0) > lower);
});

test("at the upper edge the next move is always downward", () => {
  assert.ok(move(upper, 0.5, 0.0) < upper);
  assert.ok(move(upper, 0.5, 0.99) < upper);
});

test("changing the admin reference resets the allowed band to the new floor", () => {
  const nextReference = 152_000_000;
  const next = nextMarketPrice({
    previous: reference + 200_000,
    reference: nextReference,
    volatilityBps: 80,
    magnitudeSample: 0.5,
    directionSample: 0.5
  });
  assert.ok(next >= nextReference && next <= nextReference + 500_000);
});

test("invalid movement samples are rejected", () => {
  assert.throws(() => move(reference, 1, 0.5), /invalid/);
  assert.throws(() => move(0, 0.5, 0.5), /invalid/);
});
