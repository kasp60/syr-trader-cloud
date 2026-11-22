export const MARKET_SPREAD_BPS = 10;

export const marketQuote = (midPrice, side) => {
  if (side !== "ask" && side !== "bid") throw new TypeError("side must be ask or bid");
  const mid = BigInt(midPrice);
  if (mid <= 0n) throw new RangeError("mid price must be positive");
  const factor = side === "ask" ? 10000n + BigInt(MARKET_SPREAD_BPS) : 10000n - BigInt(MARKET_SPREAD_BPS);
  const scaled = mid * factor;
  return side === "ask" ? (scaled + 9999n) / 10000n : scaled / 10000n;
};

const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
const MAX_PRICE_DEVIATION_MICRO = 25_000_000n;

export const tradeReserveLock = (direction, quantityMicro, entryPriceMicro, bounds) => {
  if (direction !== "long" && direction !== "short") throw new TypeError("invalid trade direction");
  const quantity = BigInt(quantityMicro), entry = BigInt(entryPriceMicro);
  const minReference = BigInt(Math.floor(Number(bounds?.minReference)));
  const maxReference = BigInt(Math.ceil(Number(bounds?.maxReference)));
  if (quantity <= 0n || entry <= 0n || minReference <= 0n || maxReference < minReference)
    throw new RangeError("invalid reserve exposure inputs");

  if (direction === "long") {
    const upperMid = maxReference + MAX_PRICE_DEVIATION_MICRO;
    const executableExit = marketQuote(upperMid, "bid");
    return executableExit > entry
      ? ceilDiv((executableExit - entry) * quantity, 1000000000000n)
      : 0n;
  }

  const lowerMid = minReference > MAX_PRICE_DEVIATION_MICRO
      ? minReference - MAX_PRICE_DEVIATION_MICRO
      : 1n;
  const executableExit = marketQuote(lowerMid, "ask");
  return executableExit < entry
    ? ceilDiv(quantity * (entry - executableExit) * 100n, entry * 1000000n)
    : 0n;
};
