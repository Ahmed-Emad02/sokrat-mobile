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
import {
  ICE_RELAY_GRACE_MS,
  ICE_RELAY_WAIT_MS,
  JsSipService,
  SipEvents,
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

describe('JsSipService media + instance id', () => {
  const originalFetch = globalThis.fetch;

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

  test('incoming call uses a human PBX display name when supplied', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming', 'PBX Contact');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    expect(service.activeCall?.targetName).toBe('PBX Contact');
    expect(events.onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({
      callerId: '102', callerName: 'PBX Contact',
    }));
  });

  test('incoming call starts with the number until app/VoIP contact lookup resolves', async () => {
    const events = createEvents();
    const service = createService(events);
    await service.connect('160', 'pw', 'pbx.example.com', false);
    const session = createSession('incoming');
    mockUaInstances[0].emit('newRTCSession', { session, request: {} });
    expect(service.activeCall?.targetName).toBe('102');
    expect(events.onIncomingCall).toHaveBeenCalledWith(expect.objectContaining({ callerId: '102', callerName: '102' }));
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
        iceTransportPolicy: 'relay',
        iceServers: [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }],
      });
      expect(mockMediaConfiguration).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
      (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue(null);
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
});
