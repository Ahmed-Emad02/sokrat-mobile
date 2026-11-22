/**
 * Integration checks for the media/signalling wiring in JsSipService:
 * persistent `instance_id`, TURN pcConfig from `getMediaConfiguration`, full
 * ICE gathering (never `ready()` on a single candidate) and microphone
 * release when a call cannot be placed.
 */

const mockUaInstances: any[] = [];

jest.mock('jssip', () => {
  class WebSocketInterface {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
  }

  class UA {
    configuration: any;
    handlers: Record<string, Array<(data?: unknown) => void>> = {};
    calls: Array<{ uri: string; options: any }> = [];
    started = false;
    constructor(configuration: any) {
      this.configuration = configuration;
      mockUaInstances.push(this);
    }
    on(event: string, handler: (data?: unknown) => void) {
      (this.handlers[event] = this.handlers[event] || []).push(handler);
    }
    emit(event: string, data?: unknown) {
      (this.handlers[event] || []).forEach((handler) => handler(data));
    }
    start() {
      this.started = true;
    }
    stop() {}
    register() {}
    call(uri: string, options: any) {
      this.calls.push({ uri, options });
    }
    isRegistered() {
      return true;
    }
    isConnected() {
      return true;
    }
  }

  return {
    __esModule: true,
    default: { UA, WebSocketInterface, debug: { disable() {} } },
    UA,
    WebSocketInterface,
  };
});

jest.mock('../src/network', () => {
  const actual = jest.requireActual('../src/network');
  return { ...actual, getMediaConfiguration: jest.fn() };
});

import { mediaDevices } from 'react-native-webrtc';
import { describeSdpForLog } from '../src/sip/MediaDiagnostics';
import InCallManager from 'react-native-incall-manager';
import {
  CONFIRMATION_TIMEOUT_MS,
  ICE_RELAY_GRACE_MS,
  ICE_RELAY_WAIT_MS,
  JsSipService,
  OUTGOING_RING_TIMEOUT_MS,
  SIGNALING_GRACE_MS,
  SipEvents,
  remoteAudioSends,
} from '../src/sip/JsSipService';
import { getMediaConfiguration } from '../src/network';
import { getDeviceUuid, UUID_PATTERN } from '../src/storage/deviceId';
import { resolveCallerName } from '../src/calls/callerNameResolver';
jest.mock('../src/calls/callerNameResolver', () => ({ resolveCallerName: jest.fn(async () => 'Unknown') }));
import { createGatewaySession, resetGatewaySession, setActiveGatewaySession } from '../src/gateway/session';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockMediaConfiguration = getMediaConfiguration as jest.MockedFunction<typeof getMediaConfiguration>;

type FakeSession = {
  id: string;
  direction: 'incoming' | 'outgoing';
  remote_identity: { uri: { user: string }; display_name: string };
  on: jest.Mock;
  handlers: Record<string, Array<(data?: unknown) => void>>;
  emit: (event: string, data?: unknown) => void;
  answer: jest.Mock;
  terminate: jest.Mock;
  connection: {
    localDescription: { sdp: string };
    remoteDescription: { sdp: string } | null;
    setRemoteDescription: jest.Mock;
    iceGatheringState: string;
    pcHandlers: Record<string, Array<() => void>>;
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
  };
};

function createSession(direction: 'incoming' | 'outgoing' = 'outgoing', displayName = ''): FakeSession {
  const handlers: Record<string, Array<(data?: unknown) => void>> = {};
  const pcHandlers: Record<string, Array<() => void>> = {};
  const session: FakeSession = {
    id: `session-${direction}`,
    direction,
    remote_identity: { uri: { user: '102' }, display_name: displayName },
    handlers,
    on: jest.fn((event: string, handler: (data?: unknown) => void) => {
      (handlers[event] = handlers[event] || []).push(handler);
    }),
    emit: (event: string, data?: unknown) => {
      (handlers[event] || []).forEach((handler) => handler(data));
    },
    answer: jest.fn(),
    terminate: jest.fn(),
    connection: {
      localDescription: { sdp: 'v=0\r\n' },
      remoteDescription: null,
      setRemoteDescription: jest.fn(async () => undefined),
      iceGatheringState: 'new',
      pcHandlers,
      addEventListener: jest.fn((event: string, handler: () => void) => {
        (pcHandlers[event] = pcHandlers[event] || []).push(handler);
      }),
      removeEventListener: jest.fn((event: string, handler: () => void) => {
        pcHandlers[event] = (pcHandlers[event] || []).filter((fn) => fn !== handler);
      }),
    },
  };
  return session;
}

function setGatheringState(session: FakeSession, state: string) {
  session.connection.iceGatheringState = state;
  (session.connection.pcHandlers.icegatheringstatechange || []).forEach((handler) => handler());
}

const HOST_CANDIDATE = {
  candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host',
  type: 'host',
};
const RELAY_CANDIDATE = {
  candidate: 'candidate:2 1 udp 1 203.0.113.9 6000 typ relay raddr 0.0.0.0 rport 0',
  type: 'relay',
};
const RELAY_CANDIDATE_2 = {
  candidate: 'candidate:3 1 tcp 1 203.0.113.9 6001 typ relay raddr 0.0.0.0 rport 0',
  type: 'relay',
};

function setLocalSdp(session: FakeSession, candidates: Array<{ candidate: string }>) {
  session.connection.localDescription = {
    sdp: `v=0\r\n${candidates.map((c) => `a=${c.candidate}\r\n`).join('')}`,
  };
}

function createEvents(): SipEvents {
  return {
    onStateChange: jest.fn(),
    onIncomingCall: jest.fn(),
    onCallEstablished: jest.fn(),
    onCallEnded: jest.fn(),
    onCallStatusChange: jest.fn(),
  };
}

function createStream() {
  const track = { kind: 'audio', enabled: true, stop: jest.fn() };
  return { stream: { getTracks: () => [track], getAudioTracks: () => [track] }, track };
}

const relayConfiguration = {
  iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }],
  iceTransportPolicy: 'relay' as const,
};

const activeServices: JsSipService[] = [];

function createService(events: SipEvents = createEvents()): JsSipService {
  const service = new JsSipService(events);
  activeServices.push(service);
  return service;
}

/**
 * Tests the private SDP munger without fabricating a typed service shape.
 * Reflect.get performs the runtime method check before invocation.
 */
function prioritizeCodec(service: JsSipService, sdp: string, preferred: string): string {
  const method = Reflect.get(service, 'prioritizeCodecInSdp');
  if (typeof method !== 'function') throw new Error('prioritizeCodecInSdp is unavailable');
  const result = Reflect.apply(method, service, [sdp, preferred]);
  if (typeof result !== 'string') throw new Error('prioritizeCodecInSdp returned non-string SDP');
  return result;
}

