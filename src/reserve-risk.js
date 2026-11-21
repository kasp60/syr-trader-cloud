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

export const tradeReserveLock = (direction, quantityMicro, entryPriceMicro, bounds) => {
  if (direction !== "long" && direction !== "short") throw new TypeError("invalid trade direction");
  const quantity = BigInt(quantityMicro), entry = BigInt(entryPriceMicro);
  const minReference = BigInt(Math.floor(Number(bounds?.minReference)));
  const maxReference = BigInt(Math.ceil(Number(bounds?.maxReference)));
  if (quantity <= 0n || entry <= 0n || minReference <= 0n || maxReference < minReference)
    throw new RangeError("invalid reserve exposure inputs");

  if (direction === "long") {
    const upperMid = ceilDiv(maxReference * 10050n, 10000n);
    const executableExit = marketQuote(upperMid, "bid");
    return executableExit > entry
      ? ceilDiv((executableExit - entry) * quantity, 1000000000000n)
      : 0n;
  }

  const lowerMid = minReference * 9950n / 10000n;
  const executableExit = marketQuote(lowerMid, "ask");
  return executableExit < entry
    ? ceilDiv(quantity * (entry - executableExit) * 100n, entry * 1000000n)
    : 0n;
};
