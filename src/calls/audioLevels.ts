/**
 * In-call audio level mapping.
 *
 * Microphone percent is converted to a PBX-side gain because WebRTC does not
 * expose a portable transmit-gain API. 50% is unity; the extra headroom above
 * 50% is deliberately larger than the attenuation range so quiet phone mics
 * can be raised without forcing every device onto a boosted default.
 *
 * Speaker percent is the device stream volume up to 100%. Above 100% the
 * remaining physical headroom is already exhausted, so the extra range is a
 * remote-track software gain (up to 2x / +6.0 dB).
 */

export const MIC_MIN_GAIN_DB = -12;
// Extended by 30% from the previous +24 dB ceiling.
export const MIC_MAX_GAIN_DB = 31.2;
export const MIC_UNITY_PERCENT = 50;
// Extended by 30% from the previous 150% / 2x ceiling.
export const SPEAKER_MAX_PERCENT = 195;
export const SPEAKER_MAX_GAIN = 2.6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function micPercentToDb(percent: number): number {
  const value = clamp(percent, 0, 100);
  const range = value >= MIC_UNITY_PERCENT ? MIC_MAX_GAIN_DB : -MIC_MIN_GAIN_DB;
  return Math.round(((value - MIC_UNITY_PERCENT) / MIC_UNITY_PERCENT) * range);
}

export function micDbToPercent(gainDb: number): number {
  const value = clamp(gainDb, MIC_MIN_GAIN_DB, MIC_MAX_GAIN_DB);
  return Math.round(
    value >= 0
      ? MIC_UNITY_PERCENT + (value / MIC_MAX_GAIN_DB) * (100 - MIC_UNITY_PERCENT)
      : MIC_UNITY_PERCENT + (value / -MIC_MIN_GAIN_DB) * MIC_UNITY_PERCENT
  );
}

export function clampMicGainDb(gainDb: number): number {
  return clamp(gainDb, MIC_MIN_GAIN_DB, MIC_MAX_GAIN_DB);
}

export function speakerPercentToGain(percent: number): number {
  const value = clamp(percent, 0, SPEAKER_MAX_PERCENT);
  if (value <= 100) return value / 100;
  // Preserve the existing 100-150% calibration (1x-2x) and use the added
  // 150-195% range for the additional 30% software boost (2x-2.6x).
  if (value <= 150) return 1 + ((value - 100) / 50);
  return 2 + ((value - 150) / (SPEAKER_MAX_PERCENT - 150)) * (SPEAKER_MAX_GAIN - 2);
}

export function speakerGainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}
