/**
 * Sokrat VOICE Mobile Softphone App
 * Standard Phone Dialer UI with JsSIP WebRTC Engine & FCM Push-to-Wake.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, Platform, PermissionsAndroid, Alert, AppState, AppStateStatus, Permission, Linking } from 'react-native';
import { useTheme, applySystemBars } from './src/theme';
import { initI18n } from './src/i18n';
import { resolveCallerName } from './src/calls/callerNameResolver';
import { callDisplayName } from './src/calls/callerName';
import {
  JsSipService,
  getSharedJsSipService,
  SipState,
  ActiveCall,
  AttendedTransferState,
  IncomingCallInfo,
  CallEndDetails,
} from './src/sip/JsSipService';
import { ToastContainer, showToast } from './src/ui/Toast';
import {
  initPush,
  bindExtension,
  askNotificationPermission,
  clearPendingIncomingCall,
  unregisterCurrentDevice,
} from './src/push/pushHandler';
import type { CancelPayload } from './src/push/pushHandler';
import { CONFIG, getSipWss, getPushGateway } from './src/config';
import { startConnectionService, stopConnectionService } from './src/calls/connectionService';
import { prepareLogin } from './src/gateway/enrollment';
import { describeEnrollmentError } from './src/gateway/errors';
import { getOrLoadGatewaySession, resetGatewaySession } from './src/gateway/session';
import {
  setupCallKeep,
  reportIncomingCall,
  updateIncomingCaller,
  reportEnded,
  answerIncoming,
} from './src/calls/callKit';
import {
  showIncomingCallNotification,
  acknowledgeNativeCallAction,
  clearNativeCallWindow,
  dismissNativeCallNotification,
  showOngoingCallNotification,
  dismissOngoingCallNotification,
  requestIgnoreBatteryOptimizations,
  getPendingNativeCalls,
  recordNativeCallAction,
  silenceNativeCallNotification,
  subscribeNativeCallAction,
  setNativeSpeakerVolume,
  CallActionPayload,
} from './src/calls/nativeCallNotification';
import {
  startCallManagers,
  setCallWindowActive,
  stopCallManagers,
  startRingtone,
  stopRingtone,
  setSpeakerphone,
  setMicrophoneMute,
  chooseAudioRoute,
  getAudioDeviceState,
  subscribeAudioDeviceChanges,
  AudioDeviceState,
  AudioRouteType,
} from './src/calls/incall';
import { subscribeNetworkChanges, NetworkState } from './src/calls/network';
import { subscribeGsmCallState, GsmCallState } from './src/calls/telephony';
import {
  StorageService,
  SavedAccount,
  CallRecord,
  Contact,
} from './src/storage/store';
import { LoginScreen } from './src/ui/LoginScreen';
import { RingingScreen } from './src/ui/RingingScreen';
import { StandardPhoneScreen } from './src/ui/StandardPhoneScreen';

function formatCallFailureReason(cause?: string, details?: CallEndDetails): { title: string; message: string } {
  if (details?.statusCode) {
    switch (details.statusCode) {
      case 404:
        return { title: 'Call Failed (404)', message: `Extension ${details.reasonPhrase || 'not found on PBX'}` };
      case 486:
        return { title: 'User Busy (486)', message: 'The destination is currently busy on another call.' };
      case 480:
        return { title: 'Temporarily Unavailable (480)', message: 'The destination extension is offline or unavailable.' };
      case 488:
        return { title: 'Not Acceptable (488)', message: 'Incompatible audio codec or media encryption settings.' };
      case 603:
        return { title: 'Call Declined (603)', message: 'The recipient declined the call.' };
      default:
        return { title: `Call Error (${details.statusCode})`, message: details.reasonPhrase || cause || 'Call rejected by PBX' };
    }
  }

  switch (cause) {
    case 'User Denied Media Access':
      return { title: 'Microphone Blocked', message: 'Microphone permission was denied. Please allow microphone access.' };
    case 'Bad Media Description':
      return { title: 'Media Incompatible', message: 'Codec or SDP mismatch between caller and recipient.' };
    case 'RTP Timeout':
      return { title: 'Audio Stream Timeout', message: 'No media packets received from the server.' };
    case 'No Answer':
      return { title: 'No Answer', message: 'The destination did not answer in time.' };
    case 'Busy Here':
      return { title: 'Line Busy', message: 'The destination extension is busy.' };
    case 'Request Timeout':
      return { title: 'Request Timeout', message: 'No response from the PBX server. Check network reachability.' };
    case 'Connection Error':
      return { title: 'Network Error', message: 'SIP WebSocket connection was lost.' };
    default:
      return { title: 'Call Ended', message: cause || 'Call failed' };
  }
}
export default function App() {
  const { colors, isDark } = useTheme();
  useEffect(() => {
    applySystemBars(isDark);
  }, [isDark]);
  useEffect(() => {
    void initI18n();
  }, []);
  const sipRef = useRef<JsSipService | null>(null);
  const incomingRef = useRef<IncomingCallInfo | null>(null);
  const activeCallUUIDRef = useRef<string | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingAnswerUUIDRef = useRef<string | null>(null);
  const pendingEndUUIDRef = useRef<string | null>(null);
  const answerGenerationRef = useRef(0);

  // App State
  const [account, setAccount] = useState<SavedAccount | null>(null);
  const accountRef = useRef<SavedAccount | null>(null);
  const accountGenerationRef = useRef(0);
  const enrollmentAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);
  const saveVolumeTimerRef = useRef<number | null>(null);
  const [isAuthLoaded, setIsAuthLoaded] = useState(false);
  useEffect(() => {
    if (!isAuthLoaded) return;
    if (account) startConnectionService();
    else stopConnectionService();
  }, [account, isAuthLoaded]);
  useEffect(() => {
    const handleAppState = (nextAppState: AppStateStatus) => {
      const currentCall = activeCallRef.current;
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (currentCall) {
          showOngoingCallNotification(
            currentCall.id,
            currentCall.targetName || currentCall.target,
            currentCall.status === 'active'
              ? `Call in progress • Ext ${currentCall.target}`
              : currentCall.status === 'ringing'
              ? `Ringing • Ext ${currentCall.target}`
              : `Dialing • Ext ${currentCall.target}`,
            currentCall.startTime || Date.now()
          );
        }
      } else if (nextAppState === 'active') {
        if (!currentCall) dismissOngoingCallNotification();
        if (accountRef.current) {
          void sipRef.current?.reconnectIfDisconnected();
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, []);
  const [uiState, setUiState] = useState<SipState>('disconnected');
  /** Login-screen status line (gateway approval pending/rejected etc.). */
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [callsHistory, setCallsHistory] = useState<CallRecord[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Telephony State
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [answerRequested, setAnswerRequested] = useState(false);
  const [activeCallUUID, setActiveCallUUID] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [attendedTransferState, setAttendedTransferState] = useState<AttendedTransferState | null>(null);
  const attendedTransferStateRef = useRef<AttendedTransferState | null>(null);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  // Last route explicitly chosen by the user. Kept across the ringing ->
  // established transition, where startCallManagers() resets to earpiece.
  const desiredRouteRef = useRef<AudioRouteType>('EARPIECE');
  const [audioDeviceState, setAudioDeviceState] = useState<AudioDeviceState>({
    availableDevices: ['EARPIECE', 'SPEAKER_PHONE'],
    selectedDevice: 'EARPIECE',
    hasBluetooth: false,
  });

  useEffect(() => {
    setCallWindowActive(Boolean(activeCall || incoming));
  }, [activeCall, incoming]);

  useEffect(() => {
    // Clear an ongoing-call notification left behind by a call that ended
    // while the JS process was suspended. A ringing incoming call must not
    // inherit a stale End Call action from the previous call.
    if (!activeCall ||
        (activeCall.status === 'ringing' && activeCall.direction === 'inbound')) {
      dismissOngoingCallNotification();
    }
  }, [activeCall]);

  useEffect(() => {
    const unsubAudio = subscribeAudioDeviceChanges((s) => {
      setAudioDeviceState(s);
      setIsSpeakerOn(s.selectedDevice === 'SPEAKER_PHONE');
    });
    const unsubNet = subscribeNetworkChanges((netState: NetworkState) => {
      console.log('[app] network state updated:', netState);
      sipRef.current?.handleNetworkChange(netState);
      if (netState.isConnected && accountRef.current) {
        bindExtension(accountRef.current.extension);
      }
    });
    const unsubGsm = subscribeGsmCallState((gsmState: GsmCallState) => {
      console.log('[app] GSM cellular call state updated:', gsmState);
      // Use service.activeCall as authoritative source — it tracks selected line.
      const serviceCall = sipRef.current?.activeCall;
      if (!serviceCall) return;

      if (gsmState === 'RINGING' || gsmState === 'OFFHOOK') {
        // Only auto-hold if the selected line is currently active and not already held.
        // Do not auto-hold during warm transfer actions (service handles its own lines).
        if (serviceCall.status === 'active' && !serviceCall.isHeld) {
          const xferStatus = attendedTransferStateRef.current?.status;
          const inMidTransfer =
            xferStatus === 'swapping' ||
            xferStatus === 'transferring' ||
            xferStatus === 'recovering';
          if (!inMidTransfer) {
            console.log('[app] auto-holding VoIP call due to GSM cellular preemption');
            sipRef.current?.setHold(true);
            updateActiveCall({
              ...serviceCall,
              isHeld: true,
              isGsmInterrupted: true,
            });
          }
        }
      } else if (gsmState === 'IDLE') {
        // Auto-resume only if the service's selected line carries isGsmInterrupted.
        // This avoids resuming the wrong line after a swap.
        if (serviceCall.isGsmInterrupted) {
          console.log('[app] GSM cellular call ended; auto-resuming VoIP call');
          sipRef.current?.setHold(false);
          updateActiveCall({
            ...serviceCall,
            isHeld: false,
            isGsmInterrupted: false,
          });
        }
      }
    });
    return () => {
      unsubAudio();
      unsubNet();
      unsubGsm();
    };
  }, []);

  const updateIncoming = (value: IncomingCallInfo | null) => {
    if (!value) setAnswerRequested(false);
    if (value) {
      const current = sipRef.current?.activeCall;
      if (!current || current.status === 'ringing') dismissOngoingCallNotification();
    }
    const initial = value ? { ...value, callerName: callDisplayName(value.callerId) } : null;
    incomingRef.current = initial;
    setIncoming(initial);
    if (value) {
      const lookupAccount = accountRef.current;
      void resolveCallerName(value.callerId, lookupAccount).then(name => {
        if (incomingRef.current !== initial) return;
        if (accountRef.current !== lookupAccount) return;
        name = callDisplayName(value.callerId, name);
        const resolved = { ...value, callerName: name };
        incomingRef.current = resolved;
        setIncoming(resolved);
        const call = sipRef.current?.activeCall;
        if (call?.id === value.callId) call.targetName = name;
        if (Platform.OS === 'android' && AppState.currentState !== 'active' &&
            pendingAnswerUUIDRef.current !== value.callId && pendingEndUUIDRef.current !== value.callId) {
          showIncomingCallNotification(value.callId, value.callerId, name, value.extension, value.timestamp);
        }
        if (Platform.OS === 'ios' && value.nativePresented) {
          updateIncomingCaller(value.callId, value.callerId, name);
        }
      });
    }
  };

  const updateCallUUID = (value: string | null) => {
    activeCallUUIDRef.current = value;
    setActiveCallUUID(value);
  };

  const updateActiveCall = (value: ActiveCall | null) => {
    activeCallRef.current = value;
    setActiveCall(value);
  };
  const updateAttendedTransferState = (value: AttendedTransferState | null) => {
    attendedTransferStateRef.current = value;
    setAttendedTransferState(value);
  };


  const answerSipCall = async (callId: string): Promise<boolean> => {
    console.log(`[app][callId=${callId}] answer requested`);
    const generation = ++answerGenerationRef.current;
    pendingAnswerUUIDRef.current = callId;
    setAnswerRequested(true);
    stopRingtone();
    recordNativeCallAction(callId, 'ANSWER');
    silenceNativeCallNotification(callId);
    // Push/native UI may precede the SIP leg. If an inbound call is ringing on SIP,
    // answer it even if the push UUID correlation differed.
    const activeCall = sipRef.current?.activeCall;
    const targetCallId = (activeCall && activeCall.status === 'ringing' && activeCall.direction === 'inbound')
      ? activeCall.id
      : callId;
    if (activeCall && activeCall.id !== targetCallId) return false;
    if (!activeCall) return false;
    startCallManagers();
    let answered = false;
    try {
      answered = await sipRef.current?.answer(targetCallId) ?? false;
    } catch (error) {
      if (answerGenerationRef.current !== generation || pendingAnswerUUIDRef.current !== callId) return false;
      console.error(`[app][callId=${targetCallId}] answer action failed:`, error);
      pendingAnswerUUIDRef.current = null;
      setAnswerRequested(false);
      stopCallManagers();
      Alert.alert('Call failed', error instanceof Error ? error.message : 'Unable to answer this call.');
      return false;
    }
    if (!answered) {
      if (answerGenerationRef.current !== generation || pendingAnswerUUIDRef.current !== callId) return false;
      // Retain intent only when waiting for the matching SIP INVITE after a
      // native push answer. A failed attempt on an existing session may retry.
      if (sipRef.current?.activeCall?.id === targetCallId) {
        pendingAnswerUUIDRef.current = null;
        setAnswerRequested(false);
        stopCallManagers();
      }
      return false;
    }
    // Dispatch is not establishment. onCallEstablished owns UI/native cleanup
    // after SIP confirmation (and onCallEnded owns asynchronous failures).
    return true;
  };

  const endSipCall = async (callId: string) => {
    console.log(`[app][callId=${callId}] native end requested`);
    const current = sipRef.current?.activeCall;
    if (current) {
      // Ongoing notifications can carry the pre-answer push id on some
      // notification paths. There is only one live leg; end the live leg.
      if (current.id !== callId) {
        console.warn(`[app][callId=${callId}] end id differs from live call ${current.id}`);
      }
      const ended = await sipRef.current?.hangup(current.id);
      if (!ended) Alert.alert('Call not ended', 'Unable to end the call. Please try again.');
      return;
    }
    ++answerGenerationRef.current;
    updateCallUUID(callId);
    pendingAnswerUUIDRef.current = null;
    pendingEndUUIDRef.current = callId;
    recordNativeCallAction(callId, 'DECLINE');
    updateIncoming(null);
    silenceNativeCallNotification(callId);
    clearNativeCallWindow();
    stopCallManagers();

    const declined = await sipRef.current?.decline(callId);
    if (declined) {
      pendingEndUUIDRef.current = null;
      acknowledgeNativeCallAction(callId, 'DECLINE');
      await clearPendingIncomingCall(callId);
    }
  };
  useEffect(() => {
    if (Platform.OS === 'android') {
      const perms: Permission[] = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ];
      if (Platform.Version >= 31 && PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) {
        perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
      }
      PermissionsAndroid.requestMultiple(perms).then((result) => {
        if (result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] !==
            PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[app] microphone permission denied; calls cannot be answered');
        }
        void requestIgnoreBatteryOptimizations();
      }).catch((error) => {
        console.warn('[app] permission preflight failed:', error);
      });
    }
    const sip = getSharedJsSipService({
      onStateChange: (state) => setUiState(state),
      onIncomingCall: (info) => {
        const callId = info.callId;
        if (pendingEndUUIDRef.current === callId) {
          void sip.decline(callId).then((declined) => {
            if (!declined) return;
            pendingEndUUIDRef.current = null;
            acknowledgeNativeCallAction(callId, 'DECLINE');
            void clearPendingIncomingCall(callId);
            dismissNativeCallNotification(callId);
          });
          return;
        }

        const existing = incomingRef.current?.callId === callId
          ? incomingRef.current
          : null;
        const correlatedInfo: IncomingCallInfo = {
          ...info,
          callerId: info.callerId || existing?.callerId || '',
          callerName: info.callerName || existing?.callerName || 'Incoming Call',
          nativePresented: Platform.OS === 'android' || existing?.nativePresented || false,
        };
        updateCallUUID(callId);
        updateIncoming(correlatedInfo);
        console.log(`[app][callId=${callId}] SIP INVITE matched`);

        if (Platform.OS === 'android' && AppState.currentState !== 'active' &&
            pendingAnswerUUIDRef.current !== callId) {
          showIncomingCallNotification(
            callId,
            correlatedInfo.callerId,
            correlatedInfo.callerName,
            correlatedInfo.extension,
            correlatedInfo.timestamp
          );
        }

        if (Platform.OS === 'ios' && !correlatedInfo.nativePresented) {
          void reportIncomingCall(
            callId,
            correlatedInfo.callerId,
            correlatedInfo.callerName,
          ).then((displayed) => {
            if (displayed && incomingRef.current?.callId === callId) {
              updateIncoming({ ...correlatedInfo, nativePresented: true });
            }
          });
        }

        if (pendingAnswerUUIDRef.current) {
          void answerSipCall(callId);
        }
      },
      onCallEstablished: (call) => {
        ++answerGenerationRef.current;
        updateActiveCall(call);
        updateCallUUID(call.id);
        updateIncoming(null);
        pendingAnswerUUIDRef.current = null;
        acknowledgeNativeCallAction(call.id, 'ANSWER');
        dismissNativeCallNotification(call.id);
        void clearPendingIncomingCall(call.id);
        startCallManagers();
        // Re-apply the user's route choice (speaker/Bluetooth) after the audio
        // session initialisation, which otherwise forces the earpiece.
        if (desiredRouteRef.current !== 'EARPIECE') {
          void chooseAudioRoute(desiredRouteRef.current).then((state) => {
            setAudioDeviceState(state);
            setIsSpeakerOn(state.selectedDevice === 'SPEAKER_PHONE');
          });
        }
        // Keep an End Call action available even when the answer intent
        // brought the app to the foreground. The active-call UI can be behind
        // the lock screen on some OEM builds.
        showOngoingCallNotification(
          call.id,
          call.targetName || call.target,
          `Call in progress • Ext ${call.target}`,
          call.startTime || Date.now()
        );
        const targetSpeakerVol = accountRef.current?.speakerVolume ?? 85;
        void setNativeSpeakerVolume(targetSpeakerVol);
        sipRef.current?.setSpeakerVolume(targetSpeakerVol);
        const targetMicVol = accountRef.current?.micVolume ?? 50;
        sipRef.current?.setMicVolume(targetMicVol);
      },
      onCallStatusChange: (call) => {
        updateActiveCall({ ...call });
        if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
          showOngoingCallNotification(
            call.id,
            call.targetName || call.target,
            call.status === 'active'
              ? `Call in progress • Ext ${call.target}`
              : call.status === 'ringing'
              ? `Ringing • Ext ${call.target}`
              : `Dialing • Ext ${call.target}`,
            call.startTime || Date.now()
          );
        }
      },
      onRegistrationFailed: (code, reason) => {
        if (code === 403) {
          showToast({
            type: 'error',
            title: 'Authentication Failed (403)',
            message: 'Invalid SIP extension or secret password. Please check your credentials.',
          });
        } else if (code === 404) {
          showToast({
            type: 'error',
            title: 'Extension Not Found (404)',
            message: 'This extension is not configured on the PBX server.',
          });
        } else {
          showToast({
            type: 'warning',
            title: 'Registration Failed',
            message: reason ? `Server: ${reason}` : 'Failed to register with PBX',
          });
        }
      },
      onCallEnded: (callId, cause, details) => {
        ++answerGenerationRef.current;
        stopRingtone();
        dismissOngoingCallNotification();
        if (cause && cause !== 'NORMAL_CLEARING' && cause !== 'Canceled by User' && cause !== 'Terminated') {
          const reason = formatCallFailureReason(cause, details);
          showToast({ type: 'error', title: reason.title, message: reason.message });
        }
        const resolvedCallId = callId || activeCallUUIDRef.current;
        const currentCall = activeCallRef.current;
        const currentIncoming = incomingRef.current;
        if (resolvedCallId) {
          reportEnded(resolvedCallId);
          dismissNativeCallNotification(resolvedCallId);
          void clearPendingIncomingCall(resolvedCallId);
        }
        pendingAnswerUUIDRef.current = null;
        pendingEndUUIDRef.current = null;
        updateCallUUID(null);
        updateIncoming(null);
        setIsSpeakerOn(false);
        desiredRouteRef.current = 'EARPIECE';
        stopCallManagers();

        if (currentCall) {
          const duration = currentCall.startTime
            ? Math.floor((Date.now() - currentCall.startTime) / 1000)
            : 0;
          StorageService.addCallRecord({
            number: currentCall.target,
            name: callDisplayName(currentCall.target, currentCall.targetName),
            direction: currentCall.direction,
            timestamp: currentCall.startTime || Date.now(),
            duration,
          }).then(setCallsHistory);
        } else if (currentIncoming) {
          StorageService.addCallRecord({
            number: currentIncoming.callerId,
            name: callDisplayName(currentIncoming.callerId, currentIncoming.callerName),
            direction: 'missed',
            timestamp: currentIncoming.timestamp,
          }).then(setCallsHistory);
        }
        updateActiveCall(null);
        updateAttendedTransferState(null);
        clearNativeCallWindow();
      },
      onCallHoldChange: (isHeld) => {
        if (activeCallRef.current) {
          updateActiveCall({ ...activeCallRef.current, isHeld });
          if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
            const currentCall = activeCallRef.current;
            showOngoingCallNotification(
              currentCall.id,
              currentCall.targetName || currentCall.target,
              isHeld
                ? `Call on hold • Ext ${currentCall.target}`
                : `Call in progress • Ext ${currentCall.target}`,
              currentCall.startTime || Date.now()
            );
          }
        }
      },
      onCallMuteChange: (isMuted) => {
        if (activeCallRef.current) {
          updateActiveCall({ ...activeCallRef.current, isMuted });
        }
        setMicrophoneMute(isMuted);
      },
      onAttendedTransferChange: (state) => {
        updateAttendedTransferState(state);
        // When transfer completes or is cancelled, audio managers follow activeCall lifecycle;
        // no extra action needed here — service fires onCallEnded for final teardown.
      },
      onTransferError: (message) => {
        showToast({ type: 'error', title: 'Transfer Failed', message });
      },
    });
    sipRef.current = sip;
    // Headless push bootstrap can receive INVITE before React mounts. Reattach
    // its existing leg rather than waiting for an event that already happened.
    const existingCall = sip.activeCall;
    if (existingCall?.direction === 'inbound' && existingCall.status === 'ringing') {
      updateCallUUID(existingCall.id);
      updateIncoming({
        type: 'incoming-call', callId: existingCall.id,
        callerId: existingCall.target, callerName: existingCall.targetName,
        extension: '', timestamp: Date.now(), nativePresented: Platform.OS === 'android',
      });
    }

    const restoreGeneration = accountGenerationRef.current;
    StorageService.getAccount().then(async (storedAccount) => {
      if (restoreGeneration !== accountGenerationRef.current) return;
      if (!storedAccount || !storedAccount.serverHost || !storedAccount.password) {
        setIsAuthLoaded(true);
        return;
      }
      const activeAccount: SavedAccount = {
        extension: storedAccount.extension || '',
        password: storedAccount?.password || '',
        serverHost: storedAccount?.serverHost || '',
        useTls: storedAccount?.useTls ?? false,
        dnd: storedAccount?.dnd || false,
        autoAnswer: storedAccount?.autoAnswer || false,
        preferredCodec: storedAccount?.preferredCodec || 'pcmu',
        micVolume: Math.max(0, Math.min(100, storedAccount?.micVolume ?? 50)),
        speakerVolume: storedAccount?.speakerVolume ?? 85,
      };
      // A gateway-enrolled device without an approved assignment must stay on
      // the login screen; it must never fall back to a direct PBX socket.
      try {
        await getOrLoadGatewaySession(
          activeAccount.serverHost,
          activeAccount.extension,
        );
      } catch (recordErr) {
        if (restoreGeneration !== accountGenerationRef.current) return;
        setLoginMessage(describeEnrollmentError(recordErr));
        setIsAuthLoaded(true);
        return;
      }
      if (restoreGeneration !== accountGenerationRef.current) return;
      setLoginMessage(null);
      sip.setPreferredCodec(activeAccount.preferredCodec || 'opus');
      sip.setMicVolume(activeAccount.micVolume ?? 50);
      sip.setSpeakerVolume(activeAccount.speakerVolume ?? 85);
      accountRef.current = activeAccount;
      setAccount(activeAccount);
      setIsAuthLoaded(true);
      void StorageService.saveAccount(activeAccount);
      CONFIG.sipDomain = activeAccount.serverHost;
      CONFIG.sipWss = getSipWss(activeAccount.serverHost, activeAccount.useTls);
      CONFIG.pushGateway = getPushGateway(activeAccount.serverHost);
      bindExtension(activeAccount.extension);
      void sip.connect(
        activeAccount.extension,
        activeAccount.password,
        activeAccount.serverHost,
        activeAccount.useTls,
      );
    }).catch((err) => {
      console.error('[app] account load failed:', err);
      setIsAuthLoaded(true);
    });
    StorageService.getCallHistory().then(setCallsHistory);
    StorageService.getContacts().then(setContacts);

    initPush((payload) => {
      const callId = payload.callId;
      // A late copy of the push must not reopen an established call's overlay.
      if (sip.activeCall?.id === callId && sip.activeCall.status === 'active') return;
      console.log(`[app][callId=${callId}] push wake received`);
      updateCallUUID(callId);
      updateIncoming({
        type: 'incoming-call',
        callerId: payload.callerId,
        callerName: payload.callerName,
        extension: payload.extension,
        timestamp: Number(payload.timestamp),
        sipWss: payload.sipWss,
        callId,
        nativePresented: Platform.OS === 'android',
      });
      setTimeout(() => {
        if (incomingRef.current?.callId === callId && !activeCallRef.current) {
          if (pendingAnswerUUIDRef.current === callId) pendingAnswerUUIDRef.current = null;
          console.log(`[app][callId=${callId}] incoming call overlay timed out`);
          updateIncoming(null);
          updateCallUUID(null);
          dismissNativeCallNotification(callId);
          clearNativeCallWindow();
        }
      }, 45_000);

      void StorageService.getAccount().then((storedAccount) => {
        if (!storedAccount) {
          console.error(`[app][callId=${callId}] cannot bootstrap SIP: no account`);
          return;
        }
        if (accountRef.current?.extension !== storedAccount.extension ||
            accountRef.current?.serverHost !== storedAccount.serverHost) return;
        if (!sip.isConnectedOrConnecting()) {
          void sip.connect(
            storedAccount.extension,
            storedAccount.password,
            storedAccount.serverHost,
            storedAccount.useTls,
          );
        }
      });

      if (Platform.OS === 'ios') {
        void reportIncomingCall(callId, payload.callerId, payload.callerName);
      }
    }, (cancel: CancelPayload) => {
      const cancelCallId = cancel.callId;
      if (incomingRef.current?.callId === cancelCallId) {
        console.log(`[app][callId=${cancelCallId}] cancel-call push dismissed overlay`);
        updateIncoming(null);
        updateCallUUID(null);
        dismissNativeCallNotification(cancelCallId);
        clearNativeCallWindow();
        stopRingtone();
      }
    });

    setupCallKeep({
      onAnswerCall: (callId) => {
        void answerSipCall(callId);
      },
      onEndCall: (callId) => {
        void endSipCall(callId);
      },
    });

    const handleNativeAction = (payload: CallActionPayload) => {
      const callId = payload.callId;
      console.log(`[app][callId=${callId}] native action=${payload.action}`);
      if (payload.action === 'END') {
        if (sip.activeCall?.id === callId) {
          void endSipCall(callId);
        } else {
          // An old ongoing-notification action must not end a different leg
          // or create a pending incoming call.
          acknowledgeNativeCallAction(callId, 'END');
          dismissNativeCallNotification(callId);
        }
        return;
      }
      if (sip.activeCall?.id === callId && sip.activeCall.status === 'active') {
        if (payload.action === 'DECLINE') void endSipCall(callId);
        return;
      }
      updateCallUUID(callId);
      updateIncoming({
        type: 'incoming-call',
        callerId: payload.callerId,
        callerName: payload.callerName,
        extension: payload.extension,
        timestamp: Number(payload.timestamp),
        callId,
        nativePresented: true,
      });
      if (payload.action === 'ANSWER') {
        pendingAnswerUUIDRef.current = callId;
        void answerSipCall(callId);
      } else if (payload.action === 'DECLINE') {
        pendingEndUUIDRef.current = callId;
        void endSipCall(callId);
      } else {
        acknowledgeNativeCallAction(callId, 'SHOW');
      }
      setTimeout(() => {
        if (incomingRef.current?.callId === callId && !activeCallRef.current) {
          if (pendingAnswerUUIDRef.current === callId) pendingAnswerUUIDRef.current = null;
          console.log(`[app][callId=${callId}] native incoming overlay timed out`);
          updateIncoming(null);
          updateCallUUID(null);
          dismissNativeCallNotification(callId);
          clearNativeCallWindow();
        }
      }, 45_000);
    };

    void getPendingNativeCalls().then((calls) => {
      calls.forEach(handleNativeAction);
    });
    const unsubscribeNativeAction = subscribeNativeCallAction(handleNativeAction);
    askNotificationPermission();

    return () => {
      ++accountGenerationRef.current;
      enrollmentAbortRef.current?.abort();
      resetGatewaySession();
      sip.disconnect();
      unsubscribeNativeAction();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Actions ---
  const ensureCallPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    const perms: Permission[] = [
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    ];
    if (Platform.Version >= 31 && PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) {
      perms.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    }

    try {
      const result = await PermissionsAndroid.requestMultiple(perms);
      if (result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
          PermissionsAndroid.RESULTS.GRANTED) {
        return true;
      }
    } catch (error) {
      console.warn('[app] call permission request failed:', error);
    }

    Alert.alert(
      'Microphone Permission Needed',
      'Sokrat VOICE needs microphone access to place calls. Enable it in Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
      ],
    );
    return false;
  };

  const handleOutboundCall = async (target: string) => {
    const destination = target.trim();
    if (!destination) return;

    const permissionsGranted = await ensureCallPermissions();
    if (!permissionsGranted) return;

    console.log('[app] handleOutboundCall requested target=' + destination);

    try {
      if ((uiState !== 'registered' || !sipRef.current?.isRegistered()) && account) {
        console.log('[app] reconnecting SIP before outbound call...');
        await sipRef.current?.connect(
          account.extension,
          account.password,
          account.serverHost,
          account.useTls
        );
        let waitAttempts = 0;
        while (!sipRef.current?.isRegistered() && waitAttempts < 15) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
          waitAttempts++;
        }
      }

      if (!sipRef.current?.isRegistered()) {
        Alert.alert(
          'Not Connected',
          'Extension is currently connecting. Please ensure the PBX server is reachable and status shows Connected.',
          [{ text: 'OK' }]
        );
        return;
      }

      startCallManagers();
      await sipRef.current?.call(destination);
      if (sipRef.current?.activeCall) {
        updateActiveCall({ ...sipRef.current.activeCall });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[app] outbound call failed:', errMsg);
      stopCallManagers();
      showToast({
        type: 'error',
        title: 'Cannot Place Call',
        message: errMsg,
      });
    }
  };

  const handleAnswer = async () => {
    const activeSipCall = sipRef.current?.activeCall;
    const callId =
      (activeSipCall && activeSipCall.status === 'ringing' && activeSipCall.direction === 'inbound')
        ? activeSipCall.id
        : (incomingRef.current?.callId || activeCallUUIDRef.current || '');
    if (!callId) {
      console.warn('[app] handleAnswer called but no callId found');
      return;
    }
    answerIncoming(callId);
    const hadMatchingSession = sipRef.current?.activeCall?.id === callId;
    const answered = await answerSipCall(callId);
    if (!answered && hadMatchingSession && sipRef.current?.activeCall?.id === callId) {
      Alert.alert('Call failed', 'Microphone access failed or the call is no longer available.');
    }
  };

  const handleHangup = async () => {
    const current = sipRef.current?.activeCall;
    const callId = current?.id || activeCallUUIDRef.current;
    console.log(`[app][callId=${callId || 'none'}] UI hangup requested`);
    if (!current && callId) {
      await endSipCall(callId);
      reportEnded(callId);
      return;
    }
    if (current && !(await sipRef.current?.hangup(current.id))) {
      Alert.alert('Call not ended', 'Unable to end the call. Please try again.');
      return;
    }
    dismissOngoingCallNotification();
    if (callId) {
      reportEnded(callId);
      dismissNativeCallNotification(callId);
      await clearPendingIncomingCall(callId);
    }
    stopCallManagers();
    updateIncoming(null);
    updateActiveCall(null);
    updateCallUUID(null);
    clearNativeCallWindow();
  };

  const handleStartWarmTransfer = async (target: string): Promise<void> => {
    try {
      await sipRef.current?.startAttendedTransfer(target);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ type: 'error', title: 'Transfer Failed', message: msg });
    }
  };

  const handleCompleteTransfer = async (): Promise<void> => {
    try {
      await sipRef.current?.completeAttendedTransfer();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ type: 'error', title: 'Transfer Failed', message: msg });
    }
  };

  const handleCancelTransfer = async (): Promise<void> => {
    try {
      await sipRef.current?.cancelAttendedTransfer();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ type: 'error', title: 'Transfer Failed', message: msg });
    }
  };

  const handleSwapLines = async (): Promise<void> => {
    try {
      await sipRef.current?.swapAttendedLines();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ type: 'error', title: 'Swap Failed', message: msg });
    }
  };

  const handleSaveAccount = async (newAcc: SavedAccount) => {
    const previous = accountRef.current;
    const identityChanged = !previous || previous.extension !== newAcc.extension ||
      previous.serverHost !== newAcc.serverHost || previous.password !== newAcc.password;
    const generation = ++accountGenerationRef.current;
    enrollmentAbortRef.current?.abort();
    const controller = new AbortController();
    enrollmentAbortRef.current = controller;
    if (identityChanged) {
      accountRef.current = null;
      sipRef.current?.disconnect();
      // Stop old token retries before the configured host/extension changes.
      const removal = unregisterCurrentDevice();
      resetGatewaySession();
      setAccount(null);
      await removal;
      if (generation !== accountGenerationRef.current) return;
      const prepared = await prepareLogin({
        host: newAcc.serverHost, extension: newAcc.extension, password: newAcc.password,
        signal: controller.signal,
        onProgress: progress => {
          if (generation === accountGenerationRef.current && progress.message) setLoginMessage(progress.message);
        },
      });
      if (generation !== accountGenerationRef.current) return;
      newAcc = { ...newAcc, extension: prepared.extension };
    }
    await StorageService.saveAccount(newAcc);
    if (generation !== accountGenerationRef.current) return;
    accountRef.current = newAcc;
    setAccount(newAcc);
    setLoginMessage(null);
    sipRef.current?.setPreferredCodec(newAcc.preferredCodec || 'opus');
    sipRef.current?.setMicVolume(newAcc.micVolume ?? 50);
    sipRef.current?.setSpeakerVolume(newAcc.speakerVolume ?? 85);
    CONFIG.sipDomain = newAcc.serverHost;
    CONFIG.sipWss = getSipWss(newAcc.serverHost, newAcc.useTls);
    CONFIG.pushGateway = getPushGateway(newAcc.serverHost);
    bindExtension(newAcc.extension);
    sipRef.current?.connect(newAcc.extension, newAcc.password, newAcc.serverHost, newAcc.useTls);
  };

  const handleLogout = async () => {
    ++accountGenerationRef.current;
    enrollmentAbortRef.current?.abort();
    accountRef.current = null;
    const removal = unregisterCurrentDevice();
    sipRef.current?.disconnect();
    resetGatewaySession();
    setAccount(null);
    setLoginMessage(null);
    updateActiveCall(null);
    updateIncoming(null);
    updateCallUUID(null);
    await clearPendingIncomingCall();
    await StorageService.clearAccount();
    await removal;
    resetGatewaySession();
  };

  // Contacts
  const handleSaveContact = async (contact: Contact) => {
    const updated = [contact, ...contacts.filter((c) => c.id !== contact.id)];
    setContacts(updated);
    await StorageService.saveContacts(updated);
  };
  const handleSaveContactsBatch = async (newContacts: Contact[]) => {
    const existingMap = new Map(contacts.map((c) => [c.extension, c]));
    newContacts.forEach((c) => {
      if (!existingMap.has(c.extension)) {
        existingMap.set(c.extension, c);
      }
    });
    const updated = Array.from(existingMap.values());
    setContacts(updated);
    await StorageService.saveContacts(updated);
  };


  const handleDeleteContact = async (id: string) => {
    const updated = contacts.filter((c) => c.id !== id);
    setContacts(updated);
    await StorageService.saveContacts(updated);
  };

  const handleToggleFavorite = async (id: string) => {
    const updated = contacts.map((c) => (c.id === id ? { ...c, favorite: !c.favorite } : c));
    setContacts(updated);
    await StorageService.saveContacts(updated);
  };

  const handleClearHistory = async () => {
    setCallsHistory([]);
    await StorageService.clearCallHistory();
  };
  const handleDeleteCallRecord = async (id: string) => {
    const updated = await StorageService.deleteCallRecord(id);
    setCallsHistory(updated);
  };

  // 1. Storage Authentication Initializing (prevents flash of login screen)
  if (!isAuthLoaded) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={[styles.root, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
        <ToastContainer />
      </SafeAreaProvider>
    );
  }

  // 2. Incoming Call Overlay (Ringing Screen takes precedence over login)
  if (incoming) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={[styles.root, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
        <ToastContainer />
        <RingingScreen
          callerId={incoming.callerId}
          callerName={incoming.callerName}
          answerRequested={answerRequested}
          onAnswer={handleAnswer}
          onDecline={handleHangup}
        />
      </SafeAreaProvider>
    );
  }

  // 3. Not Logged In -> Show Full Dedicated Login Screen
  if (!account) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={[styles.root, { backgroundColor: colors.bg }]}>
        <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
        <ToastContainer />
        <LoginScreen
          onLogin={async (ext, password, serverHost) => {
            setLoginMessage(null);
            setUiState('connecting');
            try {
              // Gateway deployments enroll/await approval before any SIP work;
              // non-gateway hosts resolve to the existing direct-PBX login.
              const newAcc: SavedAccount = {
                extension: ext,
                password,
                serverHost: serverHost || '',
                useTls: false,
                dnd: false,
                autoAnswer: false,
              };
              await handleSaveAccount(newAcc);
              setLoginMessage(null);
            } catch (err) {
              console.error('[app] login failed:', err);
              setUiState('failed');
              setLoginMessage(describeEnrollmentError(err));
            }
          }}
          state={uiState}
          message={loginMessage}
        />
      </SafeAreaProvider>
    );
  }
  // Standard Phone Application View
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <ToastContainer />
      <StandardPhoneScreen
        account={account}
        state={uiState}
        callsHistory={callsHistory}
        contacts={contacts}
        activeCall={activeCall}
        isSpeakerOn={isSpeakerOn}
        onCall={handleOutboundCall}
        onHangup={handleHangup}
        onToggleMute={() => {
          const nextMuted = sipRef.current?.toggleMute() ?? false;
          if (activeCallRef.current) {
            updateActiveCall({ ...activeCallRef.current, isMuted: nextMuted });
          }
          setMicrophoneMute(nextMuted);
        }}
        onToggleHold={() => {
          const nextHeld = sipRef.current?.toggleHold() ?? false;
          if (activeCallRef.current) {
            updateActiveCall({ ...activeCallRef.current, isHeld: nextHeld });
          }
        }}
        onToggleSpeaker={async () => {
          let nextRoute: AudioRouteType;
          if (audioDeviceState.hasBluetooth) {
            if (audioDeviceState.selectedDevice === 'BLUETOOTH') {
              nextRoute = 'SPEAKER_PHONE';
            } else if (audioDeviceState.selectedDevice === 'SPEAKER_PHONE') {
              nextRoute = 'EARPIECE';
            } else {
              nextRoute = 'BLUETOOTH';
            }
          } else {
            nextRoute = audioDeviceState.selectedDevice === 'SPEAKER_PHONE' ? 'EARPIECE' : 'SPEAKER_PHONE';
          }
          desiredRouteRef.current = nextRoute;
          setAudioDeviceState({ ...audioDeviceState, selectedDevice: nextRoute });
          setIsSpeakerOn(nextRoute === 'SPEAKER_PHONE');
          const newState = await chooseAudioRoute(nextRoute);
          setAudioDeviceState(newState);
          setIsSpeakerOn(newState.selectedDevice === 'SPEAKER_PHONE');
          const targetSpeakerVol = accountRef.current?.speakerVolume ?? 85;
          setTimeout(() => {
            void setNativeSpeakerVolume(targetSpeakerVol);
          }, 200);
        }}
        audioDeviceState={audioDeviceState}
        onChooseAudioRoute={async (route: AudioRouteType) => {
          // Changing the communication device outside a call would push the
          // audio stack into MODE_IN_COMMUNICATION and steal media audio.
          if (!activeCallRef.current) {
            return getAudioDeviceState();
          }
          desiredRouteRef.current = route;
          setAudioDeviceState({ ...audioDeviceState, selectedDevice: route });
          setIsSpeakerOn(route === 'SPEAKER_PHONE');
          const newState = await chooseAudioRoute(route);
          setAudioDeviceState(newState);
          setIsSpeakerOn(route === 'SPEAKER_PHONE');
          return newState;
        }}
        onSendDtmf={(d: string) => sipRef.current?.sendDTMF(d)}
        onBlindTransfer={(t: string) => {
          showToast({ type: 'info', title: 'Transferring…', message: `Transferring to ${t}` });
          sipRef.current?.blindTransfer(t);
        }}
        attendedTransferState={attendedTransferState}
        onStartWarmTransfer={handleStartWarmTransfer}
        onCompleteTransfer={handleCompleteTransfer}
        onCancelTransfer={handleCancelTransfer}
        onSwapLines={handleSwapLines}
        onSaveAccount={handleSaveAccount}
        onLogout={handleLogout}
        onClearHistory={handleClearHistory}
        onDeleteCallRecord={handleDeleteCallRecord}
        onSaveContact={handleSaveContact}
        onDeleteContact={handleDeleteContact}
        onSaveContactsBatch={handleSaveContactsBatch}
        onToggleFavorite={handleToggleFavorite}
        onUpdateVolume={async (type, val) => {
          if (type === 'mic') {
            sipRef.current?.setMicVolume(val);
            if (accountRef.current) {
              accountRef.current = {
                ...accountRef.current,
                micVolume: val,
              };
              clearTimeout(saveVolumeTimerRef.current ?? undefined);
              saveVolumeTimerRef.current = setTimeout(() => {
                if (accountRef.current) {
                  setAccount(accountRef.current);
                  void StorageService.saveAccount(accountRef.current);
                }
              }, 400) as unknown as number;
            }
            return null;
          } else {
            sipRef.current?.setSpeakerVolume(val);
            const res = await setNativeSpeakerVolume(Math.min(100, val));
            if (accountRef.current) {
              accountRef.current = {
                ...accountRef.current,
                // Native returns the quantized hardware step (max 100). Keep
                // the user's requested software boost above that ceiling.
                speakerVolume: val > 100 ? val : res ? res.percent : val,
              };
              clearTimeout(saveVolumeTimerRef.current ?? undefined);
              saveVolumeTimerRef.current = setTimeout(() => {
                if (accountRef.current) {
                  setAccount(accountRef.current);
                  void StorageService.saveAccount(accountRef.current);
                }
              }, 400) as unknown as number;
            }
            return res;
          }
        }}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