describe('JsSipService media + instance id', () => {
  const originalFetch = globalThis.fetch;

  test('early-media diagnostics expose codec and direction only', () => {
    const sdp = [
      'v=0',
      'm=audio 19462 UDP/TLS/RTP/SAVPF 0 126',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:126 telephone-event/8000',
      'a=setup:active',
      'a=sendrecv',
      'a=ice-ufrag:secret-ufrag',
      'a=ice-pwd:secret-pwd',
      'a=fingerprint:sha-256 AA:BB:CC',
    ].join('\r\n');

    expect(describeSdpForLog(sdp)).toEqual({
      mAudioPayloads: ['0', '126'],
      setup: 'active',
      direction: 'sendrecv',
      hasIceUfrag: true,
      hasFingerprint: true,
    });
    expect(JSON.stringify(describeSdpForLog(sdp))).not.toContain('secret');
  });

  beforeAll(() => {
    // Never let the in-call volume ping reach the network from unit tests.
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    })) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    (resolveCallerName as jest.Mock).mockReset().mockResolvedValue('Unknown');
    mockUaInstances.length = 0;
    mockMediaConfiguration.mockReset();
    (mediaDevices.getUserMedia as jest.Mock).mockReset();
  });

  afterEach(() => {
    activeServices.forEach((service) => service.disconnect());
    activeServices.length = 0;
  });

  test('restricts local SDP to the explicitly selected codec plus telephone-event', () => {
    const service = createService();
    const sdp = [
      'v=0',
      'm=audio 5000 UDP/TLS/RTP/SAVPF 111 0 8 101',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=rtcp-fb:* transport-cc',
    ].join('\r\n');

    const filtered = prioritizeCodec(service, sdp, 'pcmu');

    expect(filtered).toContain('m=audio 5000 UDP/TLS/RTP/SAVPF 0 101');
    expect(filtered).toContain('a=rtpmap:0 PCMU/8000');
    expect(filtered).toContain('a=rtpmap:101 telephone-event/8000');
    expect(filtered).not.toContain('a=rtpmap:111');
    expect(filtered).not.toContain('a=fmtp:111');
    expect(filtered).not.toContain('a=rtpmap:8');
    expect(filtered).toContain('a=rtcp-fb:* transport-cc');
  });

  test.each([
    { originator: 'remote', type: 'offer', restrict: true },
    { originator: 'local', type: 'offer', restrict: true },
    { originator: 'local', type: 'answer', restrict: false },
    { originator: 'remote', type: 'answer', restrict: false },
  ])('codec preference respects native negotiation for $originator $type', async ({
    originator, type, restrict,
  }) => {
    const service = createService();
    service.setPreferredCodec('pcmu');
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const sdp = [
      'v=0',
      'm=audio 5000 UDP/TLS/RTP/SAVPF 107 0 8 101',
      'a=sendrecv',
      'a=rtpmap:107 opus/48000/2',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      '',
    ].join('\r\n');
    const description = { originator, type, sdp };

    session.emit('sdp', description);

    if (restrict) {
      expect(description.sdp).toContain('m=audio 5000 UDP/TLS/RTP/SAVPF 0 101\r\n');
      expect(description.sdp).not.toContain('a=rtpmap:107');
      expect(description.sdp).not.toContain('a=rtpmap:8 ');
      expect(description.sdp).toContain('a=sendrecv\r\n');
      expect(description.sdp).toContain('a=rtpmap:101 telephone-event/8000\r\n');
    } else {
      // JsSIP emits a local answer after setLocalDescription. Advertising a
      // different codec here does not change the native RTP sender.
      expect(description.sdp).toBe(sdp);
    }
  });

  test('keeps an offered codec when the preferred static payload is absent', () => {
    const sdp = [
      'v=0',
      'm=audio 5000 UDP/TLS/RTP/SAVPF 107 101',
      'a=rtpmap:107 opus/48000/2',
      'a=rtpmap:101 telephone-event/8000',
      '',
    ].join('\r\n');

    expect(prioritizeCodec(createService(), sdp, 'pcmu')).toBe(sdp);
  });

  test('does not rewrite a remote SDP on an outbound call', async () => {
    const service = createService();
    service.setPreferredCodec('pcmu');
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const sdp = [
      'v=0',
      'm=audio 5000 UDP/TLS/RTP/SAVPF 107 0 8 101',
      'a=sendrecv',
      'a=rtpmap:107 opus/48000/2',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      '',
    ].join('\r\n');
    const description = { originator: 'remote', type: 'offer', sdp };

    session.emit('sdp', description);

    expect(description.sdp).toBe(sdp);
  });

  test('leaves SDP application to JsSIP: a provisional answer does not establish the call', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const sdp = [
      'v=0',
      'm=audio 19462 UDP/TLS/RTP/SAVPF 0 126',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:126 telephone-event/8000',
      'a=sendrecv',
      '',
    ].join('\r\n');

    session.emit('sdp', { originator: 'remote', type: 'answer', sdp });
    session.emit('progress');

    // JsSIP serializes provisional and final answers on its own connection
    // queue; a second application by the app would race it or replay an old
    // leg's SDP into a later call.
    expect(session.connection.setRemoteDescription).not.toHaveBeenCalled();
    expect(service.activeCall?.status).toBe('ringing');
    expect(events.onCallEstablished).not.toHaveBeenCalled();

    // JsSIP applied the provisional answer, then the final answer confirms.
    session.connection.remoteDescription = { sdp };
    session.emit('confirmed');

    expect(session.connection.setRemoteDescription).not.toHaveBeenCalled();
    expect(events.onCallEstablished).toHaveBeenCalledTimes(1);
    expect(service.activeCall?.status).toBe('active');
  });

  test('audio codec restriction leaves the remote video offer intact', () => {
    const video = [
      'm=video 5002 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
      'a=rtcp-fb:96 nack',
      '',
    ].join('\r\n');
    const sdp = [
      'v=0',
      'm=audio 5000 UDP/TLS/RTP/SAVPF 107 0',
      'a=rtpmap:107 opus/48000/2',
      'a=rtpmap:0 PCMU/8000',
      video,
    ].join('\r\n');

    const filtered = prioritizeCodec(createService(), sdp, 'pcmu');

    expect(filtered).toContain('m=audio 5000 UDP/TLS/RTP/SAVPF 0\r\n');
    expect(filtered).toContain(video);
  });

  test('keeps automatic codec negotiation when no explicit codec is selected', () => {
    const service = createService();
    const sdp = [
      'v=0',
      'm=audio 5000 UDP/TLS/RTP/SAVPF 111 0 8 101',
      'a=rtpmap:111 opus/48000/2',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
    ].join('\r\n');

    const filtered = prioritizeCodec(service, sdp, 'auto');

    expect(filtered).toContain('m=audio 5000 UDP/TLS/RTP/SAVPF 111 0 8 101');
    expect(filtered).toContain('a=rtpmap:111');
    expect(filtered).toContain('a=rtpmap:0');
  });

  test('decline handles JsSIP synchronous failed event without reporting failure', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    session.terminate.mockImplementation(() => session.emit('failed', { cause: 'Terminated' }));
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    expect(await service.decline(session.id)).toBe(true);
    expect(session.terminate).toHaveBeenCalledWith({ status_code: 603, reason_phrase: 'Decline' });
    expect(events.onCallEnded).toHaveBeenCalledWith(session.id, 'Terminated', expect.anything());
  });

  test('rejects a second incoming call while a call is already active', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const first = createSession('outgoing');
    first.id = 'first-active';
    mockUaInstances[0].emit('newRTCSession', { session: first, request: {} });

    const second = createSession('incoming');
    second.id = 'second-incoming';
    mockUaInstances[0].emit('newRTCSession', { session: second, request: {} });

    expect(second.terminate).toHaveBeenCalledWith({ status_code: 486, reason_phrase: 'Busy Here' });
    expect(service.activeCall?.id).toBe(first.id);
    expect(events.onIncomingCall).not.toHaveBeenCalledWith(expect.objectContaining({ callId: second.id }));
  });

  test('outbound hangup dispatches termination and retains a leg when dispatch throws', async () => {
    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    session.terminate.mockImplementationOnce(() => { throw new Error('transport'); });
    expect(await service.hangup(session.id)).toBe(false);
    expect(service.activeCall?.id).toBe(session.id);
    expect(await service.hangup('other-call')).toBe(false);
    expect(await service.hangup(session.id)).toBe(true);
    expect(session.terminate).toHaveBeenCalledTimes(2);
  });

  test('late termination event from old leg does not clear a newer leg', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const first = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session: first, request: {} });
    await service.hangup(first.id);
    const second = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session: second, request: {} });
    first.emit('ended');
    expect(service.activeCall?.id).toBe(second.id);
    expect(events.onCallEnded).not.toHaveBeenCalled();
  });

  test('outgoing call name resolves without delaying the initial calling event', async () => {
    let finish!: (name: string) => void;
    (resolveCallerName as jest.Mock).mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    expect(service.activeCall?.targetName).toBe('102');
    expect(events.onCallStatusChange).toHaveBeenCalled();
    finish('Saved customer');
    await Promise.resolve();
    expect(service.activeCall?.targetName).toBe('Saved customer');
    expect(service.activeCall?.target).toBe('102');
  });

  test('outgoing lookup miss keeps the dialed number visible', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    await Promise.resolve();
    expect(service.activeCall?.targetName).toBe('102');
    expect(service.activeCall?.target).toBe('102');
  });

  test('incoming call ignores an untrusted PBX display name until contact lookup', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming', 'PBX Contact');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    expect(service.activeCall?.targetName).toBe('Unknown');
    expect(events.onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({
      callerId: '102', callerName: 'Unknown',
    }));
  });

  test('incoming call starts Unknown until app/VoIP contact lookup resolves', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    expect(service.activeCall?.targetName).toBe('Unknown');
    expect(events.onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ callerId: '102', callerName: 'Unknown' }));
  });

  test('outgoing name lookup cannot update an ended session', async () => {
    let finish!: (name: string) => void;
    (resolveCallerName as jest.Mock).mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('outgoing');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    session.emit('ended', {});
    const count = (events.onCallStatusChange as jest.Mock).mock.calls.length;
    finish('Old customer');
    await Promise.resolve();
    expect(service.activeCall).toBeNull();
    expect(events.onCallStatusChange).toHaveBeenCalledTimes(count);
  });

  test('registers with the persistent push device UUID as JsSIP instance_id', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const service = createService();

    await service.connect('160', 'pw', 'pbx.example.com', false);
    const ua = mockUaInstances[0];

    const deviceUuid = await getDeviceUuid();
    expect(deviceUuid).toMatch(UUID_PATTERN);
    expect(ua.configuration.instance_id).toBe(deviceUuid);

    // Plain WS on 8088 for a public host, matching getSipWss().
    const socket = ua.configuration.sockets[0];
    expect(socket.url).toBe('ws://pbx.example.com:8088/ws');
    expect(ua.configuration.uri).toBe('sip:160@pbx.example.com');
    expect(ua.started).toBe(true);
  });

  test('disconnect cancels pending mic gain and settles its promise', async () => {
    jest.useFakeTimers();
    try {
      const service = createService();
      const fetchMock = globalThis.fetch as jest.Mock;
      fetchMock.mockClear();
      const pending = service.setLiveMicGain(2, 'cancelled-call');
      service.disconnect();
      await expect(pending).resolves.toBe(false);
      await jest.runOnlyPendingTimersAsync();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a newer mic gain request settles the replaced debounce', async () => {
    jest.useFakeTimers();
    try {
      const service = createService();
      const first = service.setLiveMicGain(1, 'same-call');
      const second = service.setLiveMicGain(2, 'same-call');
      await expect(first).resolves.toBe(false);
      service.disconnect();
      await expect(second).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('uses the same instance_id after a reconnect', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const service = createService();

    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.connect('160', 'pw', 'other.example.com', false);

    expect(mockUaInstances).toHaveLength(2);
    expect(mockUaInstances[0].configuration.instance_id).toBe(
      mockUaInstances[1].configuration.instance_id,
    );
    expect(mockUaInstances[1].configuration.sockets[0].url).toBe('ws://other.example.com:8088/ws');
  });

  test('passes TURN relay config to the outbound session', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    expect(mockMediaConfiguration).toHaveBeenCalledWith('pbx.example.com', '160', 'pw');
    expect(ua.calls).toHaveLength(1);
    expect(ua.calls[0].uri).toBe('sip:102@pbx.example.com');
    expect(ua.calls[0].options.pcConfig).toMatchObject(relayConfiguration);
    expect(ua.calls[0].options.mediaStream).toBe(stream);
  });

  test('never signals ready() before a relay candidate exists', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const ready = jest.fn();
      setLocalSdp(session, [HOST_CANDIDATE]);
      session.emit('icecandidate', { candidate: HOST_CANDIDATE, ready });

      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS - 1);
      expect(ready).not.toHaveBeenCalled();
      expect(session.terminate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('releases the SDP once, grace after the first relay candidate', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const ready = jest.fn();
      setLocalSdp(session, [HOST_CANDIDATE, RELAY_CANDIDATE]);
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE, ready });

      jest.advanceTimersByTime(ICE_RELAY_GRACE_MS - 1);
      expect(ready).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(ready).toHaveBeenCalledTimes(1);

      // A later relay candidate (or the post-relay cap) must not ready again:
      // JsSIP would otherwise emit a second SDP/INVITE.
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE_2, ready });
      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ua.calls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('aborts instead of sending a relay-less SDP when gathering stalls', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const ready = jest.fn();
      setLocalSdp(session, [HOST_CANDIDATE]);
      session.emit('icecandidate', { candidate: HOST_CANDIDATE, ready });

      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS);
      expect(ready).not.toHaveBeenCalled();
      expect(session.terminate).toHaveBeenCalledTimes(1);
      expect(session.terminate.mock.calls[0][0]).toMatchObject({
        status_code: 408,
        reason_phrase: 'ICE gathering timeout',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('aborts immediately when gathering completes without a relay candidate', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      setGatheringState(session, 'gathering');
      setLocalSdp(session, [HOST_CANDIDATE]);
      session.emit('icecandidate', { candidate: HOST_CANDIDATE, ready: jest.fn() });

      setGatheringState(session, 'complete');
      expect(session.terminate).toHaveBeenCalledTimes(1);
      expect(session.terminate.mock.calls[0][0]).toMatchObject({ status_code: 408 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not start the no-relay budget before ICE gathering actually begins', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      // Peer connection exists and the microphone is already open, but ICE has
      // not started (e.g. ringing / permission dialog / slow setLocalDescription).
      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS * 3);
      expect(session.terminate).not.toHaveBeenCalled();

      const ready = jest.fn();
      setLocalSdp(session, [HOST_CANDIDATE]);
      session.emit('icecandidate', { candidate: HOST_CANDIDATE, ready });
      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS - 1);
      expect(session.terminate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(session.terminate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('re-arms the relay budget for a later ICE restart / hold reINVITE', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const firstReady = jest.fn();
      setLocalSdp(session, [RELAY_CANDIDATE]);
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE, ready: firstReady });
      jest.advanceTimersByTime(ICE_RELAY_GRACE_MS);
      expect(firstReady).toHaveBeenCalledTimes(1);

      // ICE restart (reINVITE with fresh credentials): a new gathering cycle
      // starts after the previous one completed.
      setGatheringState(session, 'complete');
      const restartReady = jest.fn();
      setGatheringState(session, 'gathering');
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE_2, ready: restartReady });
      jest.advanceTimersByTime(ICE_RELAY_GRACE_MS);
      expect(restartReady).toHaveBeenCalledTimes(1);
      expect(firstReady).toHaveBeenCalledTimes(1);
      expect(session.terminate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });


  test('prefetches media configuration while ringing and reuses it for answer', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);
    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 10));
    expect(mockMediaConfiguration).toHaveBeenCalledTimes(1);
    await expect(service.answer(session.id)).resolves.toBe(true);
    expect(mockMediaConfiguration).toHaveBeenCalledTimes(1);
  });

  test('re-arms after answer() re-evaluates the relay requirement', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const ua = mockUaInstances[0];
    const session = createSession('incoming');

    ua.emit('newRTCSession', { session, request: {} });
    await expect(service.answer('session-incoming')).resolves.toBe(true);

    jest.useFakeTimers();
    try {
      // Answering created/attached the peer connection again; a relay-less
      // gathering cycle must still abort rather than emit direct SDP.
      setGatheringState(session, 'gathering');
      setGatheringState(session, 'complete');
      expect(session.terminate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cancels the gathering timers when the call ends', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const ready = jest.fn();
      setLocalSdp(session, [RELAY_CANDIDATE]);
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE, ready });

      session.emit('ended', { cause: 'NORMAL_CLEARING' });
      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS);
      expect(ready).not.toHaveBeenCalled();
      expect(session.terminate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('cancels the gathering timers on disconnect/hangup teardown', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const ready = jest.fn();
      setLocalSdp(session, [RELAY_CANDIDATE]);
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE, ready });

      service.disconnect();
      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS);
      expect(ready).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('keeps default JsSIP gathering for direct (non-relay) calls', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    await service.call('102');

    const ua = mockUaInstances[0];
    const session = createSession('outgoing');
    jest.useFakeTimers();
    try {
      ua.emit('newRTCSession', { session, request: {} });
      const ready = jest.fn();
      setLocalSdp(session, [HOST_CANDIDATE]);
      session.emit('icecandidate', { candidate: HOST_CANDIDATE, ready });
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE, ready });

      jest.advanceTimersByTime(ICE_RELAY_WAIT_MS);
      expect(ready).not.toHaveBeenCalled();
      expect(session.terminate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('arms bounded gathering for inbound calls once answer() needs relay', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);

    const ua = mockUaInstances[0];
    const session = createSession('incoming');
    ua.emit('newRTCSession', { session, request: {} });
    await expect(service.answer('session-incoming')).resolves.toBe(true);

    jest.useFakeTimers();
    try {
      const ready = jest.fn();
      setLocalSdp(session, [RELAY_CANDIDATE]);
      session.emit('icecandidate', { candidate: RELAY_CANDIDATE, ready });
      jest.advanceTimersByTime(ICE_RELAY_GRACE_MS);
      expect(ready).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('releases the microphone when relay credentials cannot be fetched', async () => {
    mockMediaConfiguration.mockRejectedValue(new Error('Audio relay authorization failed (401)'));
    const { stream, track } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);

    await expect(service.call('102')).rejects.toThrow('Audio relay authorization failed (401)');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(mockUaInstances[0].calls).toHaveLength(0);
  });

  test('releases the microphone when answer() cannot build media', async () => {
    mockMediaConfiguration.mockRejectedValue(new Error('Audio relay unavailable'));
    const { stream, track } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);
    const events = createEvents();

    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);

    const ua = mockUaInstances[0];
    const session = createSession('incoming');
    ua.emit('newRTCSession', { session, request: {} });

    await expect(service.answer('session-incoming')).resolves.toBe(false);
    expect(session.answer).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(events.onCallEstablished).not.toHaveBeenCalled();
  });

  test('answers with the TURN relay config when media is available', async () => {
    mockMediaConfiguration.mockResolvedValue(relayConfiguration);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);
    const events = createEvents();

    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);

    const ua = mockUaInstances[0];
    const session = createSession('incoming');
    ua.emit('newRTCSession', { session, request: {} });

    await expect(service.answer('session-incoming')).resolves.toBe(true);
    expect(session.answer).toHaveBeenCalledTimes(1);
    expect((session.answer.mock.calls[0][0] as any).pcConfig).toMatchObject(relayConfiguration);
    expect(events.onCallEstablished).not.toHaveBeenCalled();
    expect(service.activeCall?.status).toBe('ringing');
    session.emit('accepted', {});
    expect(events.onCallEstablished).not.toHaveBeenCalled();
    session.emit('confirmed', {});
    expect(events.onCallEstablished).toHaveBeenCalledTimes(1);
    expect(service.activeCall?.status).toBe('active');
  });

  test('asynchronous SDP failure after answer dispatch is never reported as established', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const { stream, track } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    await expect(service.answer(session.id)).resolves.toBe(true);
    session.emit('failed', { cause: 'Bad Media Description' });
    expect(events.onCallEstablished).not.toHaveBeenCalled();
    expect(events.onCallEnded).toHaveBeenCalledWith(session.id, 'Bad Media Description', expect.anything());
    expect(service.activeCall).toBeNull();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  test('answer failure diagnostics identify SIP cancellation without dumping SIP headers or SDP', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    await service.answer(session.id);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      session.emit('failed', {
        originator: 'remote', cause: 'Canceled',
        message: { method: 'CANCEL', body: 'private-sdp', headers: { Authorization: 'private-secret' } },
      });
      const line = warning.mock.calls.map(args => args.join(' ')).join('\n');
      expect(line).toContain('session failed');
      expect(line).toContain('"originator":"remote"');
      expect(line).toContain('"method":"CANCEL"');
      expect(line).toContain('"answerDispatched":true');
      expect(line).not.toContain('private-sdp');
      expect(line).not.toContain('private-secret');
      expect(events.onCallEstablished).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test('WebRTC operation failures are logged even when JsSIP has already closed the session', async () => {
    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      session.emit('failed', { cause: 'WebRTC Error' });
      session.emit('peerconnection:setremotedescriptionfailed', { name: 'OperationError', message: 'private-sdp' });
      const line = warning.mock.calls.map(args => args.join(' ')).join('\n');
      expect(line).toContain('peerconnection:setremotedescriptionfailed');
      expect(line).toContain('OperationError');
      expect(line).not.toContain('private-sdp');
    } finally {
      warning.mockRestore();
    }
  });

  test('stale native Answer cannot rename or answer another inbound call', async () => {
    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    await expect(service.answer('older-push-call')).resolves.toBe(false);
    expect(service.activeCall?.id).toBe(session.id);
    expect(session.answer).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  test('answers on runtimes without Promise.withResolvers', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);
    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const original = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, value: undefined });
    try {
      await expect(service.answer(session.id)).resolves.toBe(true);
      expect(session.answer).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(Promise, 'withResolvers', original);
    }
  });

  test('duplicate incoming answer actions share one microphone and SIP answer', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const { stream } = createStream();
    const mic = Promise.withResolvers<any>();
    (mediaDevices.getUserMedia as jest.Mock).mockReturnValue(mic.promise);
    const service = createService();
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const first = service.answer(session.id);
    const second = service.answer(session.id);
    expect(second).toBe(first);
    mic.resolve(stream);
    await expect(first).resolves.toBe(true);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(session.answer).toHaveBeenCalledTimes(1);
    await expect(service.answer(session.id)).resolves.toBe(true);
    expect(session.answer).toHaveBeenCalledTimes(1);
  });

  test('caller hangup during microphone acquisition cannot revive an incoming call', async () => {
    mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
    const { stream, track } = createStream();
    const mic = Promise.withResolvers<any>();
    (mediaDevices.getUserMedia as jest.Mock).mockReturnValue(mic.promise);
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    const pending = service.answer(session.id);
    session.emit('ended', { cause: 'Canceled' });
    mic.resolve(stream);
    await expect(pending).resolves.toBe(false);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(session.answer).not.toHaveBeenCalled();
    expect(events.onCallEstablished).not.toHaveBeenCalled();
  });

  test('enrolled devices register through a gateway ticket and use gateway relay ICE', async () => {
    resetGatewaySession();
    const assignment = {
      deviceId: 'dev-1', pbxId: 'pbx-1', pbxName: 'Sokrat Lab', extension: '160',
      wsURL: 'ws://gateway.example.com:8088/ws', apiURL: 'http://gateway.example.com:8095', mediaIps: [],
    };
    setActiveGatewaySession(
      createGatewaySession('gateway.example.com', 'a'.repeat(64), 'dev-1', assignment),
    );
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) =>
      key.includes('/gateway/v1/') ? JSON.stringify({
        host: 'gateway.example.com', extension: '160', claimSecret: 'a'.repeat(64),
        deviceId: 'dev-1', status: 'approved', gatewayMode: true, assignment,
      }) : null);
    const { stream } = createStream();
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).endsWith('/api/gateway/enrollment/claim')) {
        return { ok: true, status: 200, json: async () => ({ status: 'approved', assignment }) };
      }
      if (String(url).endsWith('/api/gateway/sip-ticket')) {
        return { ok: true, status: 200, json: async () => ({ ticket: 'ticket-1', expiresIn: 30 }) };
      }
      if (String(url).endsWith('/api/gateway/ice')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const service = createService();
      await service.connect('160', 'pw', 'gateway.example.com', false);

      const ua = mockUaInstances[0];
      expect(ua.configuration.sockets[0].url).toMatch(
        /^wss:\/\/gateway\.example\.com:8089\/ws\?ticket=ticket-1&flow=[a-f0-9]{32}$/,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'https://gateway.example.com/api/gateway/sip-ticket',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${'a'.repeat(64)}`,
            'X-Sokrat-Device': 'dev-1',
          }),
        }),
      );

      await service.call('102');
      expect(ua.calls[0].options.pcConfig).toMatchObject({
        iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }],
      });
      expect(ua.calls[0].options.pcConfig.iceTransportPolicy).toBe('relay');
      expect(mockMediaConfiguration).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
      (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue(null);
      resetGatewaySession();
    }
  });

  test('uses the PBX direct fallback when the gateway ticket fails', async () => {
    resetGatewaySession();
    const assignment = {
      deviceId: 'dev-1', pbxId: 'pbx-1', pbxName: 'Sokrat Lab', extension: '160',
      wsURL: 'ws://gateway.example.com:8088/ws', apiURL: 'http://gateway.example.com:8095', mediaIps: [],
      directFallback: {
        wsURL: 'wss://public-pbx.example.com:8089/ws',
        apiURL: 'https://public-pbx.example.com:8080',
      },
    };
    setActiveGatewaySession(
      createGatewaySession('gateway.example.com', 'a'.repeat(64), 'dev-1', assignment),
    );
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ success: false }),
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const service = createService();
      await service.connect('160', 'pw', 'gateway.example.com', false);
      expect(mockUaInstances[0].configuration.sockets[0].url).toMatch(
        /^wss:\/\/public-pbx\.example\.com:8089\/ws\?flow=[a-f0-9]{32}$/,
      );
    } finally {
      globalThis.fetch = previousFetch;
      resetGatewaySession();
    }
  });

  describe('active call network handover', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    async function activeSession(direction: 'incoming' | 'outgoing' = 'outgoing') {
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com');
      const ua = mockUaInstances[0];
      ua.emit('registered');
      const session = Object.assign(createSession(direction), {
        isEstablished: jest.fn(() => true),
        isReadyToReOffer: jest.fn(() => true),
        renegotiate: jest.fn(() => true),
      });
      Object.assign(session.connection, { setConfiguration: jest.fn() });
      ua.emit('newRTCSession', { session, request: {} });
      session.emit('confirmed');
      const socket = ua.configuration.sockets[0];
      const reconnect = jest.spyOn(socket, 'reconnect').mockImplementation(() => ua.emit('disconnected'));
      mockMediaConfiguration.mockResolvedValue(relayConfiguration);
      return { service, session, ua, reconnect };
    }

    test.each(['incoming', 'outgoing'] as const)('%s call retains its UA, identity and mute/hold through Wi-Fi → data', async direction => {
      const { service, session, ua, reconnect } = await activeSession(direction);
      const call = service.activeCall!;
      call.isMuted = true;
      call.isHeld = true;
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      service.handleNetworkChange({ isConnected: false, networkType: 'NONE' });
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      await jest.advanceTimersByTimeAsync(350);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(session.renegotiate).not.toHaveBeenCalled(); // wait for auth/registration
      ua.emit('registered');
      await jest.advanceTimersByTimeAsync(0);
      expect(session.renegotiate).toHaveBeenCalledWith({ rtcOfferConstraints: { iceRestart: true } }, expect.any(Function));
      expect(session.connection).toHaveProperty('setConfiguration', expect.any(Function));
      expect(mockUaInstances).toHaveLength(1);
      expect(service.activeCall).toBe(call);
      expect(call).toMatchObject({ id: session.id, isHeld: true, isMuted: true });
      expect(session.terminate).not.toHaveBeenCalled();
    });

    test('ignores startup and repeated snapshots, coalesces capability callbacks', async () => {
      const { service, reconnect } = await activeSession();
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      await jest.advanceTimersByTimeAsync(500);
      expect(reconnect).not.toHaveBeenCalled();
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      await jest.advanceTimersByTimeAsync(350);
      expect(reconnect).toHaveBeenCalledTimes(1);
    });

    test('same transport on a different Android network triggers handover', async () => {
      const { service, reconnect } = await activeSession();
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI', networkId: 'wifi-a' });
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI', networkId: 'wifi-a' });
      await jest.advanceTimersByTimeAsync(500);
      expect(reconnect).not.toHaveBeenCalled();
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI', networkId: 'wifi-b' });
      await jest.advanceTimersByTimeAsync(350);
      expect(reconnect).toHaveBeenCalledTimes(1);
    });

    test('data → Wi-Fi waits for an in-progress hold/re-offer to finish', async () => {
      const { service, session, ua } = await activeSession();
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      session.isReadyToReOffer.mockReturnValue(false);
      await jest.advanceTimersByTimeAsync(350);
      ua.emit('registered');
      await jest.advanceTimersByTimeAsync(500);
      expect(session.renegotiate).not.toHaveBeenCalled();
      session.isReadyToReOffer.mockReturnValue(true);
      await jest.advanceTimersByTimeAsync(500);
      expect(session.renegotiate).toHaveBeenCalledTimes(1);
    });

    test('retries a declined re-offer without replacing the session', async () => {
      const { service, session, ua } = await activeSession();
      session.renegotiate.mockReturnValueOnce(false);
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      await jest.advanceTimersByTimeAsync(350);
      ua.emit('registered');
      await jest.advanceTimersByTimeAsync(500);
      expect(session.renegotiate).toHaveBeenCalledTimes(2);
      expect(mockUaInstances).toHaveLength(1);
    });

    test('hangup during relay credential fetch cannot revive or renegotiate the ended call', async () => {
      const { service, session, ua } = await activeSession();
      let finish!: (value: typeof relayConfiguration) => void;
      mockMediaConfiguration.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      await jest.advanceTimersByTimeAsync(350);
      ua.emit('registered');
      await jest.advanceTimersByTimeAsync(0);
      session.emit('ended');
      finish(relayConfiguration);
      await jest.advanceTimersByTimeAsync(500);
      expect(session.renegotiate).not.toHaveBeenCalled();
      expect(service.activeCall).toBeNull();
    });

    test('extended levels apply speaker gain and dispatch boosted microphone gain', async () => {
      const { service } = await activeSession();
      const setTrackVolume = jest.fn();
      const call = service.activeCall!;
      call.remoteStream = {
        getAudioTracks: () => [{ kind: 'audio', _setVolume: setTrackVolume }],
      } as unknown as NonNullable<typeof call.remoteStream>;

      service.setSpeakerVolume(195);
      expect(setTrackVolume).toHaveBeenCalledWith(2.6);

      const fetchMock = globalThis.fetch as unknown as jest.Mock;
      fetchMock.mockClear();
      service.setMicVolume(100);
      await jest.advanceTimersByTimeAsync(200);

      const volumeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/call/volume'));
      expect(volumeCall).toBeTruthy();
      expect(JSON.parse(volumeCall![1].body)).toMatchObject({ micGainDb: 31 });
    });

    test('logout cancels a pending handover and does not register again', async () => {
      const { service, reconnect } = await activeSession();
      service.handleNetworkChange({ isConnected: true, networkType: 'WIFI' });
      service.handleNetworkChange({ isConnected: true, networkType: 'CELLULAR' });
      service.disconnect();
      await jest.advanceTimersByTimeAsync(25000);
      expect(reconnect).not.toHaveBeenCalled();
      expect(mockUaInstances).toHaveLength(1);
    });
  });
  describe('temporary media diagnostics', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => {
      activeServices.forEach(service => service.disconnect());
      jest.clearAllTimers();
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    test('keeps one native stats request in flight across session replacement', async () => {
      const service = createService();
      const first = createSession();
      const second = createSession();
      let finish!: (stats: Map<string, Record<string, unknown>>) => void;
      const firstStats = jest.fn(() => new Promise<Map<string, Record<string, unknown>>>(resolve => { finish = resolve; }));
      const secondStats = jest.fn().mockResolvedValue(new Map());
      Object.assign(first.connection, { getStats: firstStats });
      Object.assign(second.connection, { getStats: secondStats });
      const log = jest.spyOn(console, 'info').mockImplementation(() => {});
      const start = Reflect.get(service, 'startMediaDiagnostics').bind(service);

      Reflect.set(service, 'currentSession', first);
      start(first);
      Reflect.set(service, 'currentSession', second);
      start(second);
      expect(firstStats).toHaveBeenCalledTimes(1);
      expect(secondStats).not.toHaveBeenCalled();
      finish(new Map());
      await Promise.resolve();
      expect(log).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2000);
      expect(secondStats).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    });

    test('keeps AGC alive beyond diagnostics timeout and retries a stats failure', async () => {
      const service = createService();
      const session = createSession();
      const stats = jest.fn()
        .mockRejectedValueOnce(new Error('transient stats failure'))
        .mockResolvedValue(new Map([
          ['source', { type: 'media-source', kind: 'audio', audioLevel: 10 ** (-40 / 20) }],
        ]));
      Object.assign(session.connection, { getStats: stats });
      Reflect.set(service, 'currentSession', session);
      Reflect.set(service, 'activeCall', { id: 'agc-call' });
      const setLiveGain = jest.spyOn(service, 'setLiveMicGain').mockResolvedValue(true);
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const start = Reflect.get(service, 'startMicAgc').bind(service);

      start(session);
      await jest.advanceTimersByTimeAsync(700_000);

      expect(stats.mock.calls.length).toBeGreaterThan(300);
      expect(setLiveGain).toHaveBeenCalled();
      const stop = Reflect.get(service, 'stopMicAgc');
      expect(typeof stop).toBe('function');
      stop.call(service);
      const settledCalls = stats.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(stats.mock.calls.length).toBe(settledCalls);
    });

    test('ignores a stale confirmed event without stopping current diagnostics', async () => {
      const service = createService();
      const obsolete = createSession();
      const current = createSession();
      const currentStats = jest.fn().mockResolvedValue(new Map());
      const obsoleteStats = jest.fn().mockResolvedValue(new Map());
      Object.assign(current.connection, { getStats: currentStats });
      Object.assign(obsolete.connection, { getStats: obsoleteStats });
      jest.spyOn(console, 'info').mockImplementation(() => {});
      const start = Reflect.get(service, 'startMediaDiagnostics').bind(service);

      Reflect.set(service, 'currentSession', current);
      start(current);
      await Promise.resolve();
      start(obsolete);
      await jest.advanceTimersByTimeAsync(2000);
      expect(currentStats).toHaveBeenCalledTimes(2);
      expect(obsoleteStats).not.toHaveBeenCalled();
    });
  });

  describe('outgoing early media', () => {
    const InCallManager = require('react-native-incall-manager').default;
    const EARLY_MEDIA_SDP = [
      'v=0',
      'm=audio 19462 UDP/TLS/RTP/SAVPF 0 126',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:126 telephone-event/8000',
      'a=sendrecv',
      '',
    ].join('\r\n');
    const RECEIVE_ONLY_SDP = EARLY_MEDIA_SDP.replace('a=sendrecv', 'a=recvonly');

    function audioTrack() {
      return { kind: 'audio', enabled: false, readyState: 'live', stop: jest.fn() };
    }

    function statsWith(packets: number) {
      return new Map([[
        'inbound-audio',
        { type: 'inbound-rtp', kind: 'audio', packetsReceived: packets, bytesReceived: packets * 160 },
      ]]);
    }

    beforeEach(() => {
      jest.useFakeTimers();
      jest.clearAllMocks();
    });
    afterEach(() => {
      activeServices.forEach((service) => service.disconnect());
      activeServices.length = 0;
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    async function outgoing(session = createSession('outgoing'), events = createEvents()) {
      const service = createService(events);
      // connect() first resets the service through disconnect(false), which
      // legitimately stops any previous ringback. Start observing the native
      // ringback only once this call's leg is live.
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      ua.emit('newRTCSession', { session, request: {} });
      InCallManager.stopRingback.mockClear();
      return { service, session, ua, events };
    }

    test('a programmatic track event alone does not silence ringback or publish audio', async () => {
      const track = audioTrack();
      const session = createSession('outgoing');
      Object.assign(session.connection, {
        getReceivers: jest.fn(() => [{ track }]),
        getStats: jest.fn(async () => statsWith(9)),
      });
      const { service } = await outgoing(session);
      const trackListener = session.connection.addEventListener.mock.calls
        .find(([event]) => event === 'track')?.[1] as (event: unknown) => void;

      trackListener({ track });
      session.emit('progress');
      await jest.advanceTimersByTimeAsync(600);

      // No remote description: a receiver object is created by our own audio
      // transceiver, so it cannot prove that any media is arriving.
      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
      expect(service.activeCall?.remoteStream).toBeFalsy();
      expect(service.activeCall?.status).toBe('ringing');
    });

    test('keeps local ringback on 180 Ringing without SDP', async () => {
      const session = createSession('outgoing');
      Object.assign(session.connection, {
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
        getStats: jest.fn(async () => statsWith(4)),
      });
      const { service } = await outgoing(session);

      session.emit('progress');
      await jest.advanceTimersByTimeAsync(600);

      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
      expect(service.activeCall?.remoteStream).toBeFalsy();
      expect(service.activeCall?.status).toBe('ringing');
    });

    test('183 with inbound RTP activates early audio before the call is confirmed', async () => {
      const session = createSession('outgoing');
      Object.assign(session.connection, {
        remoteDescription: { sdp: EARLY_MEDIA_SDP },
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
        getStats: jest.fn(async () => statsWith(5)),
      });
      const { service, events } = await outgoing(session);
      session.emit('sdp', { originator: 'remote', type: 'answer', sdp: EARLY_MEDIA_SDP });
      session.emit('progress');
      await jest.advanceTimersByTimeAsync(400);

      expect(InCallManager.stopRingback).toHaveBeenCalled();
      expect(service.activeCall?.remoteStream).toBeTruthy();
      expect(service.activeCall?.status).toBe('ringing');
      expect(events.onCallEstablished).not.toHaveBeenCalled();
    });

    test('183 SDP without received RTP keeps ringback until the 200 confirms', async () => {
      const session = createSession('outgoing');
      Object.assign(session.connection, {
        remoteDescription: { sdp: EARLY_MEDIA_SDP },
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
        getStats: jest.fn(async () => statsWith(0)),
      });
      const { service, events } = await outgoing(session);
      session.emit('sdp', { originator: 'remote', type: 'answer', sdp: EARLY_MEDIA_SDP });
      session.emit('progress');
      await jest.advanceTimersByTimeAsync(800);
      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
      expect(service.activeCall?.status).toBe('ringing');

      session.emit('confirmed');
      await jest.advanceTimersByTimeAsync(400);
      expect(InCallManager.stopRingback).toHaveBeenCalled();
      expect(service.activeCall?.status).toBe('active');
      expect(events.onCallEstablished).toHaveBeenCalledTimes(1);
      expect(service.activeCall?.remoteStream).toBeTruthy();
    });

    test.each([
      ['receive-only', RECEIVE_ONLY_SDP],
      ['disabled (port 0)', 'v=0\r\nm=audio 0 UDP/TLS/RTP/SAVPF 0 126\r\na=sendrecv\r\n'],
    ])('an audio section that is %s never counts as early media', async (_label, sdp) => {
      const session = createSession('outgoing');
      Object.assign(session.connection, {
        remoteDescription: { sdp },
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
        getStats: jest.fn(async () => statsWith(7)),
      });
      await outgoing(session);

      session.emit('progress');
      await jest.advanceTimersByTimeAsync(600);

      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
    });

    test('activates early media that starts long after the 183', async () => {
      const session = createSession('outgoing');
      let packets = 0;
      Object.assign(session.connection, {
        remoteDescription: { sdp: EARLY_MEDIA_SDP },
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
        getStats: jest.fn(async () => statsWith(packets)),
      });
      const { service } = await outgoing(session);

      session.emit('sdp', { originator: 'remote', type: 'answer', sdp: EARLY_MEDIA_SDP });
      session.emit('progress');
      await jest.advanceTimersByTimeAsync(12000);
      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
      expect(service.activeCall?.status).toBe('ringing');

      packets = 3;
      await jest.advanceTimersByTimeAsync(700);

      expect(InCallManager.stopRingback).toHaveBeenCalled();
      expect(service.activeCall?.remoteStream).toBeTruthy();
      expect(service.activeCall?.status).toBe('ringing');
    });

    test('without RTP statistics the ringback survives until confirmation', async () => {
      const session = createSession('outgoing');
      Object.assign(session.connection, {
        remoteDescription: { sdp: EARLY_MEDIA_SDP },
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
      });
      const { service } = await outgoing(session);

      session.emit('sdp', { originator: 'remote', type: 'answer', sdp: EARLY_MEDIA_SDP });
      session.emit('progress');
      await jest.advanceTimersByTimeAsync(12000);
      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
      expect(service.activeCall?.remoteStream).toBeFalsy();

      session.emit('confirmed');
      await jest.advanceTimersByTimeAsync(400);
      expect(InCallManager.stopRingback).toHaveBeenCalled();
      expect(service.activeCall?.status).toBe('active');
    });

    test('a hung-up leg cannot apply its SDP to, or silence, the next call', async () => {
      const first = createSession('outgoing');
      first.id = 'first-call';
      Object.assign(first.connection, {
        remoteDescription: { sdp: EARLY_MEDIA_SDP },
        getReceivers: jest.fn(() => [{ track: audioTrack() }]),
        getStats: jest.fn(async () => statsWith(1)),
      });
      const { service, ua } = await outgoing(first);
      first.emit('sdp', { originator: 'remote', type: 'answer', sdp: EARLY_MEDIA_SDP });
      await service.hangup(first.id);

      const second = createSession('outgoing');
      second.id = 'second-call';
      ua.emit('newRTCSession', { session: second, request: {} });
      InCallManager.stopRingback.mockClear();

      // Late events from the terminated leg arrive while the new call rings.
      first.emit('progress');
      second.emit('progress');
      await jest.advanceTimersByTimeAsync(600);

      expect(service.activeCall?.id).toBe('second-call');
      expect(service.activeCall?.remoteStream).toBeFalsy();
      expect(InCallManager.stopRingback).not.toHaveBeenCalled();
      // Single SDP owner: the app never applies an answer itself.
      expect(second.connection.setRemoteDescription).not.toHaveBeenCalled();
    });

    test('remote audio direction comes from the audio m-section', () => {
      const audio = (direction: string) => [
        'v=0',
        'm=audio 5000 UDP/TLS/RTP/SAVPF 0',
        `a=${direction}`,
        '',
      ].join('\r\n');

      expect(remoteAudioSends(undefined)).toBe(false);
      expect(remoteAudioSends('v=0\r\nm=video 5004 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n')).toBe(false);
      expect(remoteAudioSends(audio('sendrecv'))).toBe(true);
      expect(remoteAudioSends(audio('sendonly'))).toBe(true);
      expect(remoteAudioSends(audio('recvonly'))).toBe(false);
      expect(remoteAudioSends(audio('inactive'))).toBe(false);
      // No direction attribute at all defaults to sendrecv.
      expect(remoteAudioSends('v=0\r\nm=audio 5000 UDP/TLS/RTP/SAVPF 0\r\n')).toBe(true);
      // A session-level direction applies until the audio section overrides it.
      expect(remoteAudioSends([
        'v=0',
        'a=sendonly',
        'm=audio 5000 UDP/TLS/RTP/SAVPF 0',
        '',
      ].join('\r\n'))).toBe(true);
      expect(remoteAudioSends([
        'v=0',
        'a=sendrecv',
        'm=audio 5000 UDP/TLS/RTP/SAVPF 0',
        'a=recvonly',
        '',
      ].join('\r\n'))).toBe(false);
      // A disabled audio m-line (port 0) carries no media.
      expect(remoteAudioSends('v=0\r\nm=audio 0 UDP/TLS/RTP/SAVPF 0\r\na=sendrecv\r\n')).toBe(false);
      // A direction inside a preceding video/application section belongs to
      // that section, never to the session: the audio section below keeps the
      // sendrecv default even though the video leg is sendonly.
      expect(remoteAudioSends([
        'v=0',
        'm=video 5004 UDP/TLS/RTP/SAVPF 96',
        'a=sendonly',
        'm=audio 5000 UDP/TLS/RTP/SAVPF 0',
        '',
      ].join('\r\n'))).toBe(true);
      expect(remoteAudioSends([
        'v=0',
        'm=application 5006 UDP/DTLS/SCTP webrtc-datachannel',
        'a=inactive',
        'm=audio 5000 UDP/TLS/RTP/SAVPF 0',
        '',
      ].join('\r\n'))).toBe(true);
      // A session-level direction still applies before any media section.
      expect(remoteAudioSends([
        'v=0',
        'a=inactive',
        'm=audio 5000 UDP/TLS/RTP/SAVPF 0',
        '',
      ].join('\r\n'))).toBe(false);
    });
  });

  describe('single primary call ownership', () => {
    const BUSY = 'Another call is already in progress';
    type TestUa = { emit: (event: string, data?: unknown) => void };

    function errorMessage(value: unknown): string {
      if (!(value instanceof Error)) {
        throw new Error(`expected an Error, received ${String(value)}`);
      }
      return value.message;
    }

    async function establishInboundPrimary(service: JsSipService, ua: TestUa) {
      const { stream, track } = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(stream);
      const session = createSession('incoming');
      session.id = 'gsm-primary';
      ua.emit('newRTCSession', { session, request: {} });
      await expect(service.answer(session.id)).resolves.toBe(true);
      session.emit('confirmed', {});
      expect(service.activeCall?.id).toBe(session.id);
      expect(service.activeCall?.status).toBe('active');
      return { session, stream, track };
    }

    test('an ordinary outbound cannot replace an established primary call', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);

      const rejectedMic = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(rejectedMic.stream);

      await expect(service.call('150')).rejects.toThrow(BUSY);

      // The guard must run before microphone and TURN work: no second INVITE,
      // no second getUserMedia, and the primary mic stays open.
      expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      expect(ua.calls).toHaveLength(0);
      expect(primary.track.stop).not.toHaveBeenCalled();
      expect(rejectedMic.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('gsm-primary');
      expect(service.activeCall?.status).toBe('active');

      // The old session stays the one controllable/hangupable leg.
      await expect(service.hangup('gsm-primary')).resolves.toBe(true);
      expect(primary.session.terminate).toHaveBeenCalledTimes(1);
      expect(primary.track.stop).toHaveBeenCalledTimes(1);
      expect(events.onCallEnded).not.toHaveBeenCalled();
    });

    test('two rapid outbound dials reserve one attempt before microphone work resolves', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const mic = Promise.withResolvers<unknown>();
      const { stream, track } = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockReturnValue(mic.promise);

      const first = service.call('150');
      const second = service.call('151').then(
        () => null,
        (error: unknown) => error,
      );
      try {
        expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      } finally {
        // Resolve even when the assertion fails so a red run leaves no pending
        // 6 s microphone timer or unhandled call promise behind.
        mic.resolve(stream);
      }

      await expect(first).resolves.toBeUndefined();
      const secondError = await second;
      expect(secondError).toBeInstanceOf(Error);
      expect(errorMessage(secondError)).toBe(BUSY);
      expect(ua.calls).toHaveLength(1);
      expect(ua.calls[0].uri).toBe('sip:150@pbx.example.com');
      expect(track.stop).not.toHaveBeenCalled();
    });

    test('an inbound call during outbound preparation stays primary and cancels the prepared dial', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const outboundMic = Promise.withResolvers<unknown>();
      const outboundStream = createStream();
      const inboundStream = createStream();
      (mediaDevices.getUserMedia as jest.Mock)
        .mockReturnValueOnce(outboundMic.promise)
        .mockResolvedValueOnce(inboundStream.stream);

      const pending = service.call('150');
      const pendingOutcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      const inbound = createSession('incoming');
      inbound.id = 'gsm-primary';
      ua.emit('newRTCSession', { session: inbound, request: {} });
      expect(service.activeCall?.id).toBe('gsm-primary');

      outboundMic.resolve(outboundStream.stream);
      const error = await pendingOutcome;
      expect(error).toBeInstanceOf(Error);
      expect(errorMessage(error)).toMatch(/superseded/i);
      expect(ua.calls).toHaveLength(0);
      expect(outboundStream.track.stop).toHaveBeenCalledTimes(1);
      expect(inboundStream.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('gsm-primary');

      // The inbound call still answers and hangs up normally.
      await expect(service.answer(inbound.id)).resolves.toBe(true);
      expect(inboundStream.track.stop).not.toHaveBeenCalled();
      await expect(service.hangup(inbound.id)).resolves.toBe(true);
      expect(inbound.terminate).toHaveBeenCalledTimes(1);
      expect(inboundStream.track.stop).toHaveBeenCalledTimes(1);
      expect(events.onIncomingCall).toHaveBeenCalledWith(
        expect.objectContaining({ callId: 'gsm-primary' }),
      );
    });

    test('an outbound session arriving after an inbound primary cannot replace it', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);
      const statusCalls = (events.onCallStatusChange as jest.Mock).mock.calls.length;

      const rogue = createSession('outgoing');
      rogue.id = 'rogue-outbound';
      ua.emit('newRTCSession', { session: rogue, request: {} });

      expect(rogue.terminate).toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('gsm-primary');
      expect(service.activeCall?.status).toBe('active');
      expect(events.onCallStatusChange).toHaveBeenCalledTimes(statusCalls);
      expect(events.onCallEnded).not.toHaveBeenCalled();
      await expect(service.hangup('gsm-primary')).resolves.toBe(true);
      expect(primary.session.terminate).toHaveBeenCalledTimes(1);
    });

    test('a pending outbound cannot cross a disconnect/reconnect or clear the newer dial', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const oldUa = mockUaInstances[0];
      const firstMic = Promise.withResolvers<unknown>();
      const firstStream = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockReturnValueOnce(firstMic.promise);

      const stale = service.call('150');
      const staleOutcome = stale.then(
        () => null,
        (error: unknown) => error,
      );
      service.disconnect();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const newUa = mockUaInstances[1];
      const secondMic = Promise.withResolvers<unknown>();
      const secondStream = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockReturnValueOnce(secondMic.promise);

      const fresh = service.call('151');
      expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      secondMic.resolve(secondStream.stream);
      await expect(fresh).resolves.toBeUndefined();
      expect(newUa.calls).toHaveLength(1);
      expect(newUa.calls[0].uri).toBe('sip:151@pbx.example.com');

      const freshSession = createSession('outgoing');
      freshSession.id = 'fresh-session';
      newUa.emit('newRTCSession', { session: freshSession, request: {} });
      expect(service.activeCall?.id).toBe('fresh-session');

      firstMic.resolve(firstStream.stream);
      const staleError = await staleOutcome;
      expect(staleError).toBeInstanceOf(Error);
      expect(errorMessage(staleError)).toMatch(/superseded/i);
      expect(oldUa.calls).toHaveLength(0);
      expect(newUa.calls).toHaveLength(1);
      expect(firstStream.track.stop).toHaveBeenCalledTimes(1);
      expect(secondStream.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('fresh-session');

      await expect(service.hangup('fresh-session')).resolves.toBe(true);
      expect(freshSession.terminate).toHaveBeenCalledTimes(1);
      expect(secondStream.track.stop).toHaveBeenCalledTimes(1);
    });

    test('attended transfer consultation remains the one permitted second outbound', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = { ...createEvents(), onAttendedTransferChange: jest.fn() };
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);
      const consultStream = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(consultStream.stream);

      await expect(service.startAttendedTransfer('150')).resolves.toBeUndefined();
      expect(ua.calls).toHaveLength(1);
      expect(ua.calls[0].uri).toBe('sip:150@pbx.example.com');
      expect(primary.session.terminate).not.toHaveBeenCalled();

      const consult = createSession('outgoing');
      consult.id = 'consult-session';
      ua.emit('newRTCSession', { session: consult, request: {} });
      expect(service.activeCall?.id).toBe('consult-session');
      expect(events.onAttendedTransferChange).toHaveBeenCalledWith(
        expect.objectContaining({
          consultCallId: 'consult-session',
          status: 'ringing',
          activeLine: 'consult',
        }),
      );
      expect(primary.session.terminate).not.toHaveBeenCalled();

      consult.emit('confirmed', {});
      expect(events.onAttendedTransferChange).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'connected', activeLine: 'consult' }),
      );
      expect(service.activeCall?.id).toBe('consult-session');
      expect(primary.session.terminate).not.toHaveBeenCalled();
    });

    test('a failed consultation preparation keeps and resumes the borrowed primary microphone', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = { ...createEvents(), onAttendedTransferChange: jest.fn() };
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);

      // The consultation acquisition hands back the live primary stream.
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(primary.stream);
      const dispatch = jest.spyOn(ua, 'call').mockImplementationOnce(() => {
        throw new Error('transport closed');
      });
      try {
        await expect(service.startAttendedTransfer('150')).rejects.toThrow('transport closed');
      } finally {
        dispatch.mockRestore();
      }

      // A borrowed stream is not the attempt's to stop on failure.
      expect(primary.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('gsm-primary');
      expect(service.activeCall?.isHeld).toBe(true);

      // Cancelling the failed consultation restores the same live primary.
      service.cancelAttendedTransfer();
      expect(primary.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('gsm-primary');
      expect(service.activeCall?.isHeld).toBe(false);
      expect(service.activeCall?.status).toBe('active');
      expect(events.onAttendedTransferChange).toHaveBeenCalledWith(null);

      await expect(service.hangup('gsm-primary')).resolves.toBe(true);
      expect(primary.track.stop).toHaveBeenCalledTimes(1);
    });

    test('a completed incoming call cannot resurrect a superseded pending dial', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const mic = Promise.withResolvers<unknown>();
      const { stream, track } = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockReturnValueOnce(mic.promise);
      const pending = service.call('150').then(
        () => null,
        (error: unknown) => error,
      );

      const incoming = createSession('incoming');
      incoming.id = 'brief-incoming';
      ua.emit('newRTCSession', { session: incoming, request: {} });
      incoming.emit('ended', { cause: 'Terminated' });
      mic.resolve(stream);
      const result = await pending;

      expect(result).toBeInstanceOf(Error);
      expect(errorMessage(result)).toMatch(/superseded/i);
      expect(ua.calls).toHaveLength(0);
      expect(service.activeCall).toBeNull();
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(service.hasCallInProgress()).toBe(false);
    });

    test('a cancelled consultation cannot steal a restarted consultation target', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = { ...createEvents(), onAttendedTransferChange: jest.fn() };
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);
      const oldMic = Promise.withResolvers<unknown>();
      const oldCapture = createStream();
      const nextCapture = createStream();
      (mediaDevices.getUserMedia as jest.Mock)
        .mockReturnValueOnce(oldMic.promise)
        .mockResolvedValueOnce(nextCapture.stream);

      const cancelled = service.startAttendedTransfer('150').then(
        () => null,
        (error: unknown) => error,
      );
      service.cancelAttendedTransfer();
      const restarted = await service.startAttendedTransfer('151').then(
        () => null,
        (error: unknown) => error,
      );
      oldMic.resolve(oldCapture.stream);
      const cancelledResult = await cancelled;

      expect(restarted).toBeNull();
      expect(cancelledResult).toBeInstanceOf(Error);
      expect(errorMessage(cancelledResult)).toMatch(/superseded/i);
      expect(ua.calls.map((call: { uri: string }) => call.uri)).toEqual([
        'sip:151@pbx.example.com',
      ]);
      expect(oldCapture.track.stop).toHaveBeenCalledTimes(1);
      expect(nextCapture.track.stop).not.toHaveBeenCalled();
      expect(primary.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe('gsm-primary');
      service.disconnect(false);
    });

    test('a failed fresh-microphone consultation leaves primary capture owned until hangup', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = { ...createEvents(), onAttendedTransferChange: jest.fn() };
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);
      const consultation = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(consultation.stream);
      const dispatch = jest.spyOn(ua, 'call').mockImplementationOnce(() => {
        throw new Error('transport closed');
      });
      try {
        await expect(service.startAttendedTransfer('150')).rejects.toThrow('transport closed');
      } finally {
        dispatch.mockRestore();
      }

      expect(consultation.track.stop).toHaveBeenCalledTimes(1);
      expect(primary.track.stop).not.toHaveBeenCalled();
      service.cancelAttendedTransfer();
      expect(service.activeCall?.id).toBe('gsm-primary');
      expect(service.activeCall?.isHeld).toBe(false);
      await expect(service.hangup('gsm-primary')).resolves.toBe(true);
      expect(primary.track.stop).toHaveBeenCalledTimes(1);
      expect(consultation.track.stop).toHaveBeenCalledTimes(1);
    });

    test('disconnect clears consultation ownership even when UA teardown throws', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const events = { ...createEvents(), onAttendedTransferChange: jest.fn() };
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const primary = await establishInboundPrimary(service, ua);
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(createStream().stream);
      await service.startAttendedTransfer('150');
      const consultation = createSession('outgoing');
      consultation.id = 'old-consultation';
      ua.emit('newRTCSession', { session: consultation, request: {} });
      consultation.emit('confirmed', {});

      const teardown = jest.spyOn(ua, 'stop').mockImplementationOnce(() => {
        throw new Error('transport teardown failed');
      });
      try {
        service.disconnect();
      } finally {
        teardown.mockRestore();
      }

      await service.connect('160', 'pw', 'pbx.example.com', false);
      const freshUa = mockUaInstances[mockUaInstances.length - 1];
      const freshCapture = createStream();
      (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(freshCapture.stream);
      await expect(service.call('151')).resolves.toBeUndefined();
      const freshSession = createSession('outgoing');
      freshSession.id = 'fresh-primary-after-transfer';
      freshUa.emit('newRTCSession', { session: freshSession, request: {} });

      consultation.emit('ended', { cause: 'Terminated' });
      primary.session.emit('ended', { cause: 'Terminated' });
      expect(freshUa.calls.map((call: { uri: string }) => call.uri)).toEqual([
        'sip:151@pbx.example.com',
      ]);
      expect(service.activeCall?.id).toBe(freshSession.id);
      expect(freshCapture.track.stop).not.toHaveBeenCalled();
      expect(events.onAttendedTransferChange).toHaveBeenLastCalledWith(null);
      await expect(service.hangup(freshSession.id)).resolves.toBe(true);
      expect(freshCapture.track.stop).toHaveBeenCalledTimes(1);
    });

    test('a stale failed inbound answer cannot stop a newer outbound microphone', async () => {
      mockMediaConfiguration
        .mockRejectedValueOnce(new Error('relay unavailable'))
        .mockResolvedValue({ iceServers: [] });
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const oldMic = Promise.withResolvers<unknown>();
      const freshCapture = createStream();
      (mediaDevices.getUserMedia as jest.Mock)
        .mockReturnValueOnce(oldMic.promise)
        .mockResolvedValueOnce(freshCapture.stream);
      const incoming = createSession('incoming');
      incoming.id = 'cancelled-inbound-answer';
      ua.emit('newRTCSession', { session: incoming, request: {} });
      const pendingAnswer = service.answer(incoming.id);
      incoming.emit('ended', { cause: 'Terminated' });

      await service.call('151');
      const freshSession = createSession('outgoing');
      freshSession.id = 'outbound-after-failed-answer';
      ua.emit('newRTCSession', { session: freshSession, request: {} });
      oldMic.reject(new Error('microphone request cancelled'));
      await expect(pendingAnswer).resolves.toBe(false);

      expect(incoming.answer).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe(freshSession.id);
      expect(freshCapture.track.stop).not.toHaveBeenCalled();
      await expect(service.hangup(freshSession.id)).resolves.toBe(true);
      expect(freshCapture.track.stop).toHaveBeenCalledTimes(1);
    });

    test('a late inbound capture cannot orphan the newer outbound microphone on hangup', async () => {
      mockMediaConfiguration.mockResolvedValue({ iceServers: [] });
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      const ua = mockUaInstances[0];
      const oldMic = Promise.withResolvers<unknown>();
      const oldCapture = createStream();
      const freshCapture = createStream();
      (mediaDevices.getUserMedia as jest.Mock)
        .mockReturnValueOnce(oldMic.promise)
        .mockResolvedValueOnce(freshCapture.stream);
      const incoming = createSession('incoming');
      incoming.id = 'cancelled-slow-answer';
      ua.emit('newRTCSession', { session: incoming, request: {} });
      const pendingAnswer = service.answer(incoming.id);
      incoming.emit('ended', { cause: 'Terminated' });

      await service.call('151');
      const freshSession = createSession('outgoing');
      freshSession.id = 'outbound-after-slow-answer';
      ua.emit('newRTCSession', { session: freshSession, request: {} });
      oldMic.resolve(oldCapture.stream);
      await expect(pendingAnswer).resolves.toBe(false);

      expect(incoming.answer).not.toHaveBeenCalled();
      expect(oldCapture.track.stop).toHaveBeenCalledTimes(1);
      expect(freshCapture.track.stop).not.toHaveBeenCalled();
      expect(service.activeCall?.id).toBe(freshSession.id);
      await expect(service.hangup(freshSession.id)).resolves.toBe(true);
      expect(freshCapture.track.stop).toHaveBeenCalledTimes(1);
      expect(oldCapture.track.stop).toHaveBeenCalledTimes(1);
    });
  });
  describe('call safety watchdogs', () => {
    test('holds local ringback briefly after the callee answers', async () => {
      const service = createService();
      await service.connect('160', 'pw', 'pbx.example.com', false);
      jest.useFakeTimers();
      try {
        const session = createSession('outgoing');
        mockUaInstances[0].emit('newRTCSession', { session, request: {} });
        (InCallManager.stopRingback as jest.Mock).mockClear();

        session.emit('accepted');
        expect(InCallManager.stopRingback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(400);
        expect(InCallManager.stopRingback).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('ends an outbound call that never receives a terminal response', async () => {
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      jest.useFakeTimers();
      try {
        const session = createSession('outgoing');
        mockUaInstances[0].emit('newRTCSession', { session, request: {} });

        jest.advanceTimersByTime(OUTGOING_RING_TIMEOUT_MS);

        expect(events.onCallEnded).toHaveBeenCalledWith(
          session.id,
          'NO_ANSWER',
          expect.objectContaining({ statusCode: 408 }),
        );
        expect(session.terminate).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('abandons a 2xx that never confirms', async () => {
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      jest.useFakeTimers();
      try {
        const session = createSession('outgoing');
        mockUaInstances[0].emit('newRTCSession', { session, request: {} });
        session.emit('accepted');

        jest.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS);

        expect(events.onCallEnded).toHaveBeenCalledWith(
          session.id,
          'CONFIRMATION_TIMEOUT',
          expect.anything(),
        );
        expect(session.terminate).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    test('does not arm the outbound confirmation timeout for an inbound call', async () => {
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      jest.useFakeTimers();
      try {
        const session = createSession('incoming');
        mockUaInstances[0].emit('newRTCSession', { session, request: {} });
        session.emit('accepted');

        jest.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS);

        expect(events.onCallEnded).not.toHaveBeenCalledWith(
          expect.anything(),
          'CONFIRMATION_TIMEOUT',
          expect.anything(),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    test('ends the call when a dropped signaling transport is not restored', async () => {
      const events = createEvents();
      const service = createService(events);
      await service.connect('160', 'pw', 'pbx.example.com', false);
      jest.useFakeTimers();
      try {
        const session = createSession('outgoing');
        mockUaInstances[0].emit('newRTCSession', { session, request: {} });
        const ua = mockUaInstances[0];
        ua.isConnected = () => false;
        ua.isRegistered = () => false;

        ua.emit('disconnected');
        jest.advanceTimersByTime(SIGNALING_GRACE_MS);

        expect(events.onCallEnded).toHaveBeenCalledWith(
          session.id,
          'SIGNALING_LOST',
          expect.objectContaining({ reasonPhrase: 'Signalling lost' }),
        );
        expect(session.terminate).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
