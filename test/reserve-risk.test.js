import test from "node:test";
import assert from "node:assert/strict";
import { marketQuote, tradeReserveLock } from "../src/reserve-risk.js";

const reference = 1_000_000_000;
const bounds = { minReference: reference, maxReference: reference };

test("two-sided quote applies the configured spread", () => {
  assert.ok(marketQuote(reference, "ask") > BigInt(reference));
  assert.ok(marketQuote(reference, "bid") < BigInt(reference));
  assert.equal(marketQuote(reference, "ask") - marketQuote(reference, "bid"), 2_000_000n);
});

test("long reserve requirement covers positive movement to the upper band", () => {
  const lock = tradeReserveLock("long", 1_000_000n, marketQuote(reference, "ask"), bounds);
  assert.ok(lock > 0n);
  assert.equal(typeof lock, "bigint");
});

test("short reserve requirement covers positive movement to the lower band", () => {
  const lock = tradeReserveLock("short", 100_000_000n, marketQuote(reference, "bid"), bounds);
  assert.ok(lock > 0n);
  assert.equal(typeof lock, "bigint");
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
