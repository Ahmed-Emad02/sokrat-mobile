/**
 * Sokrat VOICE native call screen integration.
 *
 * react-native-callkeep drives CallKit (iOS) and the Android
 * TelecomManager / ConnectionService full-screen incoming call UI.
 * It must report an incoming call here within the OS cold-start budget
 * (iOS ~5s) or iOS terminates the process.
 */
import { Platform } from 'react-native';
import RNCallKeep, { CONSTANTS } from 'react-native-callkeep';

export type CallKeepHandlers = {
  onAnswerCall: (callUUID: string) => void;
  onEndCall: (callUUID: string) => void;
};

let handlers: CallKeepHandlers | null = null;

export function setupCallKeep(h: CallKeepHandlers) {
  handlers = h;

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
      additionalPermissions: [], // READ_CALL_LOG etc are added in the manifest
      selfManaged: Number(Platform.Version) >= 31,
      foregroundService: {
        channelId: 'com.sokrat.voice.voip.calls',
        channelName: 'Sokrat VOICE calls',
        notificationTitle: 'Active Sokrat call',
      },
    },
  };

  RNCallKeep.setup(options).then(() => {
    RNCallKeep.setAvailable(true);
  });

  RNCallKeep.addEventListener('answerCall', ({ callUUID }) => handlers?.onAnswerCall(callUUID));
  RNCallKeep.addEventListener('endCall', ({ callUUID }) => handlers?.onEndCall(callUUID));
  // Android dispatches this when the ConnectionService shows the incoming UI
  RNCallKeep.addEventListener('didDisplayIncomingCall', () => {});
}

/** Report a new incoming call to CallKit/Telecom. */
export function reportIncomingCall(callUUID: string, callerId: string, callerName: string) {
  RNCallKeep.displayIncomingCall(callUUID, callerId, callerName || 'Incoming Call', 'number', false);
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
  RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
}

export function reportEnded(uuid: string) {
  RNCallKeep.reportEndCallWithUUID(uuid, CONSTANTS.END_CALL_REASONS.REMOTE_ENDED);
}

export function answerIncoming(uuid: string) {
  RNCallKeep.answerIncomingCall(uuid);
}
