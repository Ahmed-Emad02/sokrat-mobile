import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import App from '../App';
import { RingingScreen } from '../src/ui/RingingScreen';
import { SipEvents, ActiveCall, IncomingCallInfo } from '../src/sip/JsSipService';
import { CallActionPayload } from '../src/calls/nativeCallNotification';
import { resolveCallerName } from '../src/calls/callerNameResolver';

let mockEvents: SipEvents;
let mockNativeAction: (payload: CallActionPayload) => void;
let mockPush: (payload: any) => void;
const mockSip = {
  activeCall: null as ActiveCall | null,
  answer: jest.fn(async () => true),
  decline: jest.fn(async () => true),
  hangup: jest.fn(async (_id?: string) => true),
  disconnect: jest.fn(),
  handleNetworkChange: jest.fn(),
  reconnectIfDisconnected: jest.fn(),
  setSpeakerVolume: jest.fn(),
  setMicVolume: jest.fn(),
};
const mockSilence = jest.fn();
const mockDismiss = jest.fn();
const mockClearPending = jest.fn(async (_callId?: string) => {});

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 36 },
  NativeModules: {},
  StatusBar: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'audio', POST_NOTIFICATIONS: 'notifications', BLUETOOTH_CONNECT: 'bluetooth' },
    RESULTS: { GRANTED: 'granted' },
    requestMultiple: async () => ({ audio: 'granted', notifications: 'granted', bluetooth: 'granted' }),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { bg: '#000' }, isDark: true }),
  applySystemBars: jest.fn(),
}));
jest.mock('../src/i18n', () => ({ initI18n: jest.fn() }));
jest.mock('../src/ui/Toast', () => ({ ToastContainer: () => null, showToast: jest.fn() }));
jest.mock('../src/calls/network', () => ({ subscribeNetworkChanges: () => () => {} }));
jest.mock('../src/calls/telephony', () => ({ subscribeGsmCallState: () => () => {} }));
jest.mock('../src/calls/incall', () => ({
  startCallManagers: jest.fn(), stopCallManagers: jest.fn(),
  startRingtone: jest.fn(), stopRingtone: jest.fn(),
  setCallWindowActive: jest.fn(),
  subscribeAudioDeviceChanges: () => () => {},
}));
jest.mock('../src/calls/callKit', () => ({
  setupCallKeep: jest.fn(), reportIncomingCall: jest.fn(async () => true),
  updateIncomingCaller: jest.fn(), reportEnded: jest.fn(), answerIncoming: jest.fn(),
}));

jest.mock('../src/sip/JsSipService', () => ({
  getSharedJsSipService: (events: SipEvents) => { mockEvents = events; return mockSip; },
}));
jest.mock('../src/push/pushHandler', () => ({
  initPush: (callback: (payload: any) => void) => { mockPush = callback; },
  bindExtension: jest.fn(),
  askNotificationPermission: jest.fn(),
  clearPendingIncomingCall: (id?: string) => mockClearPending(id),
  bindChatPushHandler: jest.fn(),
  normalizeChatPayload: () => null,
}));
jest.mock('../src/calls/nativeCallNotification', () => ({
  ...jest.requireActual('../src/calls/nativeCallNotification'),
  getPendingNativeCalls: async () => [],
  subscribeNativeCallAction: (callback: (payload: CallActionPayload) => void) => {
    mockNativeAction = callback;
    return () => {};
  },
  silenceNativeCallNotification: (...args: any[]) => mockSilence(...args),
  dismissNativeCallNotification: (...args: any[]) => mockDismiss(...args),
}));
jest.mock('../src/calls/callerNameResolver', () => ({ resolveCallerName: jest.fn(async () => 'Saved caller') }));
let mockRingingProps: any = null;
jest.mock('../src/ui/RingingScreen', () => ({ RingingScreen: (props: any) => { mockRingingProps = props; return null; } }));
jest.mock('../src/ui/StandardPhoneScreen', () => ({ StandardPhoneScreen: () => null }));
jest.mock('../src/ui/LoginScreen', () => ({ LoginScreen: () => null }));

