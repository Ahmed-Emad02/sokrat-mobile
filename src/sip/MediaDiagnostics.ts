type RtcStat = Record<string, unknown>;

const AUDIO_FIELDS = [
  'timestamp', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'bytesReceived',
  'packetsSent', 'bytesSent', 'jitter', 'roundTripTime', 'fractionLost',
  'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
  'jitterBufferEmittedCount', 'totalSamplesReceived', 'concealedSamples',
  'silentConcealedSamples', 'concealmentEvents', 'insertedSamplesForDeceleration',
  'removedSamplesForAcceleration', 'totalAudioEnergy', 'totalSamplesDuration',
  'audioLevel', 'totalPlayoutDelay', 'totalSamplesCount', 'synthesizedSamplesDuration',
  'synthesizedSamplesEvents',
] as const;

const AUDIO_TYPES: Record<string, true> = {
  'inbound-rtp': true, 'outbound-rtp': true, 'remote-inbound-rtp': true,
  'media-source': true, 'media-playout': true,
};
const CANDIDATE_TYPES: Record<string, true> = { host: true, srflx: true, prflx: true, relay: true };
const PROTOCOLS: Record<string, true> = { udp: true, tcp: true, tls: true };

/** Read the local capture RMS reported by WebRTC's media-source stats. */
export function getMediaSourceAudioLevel(stats: Map<string, RtcStat>): number | null {
  for (const report of stats.values()) {
    if (report.type !== 'media-source' ||
        (report.kind !== 'audio' && report.mediaType !== 'audio')) continue;
    const level = report.audioLevel;
    if (typeof level === 'number' && Number.isFinite(level)) return level;
  }
  return null;
}

/** Temporary local diagnosis: never serialize raw reports, SDP, addresses or credentials. */
export type SdpLogSummary = {
  mAudioPayloads: string[];
  setup?: string;
  direction?: string;
  hasIceUfrag: boolean;
  hasFingerprint: boolean;
};

/** Return only codec payload IDs and the presence of security attributes. */
export function describeSdpForLog(sdp: string): SdpLogSummary {
  const lines = sdp.split(/\r?\n/);
  const audio = lines.find((line) => line.startsWith('m=audio '));
  const direction = lines
    .map((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line)?.[1])
    .find((value): value is string => Boolean(value));
  const setupLine = lines.find((line) => line.startsWith('a=setup:'));
  return {
    mAudioPayloads: audio ? audio.split(' ').slice(3) : [],
    ...(setupLine ? { setup: setupLine.slice('a=setup:'.length) } : {}),
    ...(direction ? { direction } : {}),
    hasIceUfrag: lines.some((line) => line.startsWith('a=ice-ufrag:')),
    hasFingerprint: lines.some((line) => line.startsWith('a=fingerprint:')),
  };
}

export function createAudioStatsSummarizer() {
  const streams = new Map<string, number>();
  return (stats: Map<string, RtcStat>) => {
    const audio: Array<Record<string, unknown>> = [];
    let pair: RtcStat | undefined;

    stats.forEach((report, id) => {
      if (typeof report.type !== 'string' || AUDIO_TYPES[report.type] !== true ||
          (report.kind !== 'audio' && report.mediaType !== 'audio')) return;
      if (!streams.has(id)) streams.set(id, streams.size + 1);
      const sample: Record<string, unknown> = { type: report.type, stream: streams.get(id) };
      for (const key of AUDIO_FIELDS) {
        if (typeof report[key] === 'number' && Number.isFinite(report[key])) sample[key] = report[key];
      }
      const codec = typeof report.codecId === 'string' ? stats.get(report.codecId) : undefined;
      if (codec && typeof codec.mimeType === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(codec.mimeType)) {
        sample.codec = codec.mimeType;
        for (const key of ['clockRate', 'channels', 'payloadType']) {
          if (typeof codec[key] === 'number' && Number.isFinite(codec[key])) sample[key] = codec[key];
        }
      }
      const transport = typeof report.transportId === 'string' ? stats.get(report.transportId) : undefined;
      if (transport && typeof transport.selectedCandidatePairId === 'string') {
        pair = stats.get(transport.selectedCandidatePairId);
      }
      audio.push(sample);
    });

    const path: Record<string, unknown> = {};
    if (pair) {
      for (const key of ['currentRoundTripTime', 'availableOutgoingBitrate']) {
        if (typeof pair[key] === 'number' && Number.isFinite(pair[key])) path[key] = pair[key];
      }
      for (const side of ['local', 'remote']) {
        const candidateId = pair[`${side}CandidateId`];
        const candidate = typeof candidateId === 'string' ? stats.get(candidateId) : undefined;
        if (!candidate) continue;
        if (typeof candidate.candidateType === 'string' && CANDIDATE_TYPES[candidate.candidateType] === true) {
          path[`${side}Type`] = candidate.candidateType;
        }
        for (const key of ['protocol', 'relayProtocol']) {
          if (typeof candidate[key] === 'string' && PROTOCOLS[candidate[key]] === true) {
            path[`${side}${key}`] = candidate[key];
          }
        }
      }
    }
    return { audio, path };
  };
}
