import {
  MIC_AGC_CENTER_DB,
  MIC_AGC_MAX_DB,
  MIC_AGC_MIN_DB,
  MIC_AGC_STEP_DB,
  micLevelToDbfs,
  nextMicAgcGain,
} from '../src/calls/micAgc';
import { getMediaSourceAudioLevel } from '../src/sip/MediaDiagnostics';

describe('microphone AGC', () => {
  test('holds the gain at silence instead of amplifying it', () => {
    expect(nextMicAgcGain(MIC_AGC_CENTER_DB, 0)).toBe(MIC_AGC_CENTER_DB);
    expect(nextMicAgcGain(MIC_AGC_CENTER_DB, 1e-7)).toBe(MIC_AGC_CENTER_DB);
  });

  test('keeps a nominal speech level at the -6 dB centre', () => {
    const nominal = 10 ** (-18 / 20);
    expect(nextMicAgcGain(MIC_AGC_CENTER_DB, nominal)).toBe(MIC_AGC_CENTER_DB);
  });

  test('raises quiet speech toward the upper bound in bounded steps', () => {
    const quiet = 10 ** (-40 / 20);
    const next = nextMicAgcGain(MIC_AGC_CENTER_DB, quiet);
    expect(next).toBeCloseTo(MIC_AGC_CENTER_DB + MIC_AGC_STEP_DB, 6);
    expect(next).toBeLessThanOrEqual(MIC_AGC_MAX_DB);
  });

  test('lowers hot speech toward the lower bound in bounded steps', () => {
    const hot = 10 ** (-8 / 20);
    const next = nextMicAgcGain(MIC_AGC_CENTER_DB, hot);
    expect(next).toBeCloseTo(MIC_AGC_CENTER_DB - MIC_AGC_STEP_DB, 6);
    expect(next).toBeGreaterThanOrEqual(MIC_AGC_MIN_DB);
  });

  test('reads the local audio level from media-source stats', () => {
    const stats = new Map<string, Record<string, unknown>>([
      ['inbound', { type: 'inbound-rtp', kind: 'audio', audioLevel: 0.5 }],
      ['source', { type: 'media-source', kind: 'audio', audioLevel: 0.01 }],
    ]);
    expect(getMediaSourceAudioLevel(stats)).toBeCloseTo(0.01, 8);
    expect(getMediaSourceAudioLevel(new Map())).toBeNull();
  });

  test('clamps the control range and handles invalid levels', () => {
    expect(nextMicAgcGain(MIC_AGC_MIN_DB, 1)).toBeGreaterThanOrEqual(MIC_AGC_MIN_DB);
    expect(nextMicAgcGain(MIC_AGC_MAX_DB, 1e-5)).toBeLessThanOrEqual(MIC_AGC_MAX_DB);
    expect(nextMicAgcGain(-6, NaN)).toBe(-6);
    expect(micLevelToDbfs(0.1)).toBeCloseTo(-20, 6);
  });
});