const callId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function native(action: CallActionPayload['action']): CallActionPayload {
  return { action, callId, callerId: 'caller', callerName: 'Unknown', extension: 'employee', timestamp: String(Date.now()) };
}
function invite(): ActiveCall {
  const call: ActiveCall = {
    id: callId, target: 'caller', targetName: 'Unknown', direction: 'inbound',
    status: 'ringing', isMuted: false, isHeld: false, session: {},
  };
  mockSip.activeCall = call;
  mockEvents.onIncomingCall({
    type: 'incoming-call', callId, callerId: 'caller', callerName: 'Unknown',
    extension: 'employee', timestamp: Date.now(),
  } as IncomingCallInfo);
  return call;
}

describe('notification Answer / pending INVITE coordination', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.clearAllMocks();
    mockSip.activeCall = null;
    mockSip.answer.mockResolvedValue(true);
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await act(async () => { renderer = ReactTestRenderer.create(<App />); });
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(async () => {
    await act(async () => { renderer.unmount(); });
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('Answer before INVITE persists, then dispatches once without closing UI before confirmation', async () => {
    await act(async () => { mockNativeAction(native('SHOW')); });
    const answer = renderer.root.findByType(RingingScreen).props.onAnswer;
    // Deliver INVITE in the same tick as the UI Answer, before its async
    // continuation. The old no-session attempt must not erase the real intent.
    let call!: ActiveCall;
    await act(async () => {
      const pending = answer();
      call = invite();
      await pending;
    });
    expect(mockSip.answer).toHaveBeenCalledTimes(1);
    expect(mockSip.answer).toHaveBeenCalledWith(callId);
    expect(mockSilence).toHaveBeenCalledWith(callId);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockClearPending).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(1);
    expect(renderer.root.findByType(RingingScreen).props.answerRequested).toBe(true);
    await act(async () => {
      call.status = 'active';
      mockEvents.onCallEstablished(call);
    });
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(0);
    expect(mockClearPending).toHaveBeenCalledWith(callId);
  });

  test('native Answer survives delayed INVITE; late SHOW/push cannot reopen a confirmed call', async () => {
    await act(async () => { mockNativeAction(native('ANSWER')); });
    expect(mockSip.answer).not.toHaveBeenCalled();
    expect(renderer.root.findByType(RingingScreen).props.answerRequested).toBe(true);
    expect(mockDismiss).not.toHaveBeenCalled();
    let call!: ActiveCall;
    await act(async () => { call = invite(); });
    expect(mockSip.answer).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(1);
    await act(async () => {
      call.status = 'active';
      mockEvents.onCallEstablished(call);
      mockNativeAction(native('SHOW'));
      mockPush({ ...native('SHOW'), type: 'incoming-call' });
    });
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(0);
  });

  test('supplied PBX/incoming caller name is rendered when directory lookup misses', async () => {
    (resolveCallerName as jest.Mock).mockResolvedValueOnce('Unknown');
    await act(async () => {
      mockEvents.onIncomingCall({
        type: 'incoming-call', callId, callerId: '110', callerName: 'PBX Display',
        extension: 'employee', timestamp: Date.now(),
      } as IncomingCallInfo);
    });
    expect(mockRingingProps?.callerName).toBe('PBX Display');
  });

  test('decline while waiting for INVITE cancels the pending Answer', async () => {
    await act(async () => { mockNativeAction(native('ANSWER')); });
    await act(async () => { mockNativeAction(native('DECLINE')); });
    await act(async () => { invite(); });
    expect(mockSip.answer).not.toHaveBeenCalled();
    expect(mockSip.decline).toHaveBeenCalledWith(callId);
  });

  test.each(['calling', 'ringing', 'active', 'held'] as const)(
    'ongoing notification ends matching outbound %s leg, not incoming decline', async status => {
      const call: ActiveCall = {
        id: callId, target: 'caller', targetName: 'Unknown', direction: 'outbound',
        status, isMuted: false, isHeld: status === 'held', session: {},
      };
      mockSip.activeCall = call;
      await act(async () => { mockEvents.onCallStatusChange?.(call); mockNativeAction(native('END')); });
      expect(mockSip.hangup).toHaveBeenCalledWith(callId);
      expect(mockSip.decline).not.toHaveBeenCalled();
    },
  );

  test('stale ongoing notification cannot end or obscure another call', async () => {
    mockSip.activeCall = { ...invite(), id: 'different-call', direction: 'outbound', status: 'active' };
    await act(async () => { mockNativeAction(native('END')); });
    expect(mockSip.hangup).not.toHaveBeenCalled();
  });

  test('failed notification hangup retains the active call and exposes the error', async () => {
    mockSip.hangup.mockResolvedValueOnce(false);
    const call: ActiveCall = {
      id: callId, target: 'caller', targetName: 'Unknown', direction: 'inbound',
      status: 'active', isMuted: false, isHeld: false, session: {},
    };
    mockSip.activeCall = call;
    await act(async () => { mockEvents.onCallEstablished(call); mockNativeAction(native('END')); });
    expect(mockSip.hangup).toHaveBeenCalledWith(callId);
    expect(mockSip.activeCall).toBe(call);
    expect(Alert.alert).toHaveBeenCalledWith('Call not ended', expect.any(String));
  });


  test('push and native actions for another call cannot open UI or hang the active call', async () => {
    const activeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const active: ActiveCall = {
      id: activeId, target: 'caller-a', targetName: 'Caller A', direction: 'outbound',
      status: 'active', isMuted: false, isHeld: false, session: {},
    };
    mockSip.activeCall = active;
    await act(async () => { mockEvents.onCallEstablished(active); });

    // Push B arrives before B's INVITE. It must be suppressed and dismissed.
    await act(async () => {
      mockPush({
        type: 'incoming-call', callId: otherId, callerId: 'caller-b',
        callerName: 'Caller B', extension: 'employee', timestamp: String(Date.now()),
      });
    });
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(0);
    expect(mockDismiss).toHaveBeenCalledWith(otherId);

    // Native DECLINE for B must not reach A's active leg.
    await act(async () => {
      mockNativeAction({
        action: 'DECLINE', callId: otherId, callerId: 'caller-b',
        callerName: 'Caller B', extension: 'employee', timestamp: String(Date.now()),
      });
    });
    expect(mockSip.hangup).not.toHaveBeenCalled();
    expect(mockSip.decline).not.toHaveBeenCalledWith(otherId);
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(0);

    // Even when B's INVITE finally arrives, only B is declined; A is untouched.
    await act(async () => {
      mockEvents.onIncomingCall({
        type: 'incoming-call', callId: otherId, callerId: 'caller-b',
        callerName: 'Caller B', extension: 'employee', timestamp: Date.now(),
      } as IncomingCallInfo);
    });
    expect(mockSip.decline).toHaveBeenCalledWith(otherId);
    expect(mockSip.hangup).not.toHaveBeenCalled();
    expect(mockSip.activeCall?.id).toBe(activeId);
  });

  test('dispatched answer that never confirms times out and cleans up', async () => {
    let call!: ActiveCall;
    await act(async () => { call = invite(); });
    const answer = renderer.root.findByType(RingingScreen).props.onAnswer;
    await act(async () => { await answer(); });
    expect(mockSip.answer).toHaveBeenCalledWith(callId);
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(1);

    await act(async () => { jest.advanceTimersByTime(20_001); });

    expect(mockSip.hangup).toHaveBeenCalledWith(callId);
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(0);
    expect(mockDismiss).toHaveBeenCalledWith(callId);
    expect(mockSip.activeCall).toBe(call);
  });

  test('mount recovers an inbound SIP leg already received by headless bootstrap', async () => {
    await act(async () => { renderer.unmount(); });
    mockSip.activeCall = {
      id: callId, target: 'caller', targetName: 'Unknown', direction: 'inbound',
      status: 'ringing', isMuted: false, isHeld: false, session: {},
    };
    await act(async () => { renderer = ReactTestRenderer.create(<App />); });
    expect(renderer.root.findAllByType(RingingScreen)).toHaveLength(1);
    await act(async () => { await renderer.root.findByType(RingingScreen).props.onAnswer(); });
    expect(mockSip.answer).toHaveBeenCalledWith(callId);
  });
});
