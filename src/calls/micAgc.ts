/**
 * Slow in-call microphone AGC.
 *
 * The live mic control is a PBX-side gain (VOLUME(RX)); WebRTC does not expose
 * a portable capture-gain API. Keep the gain centred on the measured sweet
 * spot (-6 dB) and move at most half a dB per sample so room noise and normal
 * speech do not make the level pump.
 */
export const MIC_AGC_CENTER_DB = -6;
export const MIC_AGC_MIN_DB = -9;
export const MIC_AGC_MAX_DB = -3;
export const MIC_AGC_TARGET_LEVEL_DBFS = -24;
export const MIC_AGC_SILENCE_DBFS = -38;
export const MIC_AGC_STEP_DB = 0.5;

/** WebRTC media-source.audioLevel is a linear RMS value in [0, 1]. */
export function micLevelToDbfs(level: number): number | null {
  if (!Number.isFinite(level) || level <= 0) return null;
  return 20 * Math.log10(level);
}

export function nextMicAgcGain(currentGainDb: number, audioLevel: number): number {
  const measuredDb = micLevelToDbfs(audioLevel);
  if (measuredDb === null || measuredDb < MIC_AGC_SILENCE_DBFS) {
    return currentGainDb;
  }

  const targetGainDb = MIC_AGC_CENTER_DB +
    (MIC_AGC_TARGET_LEVEL_DBFS - measuredDb) * 0.25;
  const clampedTarget = Math.max(MIC_AGC_MIN_DB, Math.min(MIC_AGC_MAX_DB, targetGainDb));
  const step = Math.max(-MIC_AGC_STEP_DB, Math.min(MIC_AGC_STEP_DB, clampedTarget - currentGainDb));
  const next = currentGainDb + step;
  return Math.max(MIC_AGC_MIN_DB, Math.min(MIC_AGC_MAX_DB, Math.round(next * 10) / 10));
}
