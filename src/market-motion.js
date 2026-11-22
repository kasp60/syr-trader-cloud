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

  const lower = Math.max(1, Math.floor(anchor - MAX_DEVIATION_MICRO));
  const upper = Math.max(lower, Math.ceil(anchor + MAX_DEVIATION_MICRO));
  const boundedCurrent = clamp(current, lower, upper);

  // The default 80 bps setting yields varied steps of roughly 0.03-0.40 SYP.
  const maxStep = clamp(Math.round(volatility * 5_000), 50_000, 450_000);
  const minStep = Math.min(30_000, Math.max(5_000, Math.floor(maxStep / 4)));
  const magnitude = minStep + Math.floor(magnitudeRoll * (maxStep - minStep + 1));

  // A gentle pull toward the admin reference avoids long one-way runs.
  // Drift and book pressure only bias the odds; they do not dictate each tick.
  const distanceBias = clamp((anchor - boundedCurrent) / MAX_DEVIATION_MICRO, -1, 1) * 0.25;
  const configuredBias = clamp((drift + pressure) / 10_000, -0.15, 0.15);
  const probabilityUp = clamp(0.5 + distanceBias + configuredBias, 0.1, 0.9);
  let direction = directionRoll < probabilityUp ? 1 : -1;

  let available = direction > 0 ? upper - boundedCurrent : boundedCurrent - lower;
  // Turn away from a boundary instead of repeatedly clipping at exactly +/-0.5.
  if (available <= 0) {
    direction *= -1;
    available = direction > 0 ? upper - boundedCurrent : boundedCurrent - lower;
  }
  const step = Math.min(magnitude, available);
  return boundedCurrent + direction * step;
};
