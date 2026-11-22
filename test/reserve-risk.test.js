import test from "node:test";
import assert from "node:assert/strict";
import { marketQuote, tradeReserveLock } from "../src/reserve-risk.js";

const reference = 100_000_000;
const bounds = { minReference: reference, maxReference: reference };

test("two-sided quote applies the configured spread", () => {
  assert.ok(marketQuote(reference, "ask") > BigInt(reference));
  assert.ok(marketQuote(reference, "bid") < BigInt(reference));
  assert.equal(marketQuote(reference, "ask") - marketQuote(reference, "bid"), 200_000n);
});

test("long reserve requirement covers the fixed upper band of reference +0.5", () => {
  const quantity = 1_000_000n;
  const entry = marketQuote(reference, "ask");
  const upperExit = marketQuote(BigInt(reference) + 500_000n, "bid");
  const expected = upperExit > entry ? (upperExit - entry) * quantity / 1_000_000_000_000n + (((upperExit - entry) * quantity) % 1_000_000_000_000n ? 1n : 0n) : 0n;
  assert.equal(tradeReserveLock("long", quantity, entry, bounds), expected);
});

test("short reserve requirement covers the fixed lower band of reference -0.5", () => {
  const quantity = 100_000_000n;
  const entry = marketQuote(reference, "bid");
  const lowerExit = marketQuote(BigInt(reference) - 500_000n, "ask");
  const numerator = quantity * (entry - lowerExit) * 100n;
  const denominator = entry * 1_000_000n;
  const expected = lowerExit < entry ? numerator / denominator + (numerator % denominator ? 1n : 0n) : 0n;
  assert.equal(tradeReserveLock("short", quantity, entry, bounds), expected);
});

test("no reserve is locked when the permitted band cannot produce customer profit", () => {
  assert.equal(tradeReserveLock("long", 1_000_000n, 2_000_000_000n, bounds), 0n);
  assert.equal(tradeReserveLock("short", 100_000_000n, 900_000_000n, bounds), 0n);
});

test("risk calculation rounds upward rather than under-reserving", () => {
  const quantity = 1n;
  const entry = marketQuote(reference, "ask");
  const lock = tradeReserveLock("long", quantity, entry, bounds);
  assert.equal(lock, 1n);
});

test("invalid exposure inputs are rejected", () => {
  assert.throws(() => tradeReserveLock("buy", 1n, 1n, bounds), /direction/);
  assert.throws(() => tradeReserveLock("long", 0n, 1n, bounds), /inputs/);
  assert.throws(() => marketQuote(reference, "last"), /side/);
});
