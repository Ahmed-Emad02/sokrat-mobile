/**
 * Sokrat VOICE iOS CallKit integration.
 *
 * Android incoming calls are owned exclusively by the Kotlin notification
 * engine. RNCallKeep must never initialize Android Telecom.
 */
import { Platform } from 'react-native';
import RNCallKeep, { CONSTANTS, InitialEvents } from 'react-native-callkeep';

export type CallKeepHandlers = {
  onAnswerCall: (callUUID: string) => void;
  onEndCall: (callUUID: string) => void;
};

type PendingCallKeepEvent = {
  type: 'answer' | 'end';
  callUUID: string;
};

let handlers: CallKeepHandlers | null = null;
let listenersInstalled = false;
let setupPromise: Promise<void> | null = null;
const pendingEvents: PendingCallKeepEvent[] = [];

const options = {
  ios: {
    appName: 'Sokrat VOICE',
    imageName: 'simptel_logo',
    supportsVideo: false,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
    includesCallsInRecents: true,
    ringtoneSound: 'ringtone.caf',
  },
  android: {
    alertTitle: 'Sokrat VOICE incoming call',
    alertDescription: 'Answer or decline this call.',
    cancelButton: 'Decline',
    okButton: 'Answer',
    additionalPermissions: [],
    selfManaged: true,
    foregroundService: {
      channelId: 'com.sokrat.voice.voip.calls',
      channelName: 'Sokrat VOICE calls',
      notificationTitle: 'Active Sokrat call',
    },
  },
};

function dispatchEvent(event: PendingCallKeepEvent) {
  if (!handlers) {
    if (!pendingEvents.some((pending) =>
      pending.type === event.type && pending.callUUID === event.callUUID
    )) {
      pendingEvents.push(event);
    }
    return;
  }
  if (event.type === 'answer') {
    handlers.onAnswerCall(event.callUUID);
  } else {
    handlers.onEndCall(event.callUUID);
  }
}

function dispatchInitialEvents(events: InitialEvents) {
  for (const event of events) {
    if (event.name === 'RNCallKeepPerformAnswerCallAction') {
      dispatchEvent({ type: 'answer', callUUID: event.data.callUUID });
    } else if (event.name === 'RNCallKeepPerformEndCallAction') {
      dispatchEvent({ type: 'end', callUUID: event.data.callUUID });
    }
  }
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    dispatchEvent({ type: 'answer', callUUID });
  });
  RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    dispatchEvent({ type: 'end', callUUID });
  });
}

export function ensureCallKeepSetup(): Promise<void> {
  if (Platform.OS !== 'ios') return Promise.resolve();
  installListeners();
  if (!setupPromise) {
    setupPromise = RNCallKeep.setup(options)
      .then(async () => {
        RNCallKeep.setAvailable(true);
        const initialEvents = await RNCallKeep.getInitialEvents();
        dispatchInitialEvents(initialEvents);
        RNCallKeep.clearInitialEvents();
      })
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

export function setupCallKeep(h: CallKeepHandlers) {
  if (Platform.OS !== 'ios') return;
  handlers = h;
  void ensureCallKeepSetup()
    .then(() => {
      const queued = pendingEvents.splice(0);
      queued.forEach(dispatchEvent);
    })
    .catch((err) => {
      console.warn('[callkeep] setup failed:', err);
    });
}

/** Report a new incoming call to CallKit/Telecom. */
export async function reportIncomingCall(
  callUUID: string,
  callerId: string,
  callerName: string,
): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    await ensureCallKeepSetup();
    RNCallKeep.displayIncomingCall(
      callUUID,
      callerId,
      callerName || 'Incoming Call',
      'number',
      false,
    );
    return true;
  } catch (err) {
    console.warn('[callkeep] display incoming call failed:', err);
    return false;
  }
}

/** A fresh UUID per incoming event so CallKit can hold several. */
export function generateUUID(): string {
  return (
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
  );
}

export function reportConnectedOutgoing(uuid: string) {
  if (Platform.OS === 'ios') RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
}

export function reportEnded(uuid: string) {
  if (Platform.OS === 'ios') {
    RNCallKeep.reportEndCallWithUUID(uuid, CONSTANTS.END_CALL_REASONS.REMOTE_ENDED);
  }
}

export function answerIncoming(uuid: string) {
  if (Platform.OS === 'ios') RNCallKeep.answerIncomingCall(uuid);
}
