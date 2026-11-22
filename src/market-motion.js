const MAX_DEVIATION_MICRO = 500_000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const nextMarketPrice = ({
  previous,
  reference,
  volatilityBps = 80,
  driftBps = 0,
  pressureBps = 0,
  magnitudeSample,
  directionSample
}) => {
  const current = Number(previous);
  const anchor = Number(reference);
  const volatility = Number(volatilityBps);
  const drift = Number(driftBps);
  const pressure = Number(pressureBps);
  const magnitudeRoll = Number(magnitudeSample);
  const directionRoll = Number(directionSample);

  if (!Number.isSafeInteger(current) || current <= 0 ||
      !Number.isSafeInteger(anchor) || anchor <= 0 ||
      !Number.isFinite(volatility) || volatility < 1 || volatility > 2000 ||
      !Number.isFinite(drift) || !Number.isFinite(pressure) ||
      !Number.isFinite(magnitudeRoll) || magnitudeRoll < 0 || magnitudeRoll >= 1 ||
      !Number.isFinite(directionRoll) || directionRoll < 0 || directionRoll >= 1) {
    throw new RangeError("invalid market movement inputs");
  }

  // Admin reference is the hard floor; the bot may only move upward by 0.5 SYP.
  const lower = anchor;
  const upper = anchor + MAX_DEVIATION_MICRO;
  const boundedCurrent = clamp(current, lower, upper);

  // With the default volatility, choose a fresh, variable step of about 0.10-0.40 SYP.
  const maxStep = clamp(Math.round(volatility * 5_000), 50_000, 450_000);
  const minStep = Math.min(30_000, Math.max(5_000, Math.floor(maxStep / 4)));
  const magnitude = minStep + Math.floor(magnitudeRoll * (maxStep - minStep + 1));

  // Direction remains random, with a soft bias toward the middle of the band.
  // Configured drift and order-book pressure influence odds, never the hard floor.
  const midpoint = lower + MAX_DEVIATION_MICRO / 2;
  const positionBias = clamp((midpoint - boundedCurrent) / (MAX_DEVIATION_MICRO / 2), -1, 1) * 0.25;
  const configuredBias = clamp((drift + pressure) / 10_000, -0.15, 0.15);
  const probabilityUp = clamp(0.5 + positionBias + configuredBias, 0.1, 0.9);
  let direction = directionRoll < probabilityUp ? 1 : -1;

  let available = direction > 0 ? upper - boundedCurrent : boundedCurrent - lower;
  // At either edge, reverse direction so every next price remains in the band.
  if (available <= 0) {
    direction *= -1;
    available = direction > 0 ? upper - boundedCurrent : boundedCurrent - lower;
  }
  const step = Math.min(magnitude, available);
  return boundedCurrent + direction * step;
};
