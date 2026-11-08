import {
  MIC_EXTENDED_MAX_GAIN_DB,
  MIC_MAX_GAIN_DB,
  MIC_MAX_PERCENT,
  MIC_MIN_GAIN_DB,
  SPEAKER_MAX_GAIN,
  SPEAKER_MAX_PERCENT,
  micDbToPercent,
  micPercentToDb,
  speakerPercentToGain,
} from '../src/calls/audioLevels';

describe('in-call audio level mapping', () => {
  test('keeps 50% microphone at unity and exposes the full extended range', () => {
    expect(micPercentToDb(50)).toBe(0);
    expect(micPercentToDb(0)).toBe(MIC_MIN_GAIN_DB);
    expect(micPercentToDb(100)).toBe(Math.round(MIC_MAX_GAIN_DB));
    expect(micPercentToDb(MIC_MAX_PERCENT)).toBe(MIC_EXTENDED_MAX_GAIN_DB);
    expect(micPercentToDb(75)).toBe(16);
    expect(micPercentToDb(25)).toBe(-12);
  });

  test('round-trips the extended microphone range within two slider steps', () => {
    for (let percent = 0; percent <= MIC_MAX_PERCENT; percent += 5) {
      expect(Math.abs(micDbToPercent(micPercentToDb(percent)) - percent)).toBeLessThanOrEqual(2);
    }
    expect(micDbToPercent(99)).toBe(MIC_MAX_PERCENT);
    expect(micDbToPercent(-99)).toBe(0);
  });

  test('reaches device maximum at 100% and adds software gain above it', () => {
    expect(speakerPercentToGain(0)).toBe(0);
    expect(speakerPercentToGain(50)).toBe(0.5);
    expect(speakerPercentToGain(100)).toBe(1);
    expect(speakerPercentToGain(125)).toBe(1.5);
    expect(speakerPercentToGain(150)).toBe(2);
    expect(speakerPercentToGain(SPEAKER_MAX_PERCENT)).toBe(SPEAKER_MAX_GAIN);
    expect(speakerPercentToGain(999)).toBe(SPEAKER_MAX_GAIN);
  });
});
