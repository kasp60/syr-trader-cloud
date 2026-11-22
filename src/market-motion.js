const MAX_DEVIATION_MICRO = 500_000;
const CENT_MICRO = 10_000;

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

  // Market mid-prices are stored in micro-SYP, but bot prices must land
  // exactly on a piastre (0.01 SYP). Match the admin value as displayed.
  const lower = Math.round(anchor / CENT_MICRO) * CENT_MICRO;
  const upper = lower + MAX_DEVIATION_MICRO;
  const boundedCurrent = clamp(
    Math.round(current / CENT_MICRO) * CENT_MICRO,
    lower,
    upper
  );

  // Pick a variable step in whole piastres; never create sub-piastre prices.
  const maxStep = Math.floor(clamp(Math.round(volatility * 5_000), CENT_MICRO, 450_000) / CENT_MICRO) * CENT_MICRO;
  const minStep = Math.min(30_000, Math.max(CENT_MICRO, Math.floor(maxStep / 4 / CENT_MICRO) * CENT_MICRO));
  const stepCount = Math.max(1, Math.floor((maxStep - minStep) / CENT_MICRO) + 1);
  const magnitude = minStep + Math.floor(magnitudeRoll * stepCount) * CENT_MICRO;

  // Direction remains random, with a soft bias toward the middle of the band.
  const midpoint = lower + MAX_DEVIATION_MICRO / 2;
  const positionBias = clamp((midpoint - boundedCurrent) / (MAX_DEVIATION_MICRO / 2), -1, 1) * 0.25;
  const configuredBias = clamp((drift + pressure) / 10_000, -0.15, 0.15);
  const probabilityUp = clamp(0.5 + positionBias + configuredBias, 0.1, 0.9);
  let direction = directionRoll < probabilityUp ? 1 : -1;

  let available = direction > 0 ? upper - boundedCurrent : boundedCurrent - lower;
  if (available <= 0) {
    direction *= -1;
    available = direction > 0 ? upper - boundedCurrent : boundedCurrent - lower;
  }
  const step = Math.min(magnitude, available);
  return boundedCurrent + direction * step;
};
