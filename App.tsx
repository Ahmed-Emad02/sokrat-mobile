/**
 * Sokrat VOICE Mobile Softphone App
 * Standard Phone Dialer UI with JsSIP WebRTC Engine & FCM Push-to-Wake.
 */
import React, { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, Platform, PermissionsAndroid, Alert, AppState, AppStateStatus, Permission, Linking, View, Text, TouchableOpacity } from 'react-native';
import { useTheme, applySystemBars } from './src/theme';
import { initI18n } from './src/i18n';
import { resolveCallerName } from './src/calls/callerNameResolver';
import { callDisplayName, providerCallerName } from './src/calls/callerName';
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
  bindChatPushHandler,
  normalizeChatPayload,
  repairPushRegistration,
  getPushDiagnostics,
} from './src/push/pushHandler';
import type { CancelPayload } from './src/push/pushHandler';
import { ChatClient } from './src/chat/client';
import { ChatCache } from './src/chat/cache';
import { ChatSocket } from './src/chat/socket';
import type { ChatConversation, UnreadSummary } from './src/chat/types';
import { CONFIG, getSipWss, getPushGateway, hydrateAppVersion } from './src/config';
import { startConnectionService, stopConnectionService } from './src/calls/connectionService';
import { prepareLogin } from './src/gateway/enrollment';
import { describeEnrollmentError, isTerminalEnrollmentError } from './src/gateway/errors';
import { getOrLoadGatewaySession, resetGatewaySession, getPersistedGatewayRecord, sendGatewayTelemetry } from './src/gateway/session';
import { gatewayAuthHeaders } from './src/gateway/urls';
import { getDeviceUuid } from './src/storage/deviceId';
import {
  setupCallKeep,
  reportIncomingCall,
  updateIncomingCaller,
  reportEnded,
  answerIncoming,
} from './src/calls/callKit';
import {
  showIncomingCallNotification,
  updateNativeIncomingCallNotification,
  acknowledgeNativeCallAction,
  clearNativeCallWindow,
  dismissNativeCallNotification,
  showOngoingCallNotification,
  showMissedCallNotification,
  dismissOngoingCallNotification,
  canUseFullScreenIntent,
  openFullScreenIntentSettings,
  requestIgnoreBatteryOptimizations,
  isIgnoringBatteryOptimizations,
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
import { getNetworkState, subscribeNetworkChanges, NetworkState } from './src/calls/network';
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
const MISSED_SYNC_KEY = '@sokrat/missed-call-sync';
let missedSyncInFlight = false;

/**
 * Reconcile calls that ended while this device had no SIP registration. The
 * gateway reads Asterisk CDR, so no PBX credentials live on the phone.
 */
async function reconcileMissedCalls(
  account: SavedAccount,
  applyHistory: (records: CallRecord[]) => void,
): Promise<void> {
  if (missedSyncInFlight) return;
  missedSyncInFlight = true;
  try {
    const storedSince = await AsyncStorage.getItem(MISSED_SYNC_KEY).catch(() => null);
    const parsedSince = storedSince ? new Date(storedSince) : null;
    const since = parsedSince && !Number.isNaN(parsedSince.getTime()) ? parsedSince : new Date();
    let url: string;
    let headers: Record<string, string> = {};
    const gateway = await getOrLoadGatewaySession(account.serverHost, account.extension).catch(() => null);
    if (gateway) {
      url = `${gateway.apiURL}/api/gateway/missed-calls` +
        `?since=${encodeURIComponent(since.toISOString())}`;
      headers = gatewayAuthHeaders({ claimSecret: gateway.claimSecret, deviceId: gateway.deviceId });
    } else {
      const deviceUuid = await getDeviceUuid().catch(() => '');
      if (!deviceUuid) return;
      url = `${getPushGateway(account.serverHost)}/api/push/missed-calls` +
        `?extension=${encodeURIComponent(account.extension)}` +
        `&deviceUuid=${encodeURIComponent(deviceUuid)}` +
        `&since=${encodeURIComponent(since.toISOString())}`;
    }
    const response = await fetch(url, { headers }).catch(() => null);
    if (!response?.ok) return;
    const json = await response.json() as {
      missedCalls?: Array<{
        callId?: string; callerId?: string; callerName?: string;
        timestamp?: number; disposition?: string;
      }>;
    };
    const missed = Array.isArray(json.missedCalls) ? json.missedCalls : [];
    if (!missed.length) {
      await AsyncStorage.setItem(MISSED_SYNC_KEY, new Date().toISOString()).catch(() => {});
      return;
    }
    const existing = await StorageService.getCallHistory();
    const known = new Set(existing.map((item) => item.callId).filter(Boolean));
    for (const item of missed) {
      if (!item.callId || known.has(item.callId)) continue;
      const timestamp = Number(item.timestamp) || Date.now();
      const callerId = String(item.callerId || 'Unknown');
      const callerName = String(item.callerName || callerId);
      // The live SIP path already records missed calls while the app is
      // online. Match those by caller and nearby start time because the local
      // call id and the PBX CDR uniqueid are different namespaces.
      const liveDuplicate = existing.some((record) =>
        record.direction === 'missed' &&
        record.number === callerId &&
        Math.abs((record.timestamp || 0) - timestamp) < 120_000);
      if (liveDuplicate) continue;
      await StorageService.addCallRecord({
        callId: item.callId,
        number: callerId,
        name: callDisplayName(callerId, callerName),
        direction: 'missed',
        timestamp,
      });
      showMissedCallNotification(callerId, callerName, account.extension, timestamp);
      showToast({
        type: 'info',
        title: 'Missed call',
        message: `${callDisplayName(callerId, callerName)} · Ext ${account.extension}`,
        duration: 3500,
      });
    }
    applyHistory(await StorageService.getCallHistory());
    await AsyncStorage.setItem(MISSED_SYNC_KEY, new Date().toISOString()).catch(() => {});
  } catch (error) {
    console.warn('[app] missed-call reconciliation failed:', error);
  } finally {
    missedSyncInFlight = false;
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
  const pendingNameResolutionRef = useRef<IncomingCallInfo | null>(null);
  const activeCallUUIDRef = useRef<string | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingAnswerUUIDRef = useRef<string | null>(null);
  const pendingEndUUIDRef = useRef<string | null>(null);
  const answerGenerationRef = useRef(0);
  const answerWatchdogRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    uiCallId: string;
    sessionCallId: string;
  } | null>(null);
  const terminalCallIdsRef = useRef<Set<string>>(new Set());
  const terminalCallTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // App State
  const [account, setAccount] = useState<SavedAccount | null>(null);
  const [lastAccount, setLastAccount] = useState<SavedAccount | null>(null);
  const accountRef = useRef<SavedAccount | null>(null);
  const accountGenerationRef = useRef(0);
  const enrollmentAbortRef = useRef<AbortController | null>(null);
  const [gatewayState, setGatewayState] = useState<'restoring' | 'online' | 'offline' | 'blocked'>('restoring');
  const gatewayStateRef = useRef(gatewayState);
  const fullScreenPromptedRef = useRef(false);
  const [missingCallPermissions, setMissingCallPermissions] = useState<{ fullScreen: boolean; battery: boolean } | null>(null);
  const [callPermissionBannerDismissed, setCallPermissionBannerDismissed] = useState(false);
  const [gatewayMessage, setGatewayMessage] = useState('');
  const gatewayRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gatewayRetryAttemptRef = useRef(0);
  const retryGatewayRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);
  useEffect(() => {
    gatewayStateRef.current = gatewayState;
  }, [gatewayState]);
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
          if (!chatSocketRef.current?.connected) chatSocketRef.current?.reconnectNow();
          if (gatewayStateRef.current === 'offline') retryGatewayRef.current?.();
          void reconcileMissedCalls(accountRef.current, setCallsHistory);
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

  // Chat state
  const chatClientRef = useRef<ChatClient | null>(null);
  const chatCacheRef = useRef<ChatCache | null>(null);
  const chatSocketRef = useRef<ChatSocket | null>(null);
  const [chatConversations, setChatConversations] = useState<ChatConversation[]>([]);
  const [chatUnread, setChatUnread] = useState<UnreadSummary>({ total: 0, per_conversation: {} });
  const lastChatToastRef = useRef('');

  // Initialize chat when account becomes available; tear down on logout.
  useEffect(() => {
    if (!account) {
      chatSocketRef.current?.dispose();
      chatSocketRef.current = null;
      chatClientRef.current = null;
      chatCacheRef.current = null;
      bindChatPushHandler(null);
      setChatConversations([]);
      setChatUnread({ total: 0, per_conversation: {} });
      return;
    }

    const gatewayBase = getPushGateway(account.serverHost);
    void (async () => {
      let base = gatewayBase;
      try {
        const s = await getOrLoadGatewaySession(account.serverHost, account.extension);
        if (s) base = s.apiURL;
      } catch {
        // fallback to push gateway base
      }

      const rec = await getPersistedGatewayRecord(account.serverHost, account.extension).catch(() => null);
      const claimSecret = rec?.claimSecret ?? '';
      const deviceId = rec?.deviceId ?? '';
      const deviceUuid = await getDeviceUuid().catch(() => '');

      const client = new ChatClient({
        gatewayBase: base,
        claimSecret,
        deviceId: deviceId || deviceUuid,
        extension: account.extension,
        sipPassword: account.password,
      });
      const cache = new ChatCache(account.extension, account.serverHost);
      chatClientRef.current = client;
      chatCacheRef.current = cache;

      // Seed from cache first so the UI is instant
      const cached = await cache.getConversations();
      if (cached.length) setChatConversations(cached);
      setChatUnread(await cache.getUnread());

      // Fetch fresh data
      try {
        const fresh = await client.getConversations();
        setChatConversations(fresh);
        await cache.saveConversations(fresh);
      } catch {}
      try {
        const unread = await client.getUnread();
        setChatUnread(unread);
        await cache.saveUnread(unread);
      } catch {}

      // Open socket
      const socket = new ChatSocket(base, client, {
        onMessage: async (msg) => {
          if (msg.sender_extension !== account.extension && msg.id !== lastChatToastRef.current) {
            lastChatToastRef.current = msg.id;
            showToast({ type: 'info', title: `Chat · ${msg.sender_extension}`, message: msg.body || 'New message', duration: 2500 });
          }
          await cache.upsertMessage(msg.conversation_id, msg);
          setChatUnread({ ...await cache.incrementUnread(msg.conversation_id) });
          try {
            const convs = await client.getConversations();
            setChatConversations(convs);
            await cache.saveConversations(convs);
          } catch {}
        },
        onConversationUpdated: async (conv) => {
          await cache.upsertConversation(conv);
          setChatConversations(await cache.getConversations());
        },
        onTyping: () => {},
        onConnected: () => {},
        onDisconnected: () => {},
      });
      chatSocketRef.current = socket;
      void socket.connect();

      // Wire FCM chat push
      bindChatPushHandler(async (payload) => {
        if (payload.messageId !== lastChatToastRef.current) {
          lastChatToastRef.current = payload.messageId;
          showToast({ type: 'info', title: `Chat · ${payload.senderExtension}`, message: payload.preview || 'New message', duration: 2500 });
        }
        setChatUnread({ ...await cache.incrementUnread(payload.conversationId) });
        try {
          const convs = await client.getConversations();
          setChatConversations(convs);
          await cache.saveConversations(convs);
        } catch {}
      });
    })();

    return () => {
      chatSocketRef.current?.dispose();
      chatSocketRef.current = null;
      bindChatPushHandler(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.extension, account?.serverHost, account?.password]);

  const handleChatRefresh = async () => {
    const client = chatClientRef.current;
    const cache = chatCacheRef.current;
    if (!client || !cache) return;
    const [convs, unread] = await Promise.all([client.getConversations(), client.getUnread()]);
    setChatConversations(convs);
    setChatUnread(unread);
    await Promise.all([cache.saveConversations(convs), cache.saveUnread(unread)]);
  };

  // Telephony State
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [answerRequested, setAnswerRequested] = useState(false);
  const [activeCallUUID, setActiveCallUUID] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);

  useEffect(() => {
    void hydrateAppVersion();
  }, []);

  // Diagnostic heartbeat: authenticated, token-free state for the gateway
  // dashboard. It reports transport/SIP/push health, never secrets or tokens.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const report = async () => {
      try {
        const net = await getNetworkState();
        if (cancelled) return;
        const push = getPushDiagnostics();
        await sendGatewayTelemetry(account.serverHost, account.extension, {
          appVersion: CONFIG.appVersion,
          sipState: uiState,
          gatewayState,
          appState: AppState.currentState || 'unknown',
          networkConnected: String(net.isConnected),
          networkType: net.networkType,
          activeCall: activeCall ? `${activeCall.status}:${activeCall.direction}` : 'none',
          fcmTokenPresent: String(push.fcmTokenPresent),
          fcmLastTokenAt: String(push.lastFcmTokenAt),
          fcmLastError: push.lastFcmError.slice(0, 160),
          pushRegisteredAt: String(push.lastPushRegisteredAt),
          pushLastError: push.lastPushRegisterError.slice(0, 160),
          reportedAt: new Date().toISOString(),
        });
      } catch {
        // Diagnostics must never affect call signaling.
      }
    };
    void report();
    const timer = setInterval(() => { void report(); }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [account?.serverHost, account?.extension, activeCall?.id, activeCall?.status, gatewayState, uiState]);
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
        chatSocketRef.current?.reconnectNow();
        if (gatewayStateRef.current === 'offline') retryGatewayRef.current?.();
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

  const updateCallUUID = (value: string | null) => {
    activeCallUUIDRef.current = value;
    setActiveCallUUID(value);
  };

  const updateActiveCall = (value: ActiveCall | null) => {
    activeCallRef.current = value;
    setActiveCall(value);
  };

  const applyResolvedIncomingName = (callId: string, callerId: string, name: string) => {
    const displayName = callDisplayName(callerId, name);
    if (displayName === callDisplayName(callerId)) return;

    const current = incomingRef.current;
    if (current?.callId === callId && current.callerName !== displayName) {
      const resolved = { ...current, callerName: displayName };
      incomingRef.current = resolved;
      setIncoming(resolved);
    }

    const call = sipRef.current?.activeCall;
    if (call?.id === callId) {
      call.targetName = displayName;
      updateActiveCall({ ...call });
    }

    if (Platform.OS === 'android') {
      updateNativeIncomingCallNotification(callId, displayName);
    }
    if (Platform.OS === 'ios' && (current?.callId === callId || call?.id === callId)) {
      updateIncomingCaller(callId, callerId, displayName);
    }
    void StorageService.updateCallRecordName(callId, displayName).then((updated) => {
      if (updated.length) setCallsHistory(updated);
    });
  };

  const enrichIncomingName = (value: IncomingCallInfo, lookupAccount: SavedAccount | null) => {
    void resolveCallerName(value.callerId, lookupAccount).then(name => {
      if (name === 'Unknown') return;
      if (lookupAccount && accountRef.current &&
          lookupAccount.extension !== accountRef.current.extension) return;
      applyResolvedIncomingName(value.callId, value.callerId, name);
    });
  };

  const updateIncoming = (value: IncomingCallInfo | null) => {
    if (value && isTerminalCall(value.callId)) {
      console.warn(`[app][callId=${value.callId}] incoming update ignored: call is terminal`);
      return;
    }
    if (!value) setAnswerRequested(false);
    if (value) {
      const current = sipRef.current?.activeCall;
      if (!current || current.status === 'ringing') dismissOngoingCallNotification();
    }
    const existing = value && incomingRef.current?.callId === value.callId
      ? incomingRef.current
      : null;
    const initial = value
      ? {
          ...value,
          callerName: providerCallerName(value.callerId, value.callerName, existing?.callerName),
        }
      : null;
    incomingRef.current = initial;
    setIncoming(initial);
    console.log(`[app][callId=${value?.callId || 'none'}] incoming state ${initial ? 'set' : 'cleared'}`);
    if (value) {
      const lookupAccount = accountRef.current;
      if (lookupAccount) {
        pendingNameResolutionRef.current = null;
        enrichIncomingName(value, lookupAccount);
      } else {
        pendingNameResolutionRef.current = value;
      }
    } else {
      pendingNameResolutionRef.current = null;
    }
  };

  useEffect(() => {
    const pending = pendingNameResolutionRef.current;
    if (!account || !pending) return;
    if (pending.callId !== incomingRef.current?.callId &&
        pending.callId !== sipRef.current?.activeCall?.id) {
      pendingNameResolutionRef.current = null;
      return;
    }
    pendingNameResolutionRef.current = null;
    enrichIncomingName(pending, account);
  }, [account]);

  const updateAttendedTransferState = (value: AttendedTransferState | null) => {
    attendedTransferStateRef.current = value;
    setAttendedTransferState(value);
  };


  const markCallTerminal = (callId: string | null | undefined) => {
    const id = String(callId || '').trim();
    if (!id) return;
    terminalCallIdsRef.current.add(id);
    const previous = terminalCallTimersRef.current.get(id);
    if (previous) clearTimeout(previous);
    terminalCallTimersRef.current.set(id, setTimeout(() => {
      terminalCallIdsRef.current.delete(id);
      terminalCallTimersRef.current.delete(id);
    }, 90_000));
  };

  const isTerminalCall = (callId: string | null | undefined): boolean =>
    !!callId && terminalCallIdsRef.current.has(String(callId));

  const clearAnswerWatchdog = () => {
    if (answerWatchdogRef.current) {
      clearTimeout(answerWatchdogRef.current.timer);
      answerWatchdogRef.current = null;
    }
  };

  const startAnswerWatchdog = (
    uiCallId: string,
    sessionCallId: string,
    generation: number,
  ) => {
    clearAnswerWatchdog();
    const timer = setTimeout(() => {
      answerWatchdogRef.current = null;
      if (generation !== answerGenerationRef.current) return;
      const active = sipRef.current?.activeCall;
      if (active?.id === sessionCallId && active.status === 'active') return;
      ++answerGenerationRef.current;
      pendingAnswerUUIDRef.current = null;
      setAnswerRequested(false);
      if (incomingRef.current?.callId === uiCallId) updateIncoming(null);
      dismissNativeCallNotification(uiCallId);
      clearNativeCallWindow();
      stopRingtone();
      stopCallManagers();
      if (active?.id === sessionCallId) {
        void sipRef.current?.hangup(sessionCallId).catch(() => {});
      }
      showToast({
        type: 'error',
        title: 'Call not connected',
        message: 'The call could not be established. Please try again.',
      });
      console.warn(`[app][callId=${uiCallId}] answer timed out without SIP confirmation`);
    }, 20_000);
    answerWatchdogRef.current = { timer, uiCallId, sessionCallId };
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
    if (activeCall && activeCall.id !== targetCallId) {
      pendingAnswerUUIDRef.current = null;
      setAnswerRequested(false);
      return false;
    }
    if (!activeCall) {
      // Native/push answer can precede the SIP INVITE. Keep the intent alive
      // briefly, but never leave the UI in an indefinite connecting state.
      startAnswerWatchdog(callId, callId, generation);
      return false;
    }
    startAnswerWatchdog(callId, targetCallId, generation);
    startCallManagers();
    let answered = false;
    try {
      answered = await sipRef.current?.answer(targetCallId) ?? false;
    } catch (error) {
      if (answerGenerationRef.current !== generation || pendingAnswerUUIDRef.current !== callId) return false;
      console.error(`[app][callId=${targetCallId}] answer action failed:`, error);
      clearAnswerWatchdog();
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
        clearAnswerWatchdog();
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
    clearAnswerWatchdog();
    markCallTerminal(callId);
    console.log(`[app][callId=${callId}] native end requested`);
    const current = sipRef.current?.activeCall;
    if (current) {
      if (current.id !== callId) {
        // Never let a stale push/native id terminate the live leg. A second
        // call is rejected at the SIP layer; this action belongs to that
        // rejected call, not to the active one.
        console.warn(`[app][callId=${callId}] end id differs from live call ${current.id}; ignoring`);
        markCallTerminal(callId);
        if (incomingRef.current?.callId === callId) updateIncoming(null);
        dismissNativeCallNotification(callId);
        void clearPendingIncomingCall(callId);
        return;
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
  const clearGatewayRetry = () => {
    if (gatewayRetryTimerRef.current) {
      clearTimeout(gatewayRetryTimerRef.current);
      gatewayRetryTimerRef.current = null;
    }
  };

  const scheduleGatewayRetry = (activeAccount: SavedAccount, generation: number) => {
    clearGatewayRetry();
    const delay = Math.min(5_000 * (2 ** gatewayRetryAttemptRef.current), 60_000);
    gatewayRetryAttemptRef.current += 1;
    gatewayRetryTimerRef.current = setTimeout(() => {
      gatewayRetryTimerRef.current = null;
      void attemptGatewayRestore(activeAccount, generation);
    }, delay);
  };

  /**
   * Validate/revalidate the stored account without ever treating a network
   * failure as a sign-out. The account remains mounted; only an explicit
   * handleLogout may clear it.
   */
  const attemptGatewayRestore = async (activeAccount: SavedAccount, generation: number) => {
    if (generation !== accountGenerationRef.current) return;
    clearGatewayRetry();
    setGatewayState('restoring');
    setGatewayMessage('Connecting to gateway…');
    try {
      // Re-run the login preparation so a local fallback can create its own
      // enrollment record when the cloud is unreachable. getOrLoad alone has
      // no SIP password and therefore cannot auto-enroll a new local gateway.
      const prepared = await prepareLogin({
        host: activeAccount.serverHost,
        extension: activeAccount.extension,
        password: activeAccount.password,
        fallbackHost: activeAccount.fallbackHost,
      });
      // A host without gateway capabilities is a valid direct-PBX account.
      // Only surface enrollment failure when the gateway actually rejected
      // the account; `legacy` means there is no gateway to enroll with.
      if (prepared.mode !== 'gateway' && prepared.mode !== 'legacy') {
        throw new Error('Gateway enrollment unavailable');
      }
      if (generation !== accountGenerationRef.current) return;
      accountRef.current = activeAccount;
      setAccount(activeAccount);
      setIsAuthLoaded(true);
      setLoginMessage(null);
      setGatewayState('online');
      setGatewayMessage('');
      gatewayRetryAttemptRef.current = 0;
      sipRef.current?.setPreferredCodec(activeAccount.preferredCodec || 'opus');
      sipRef.current?.setMicVolume(activeAccount.micVolume ?? 50);
      sipRef.current?.setSpeakerVolume(activeAccount.speakerVolume ?? 85);
      CONFIG.sipDomain = activeAccount.serverHost;
      CONFIG.sipWss = getSipWss(activeAccount.serverHost, activeAccount.useTls);
      CONFIG.pushGateway = getPushGateway(activeAccount.serverHost);
      bindExtension(activeAccount.extension);
      void sipRef.current?.connect(
        activeAccount.extension,
        activeAccount.password,
        activeAccount.serverHost,
        activeAccount.useTls,
      );
    } catch (error) {
      if (generation !== accountGenerationRef.current) return;
      const message = describeEnrollmentError(error);
      if (isTerminalEnrollmentError(error)) {
        setGatewayState('blocked');
        setGatewayMessage(message);
        return;
      }
      setGatewayState('offline');
      setGatewayMessage(message);
      scheduleGatewayRetry(activeAccount, generation);
    }
  };

  retryGatewayRef.current = () => {
    const activeAccount = accountRef.current;
    if (!activeAccount) return;
    gatewayRetryAttemptRef.current = 0;
    void attemptGatewayRestore(activeAccount, accountGenerationRef.current);
  };

  useEffect(() => () => {
    clearGatewayRetry();
    clearAnswerWatchdog();
    for (const timer of terminalCallTimersRef.current.values()) clearTimeout(timer);
    terminalCallTimersRef.current.clear();
    terminalCallIdsRef.current.clear();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !account || fullScreenPromptedRef.current) return;
    fullScreenPromptedRef.current = true;
    let cancelled = false;
    void canUseFullScreenIntent().then(allowed => {
      if (cancelled || allowed) return;
      Alert.alert(
        'Allow full-screen incoming calls',
        'Android can block the incoming-call screen while the phone is locked. Allow full-screen notifications so calls can wake the display.',
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Open settings', onPress: () => { void openFullScreenIntentSettings(); } },
        ],
      );
    });
    return () => { cancelled = true; };
  }, [account?.extension, account?.serverHost]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !account) {
      setMissingCallPermissions(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const [fullScreen, battery] = await Promise.all([
          canUseFullScreenIntent(),
          isIgnoringBatteryOptimizations(),
        ]);
        if (!cancelled) {
          setMissingCallPermissions(fullScreen && battery
            ? null
            : { fullScreen: !fullScreen, battery: !battery });
        }
      } catch {
        // Permission state is advisory only; calls still work where Android permits.
      }
    };
    void refresh();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [account?.extension, account?.serverHost]);

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
      onStateChange: (state) => {
        setUiState(state);
        if (state === 'registered' && accountRef.current) {
          void reconcileMissedCalls(accountRef.current, setCallsHistory);
        }
      },
      onIncomingCall: (info) => {
        const callId = info.callId;
        if (isTerminalCall(callId)) {
          void sip.decline(callId);
          return;
        }
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

        // The phone has one call UI and one live SIP session slot. Accepting a
        // second INVITE would replace the visible call while leaving the first
        // PBX bridge alive with no way to return to it. Reject the additional
        // call instead; the active call must remain intact.
        const active = sipRef.current?.activeCall;
        const alreadyRinging = incomingRef.current;
        const isDuplicate = active?.id === callId || alreadyRinging?.callId === callId;
        if ((active || alreadyRinging) && !isDuplicate) {
          console.warn(`[app][callId=${callId}] rejected additional incoming call while call active`);
          void sip.decline(callId).then((declined) => {
            if (!declined) return;
            markCallTerminal(callId);
            dismissNativeCallNotification(callId);
            void clearPendingIncomingCall(callId);
          });
          showToast({
            type: 'info',
            title: 'Call waiting',
            message: 'Another call is already in progress.',
            duration: 3500,
          });
          return;
        }

        const existing = incomingRef.current?.callId === callId
          ? incomingRef.current
          : null;
        const correlatedInfo: IncomingCallInfo = {
          ...info,
          callerId: info.callerId || existing?.callerId || '',
          callerName: info.callerName || existing?.callerName || '',
          nativePresented: Platform.OS === 'android' || existing?.nativePresented || false,
        };
        updateCallUUID(callId);
        updateIncoming(correlatedInfo);
        console.log(`[app][callId=${callId}] SIP INVITE matched active=${sip.activeCall?.id || 'none'} incoming=${incomingRef.current?.callId || 'none'}`);

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
        clearAnswerWatchdog();
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
        clearAnswerWatchdog();
        markCallTerminal(callId);
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
        // A late end event for an older call must not erase a newer incoming
        // call. Only clear the incoming UI when it belongs to the ended call.
        const incomingIsNewer = !!currentIncoming &&
          !!resolvedCallId &&
          currentIncoming.callId !== resolvedCallId;
        if (!incomingIsNewer) {
          updateCallUUID(null);
          updateIncoming(null);
        } else {
          console.log(`[app][callId=${resolvedCallId}] kept newer incoming=${currentIncoming?.callId}`);
        }
        setIsSpeakerOn(false);
        desiredRouteRef.current = 'EARPIECE';
        stopCallManagers();

        if (currentCall) {
          const duration = currentCall.startTime
            ? Math.floor((Date.now() - currentCall.startTime) / 1000)
            : 0;
          StorageService.addCallRecord({
            callId: resolvedCallId || undefined,
            number: currentCall.target,
            name: callDisplayName(currentCall.target, currentCall.targetName),
            direction: currentCall.direction,
            timestamp: currentCall.startTime || Date.now(),
            duration,
          }).then(setCallsHistory);
        } else if (currentIncoming) {
          StorageService.addCallRecord({
            callId: resolvedCallId || undefined,
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
        fallbackHost: storedAccount?.fallbackHost,
        useTls: storedAccount?.useTls ?? false,
        dnd: storedAccount?.dnd || false,
        autoAnswer: storedAccount?.autoAnswer || false,
        preferredCodec: storedAccount?.preferredCodec || 'pcmu',
        micVolume: Math.max(0, Math.min(100, storedAccount?.micVolume ?? 50)),
        speakerVolume: storedAccount?.speakerVolume ?? 85,
      };
      if (restoreGeneration !== accountGenerationRef.current) return;
      // Keep the stored account mounted while the gateway is validated. A
      // network failure must never look like a sign-out.
      accountRef.current = activeAccount;
      setAccount(activeAccount);
      setGatewayState('restoring');
      setGatewayMessage('Connecting to gateway…');
      setIsAuthLoaded(true);
      void StorageService.saveAccount(activeAccount);
      await attemptGatewayRestore(activeAccount, restoreGeneration);
    }).catch((err) => {
      console.error('[app] account load failed:', err);
      setIsAuthLoaded(true);
    });
    StorageService.getCallHistory().then(setCallsHistory);
    StorageService.getContacts().then(setContacts);
    StorageService.getLastLogin().then(setLastAccount).catch(() => {});

    initPush((payload) => {
      const callId = payload.callId;
      if (isTerminalCall(callId)) {
        void clearPendingIncomingCall(callId);
        dismissNativeCallNotification(callId);
        return;
      }
      // A late copy of the push must not reopen an established call's overlay.
      if (sip.activeCall?.id === callId && sip.activeCall.status === 'active') return;
      // Never open a second ringing UI while another call is live. The SIP
      // layer rejects the eventual second INVITE with 486 Busy; acknowledge and
      // dismiss this push so it cannot become a ring/hangup target.
      if (sip.activeCall && sip.activeCall.id !== callId) {
        console.warn(`[app][callId=${callId}] push ignored while active=${sip.activeCall.id}`);
        markCallTerminal(callId);
        dismissNativeCallNotification(callId);
        void clearPendingIncomingCall(callId);
        return;
      }
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
      markCallTerminal(cancelCallId);
      if (incomingRef.current?.callId === cancelCallId) {
        console.log(`[app][callId=${cancelCallId}] cancel-call push dismissed overlay`);
        clearAnswerWatchdog();
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
      if (isTerminalCall(callId)) {
        dismissNativeCallNotification(callId);
        return;
      }
      console.log(`[app][callId=${callId}] native action=${payload.action}`);
      if (sip.activeCall && sip.activeCall.id !== callId) {
        console.warn(`[app][callId=${callId}] native action ignored while active=${sip.activeCall.id}`);
        markCallTerminal(callId);
        acknowledgeNativeCallAction(callId, payload.action === 'ANSWER' ? 'DECLINE' : payload.action);
        dismissNativeCallNotification(callId);
        void clearPendingIncomingCall(callId);
        if (pendingAnswerUUIDRef.current === callId) pendingAnswerUUIDRef.current = null;
        return;
      }
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
    clearAnswerWatchdog();
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
      markCallTerminal(callId);
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
      previous.serverHost !== newAcc.serverHost || previous.fallbackHost !== newAcc.fallbackHost || previous.password !== newAcc.password;
    const generation = ++accountGenerationRef.current;
    enrollmentAbortRef.current?.abort();
    clearGatewayRetry();
    const controller = new AbortController();
    enrollmentAbortRef.current = controller;
    try {
      if (identityChanged) {
        // Do not sign out the existing account while validating replacement
        // credentials. Keep it mounted until the new login is confirmed.
        sipRef.current?.disconnect();
        resetGatewaySession();
        const prepared = await prepareLogin({
          host: newAcc.serverHost, extension: newAcc.extension, password: newAcc.password,
          fallbackHost: newAcc.fallbackHost,
          signal: controller.signal,
          onProgress: progress => {
            if (generation === accountGenerationRef.current && progress.message) setLoginMessage(progress.message);
          },
        });
        if (generation !== accountGenerationRef.current) return;
        newAcc = { ...newAcc, extension: prepared.extension };
        if (previous) {
          // Remove the old registration only after the replacement login has
          // succeeded. A failed login leaves the previous account/token alone.
          try { await unregisterCurrentDevice(); } catch {}
        }
      }
      await StorageService.saveAccount(newAcc);
      if (generation !== accountGenerationRef.current) return;
      accountRef.current = newAcc;
      setAccount(newAcc);
      setLoginMessage(null);
      if (identityChanged) {
        setGatewayState('online');
        setGatewayMessage('');
        gatewayRetryAttemptRef.current = 0;
      }
      sipRef.current?.setPreferredCodec(newAcc.preferredCodec || 'opus');
      sipRef.current?.setMicVolume(newAcc.micVolume ?? 50);
      sipRef.current?.setSpeakerVolume(newAcc.speakerVolume ?? 85);
      CONFIG.sipDomain = newAcc.serverHost;
      CONFIG.sipWss = getSipWss(newAcc.serverHost, newAcc.useTls);
      CONFIG.pushGateway = getPushGateway(newAcc.serverHost);
      bindExtension(newAcc.extension);
      sipRef.current?.connect(newAcc.extension, newAcc.password, newAcc.serverHost, newAcc.useTls);
    } catch (error) {
      if (generation !== accountGenerationRef.current) throw error;
      if (!previous) {
        // Initial login: there is no existing account to preserve. Never call
        // setAccount(null) here; the only sign-out path is handleLogout.
        throw error;
      }
      // Preserve the previous account and keep the user on the main screen.
      accountRef.current = previous;
      setAccount(previous);
      const terminal = isTerminalEnrollmentError(error);
      setGatewayState(terminal ? 'blocked' : 'offline');
      setGatewayMessage(describeEnrollmentError(error));
      if (!terminal) scheduleGatewayRetry(previous, generation);
      throw error;
    }
  };

  const handleLogout = async () => {
    const leavingAccount = accountRef.current;
    if (leavingAccount) {
      await StorageService.saveLastLogin(leavingAccount);
      setLastAccount(leavingAccount);
    }
    ++accountGenerationRef.current;
    enrollmentAbortRef.current?.abort();
    clearGatewayRetry();
    clearAnswerWatchdog();
    accountRef.current = null;
    const removal = unregisterCurrentDevice();
    sipRef.current?.disconnect();
    resetGatewaySession();
    setAccount(null);
    setGatewayState('online');
    setGatewayMessage('');
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
          initialAccount={lastAccount}
          onLogin={async (ext, password, serverHost, fallbackHost) => {
            setLoginMessage(null);
            setUiState('connecting');
            try {
              // Gateway deployments enroll/await approval before any SIP work;
              // non-gateway hosts resolve to the existing direct-PBX login.
              const newAcc: SavedAccount = {
                ...(lastAccount || {}),
                extension: ext,
                password,
                serverHost: serverHost || '',
                fallbackHost: fallbackHost || undefined,
                useTls: lastAccount?.useTls ?? false,
                dnd: lastAccount?.dnd ?? false,
                autoAnswer: lastAccount?.autoAnswer ?? false,
                preferredCodec: lastAccount?.preferredCodec,
                micVolume: lastAccount?.micVolume,
                speakerVolume: lastAccount?.speakerVolume,
              };
              await handleSaveAccount(newAcc);
              await StorageService.saveLastLogin(newAcc);
              setLastAccount(newAcc);
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
      {gatewayState !== 'online' && (
        <View
          accessibilityRole="alert"
          style={[
            styles.gatewayBanner,
            {
              backgroundColor: gatewayState === 'blocked' ? colors.dangerSoft : colors.warningSoft,
              borderColor: gatewayState === 'blocked' ? colors.dangerBorder : colors.warningBorder,
            },
          ]}
        >
          <Text
            style={[
              styles.gatewayBannerText,
              { color: gatewayState === 'blocked' ? colors.dangerText : colors.warningText },
            ]}
          >
            {gatewayMessage || (gatewayState === 'restoring' ? 'Connecting to gateway…' : 'Gateway unavailable — reconnecting…')}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => retryGatewayRef.current?.()}
            style={styles.gatewayRetry}
          >
            <Text style={[styles.gatewayRetryText, { color: colors.text }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      {missingCallPermissions && !callPermissionBannerDismissed && (
        <View
          accessibilityRole="alert"
          style={[
            styles.gatewayBanner,
            styles.callPermissionBanner,
            { top: gatewayState === 'online' ? 48 : 104, backgroundColor: colors.warningSoft, borderColor: colors.warningBorder },
          ]}
        >
          <Text style={[styles.gatewayBannerText, { color: colors.warningText }]}>
            {missingCallPermissions.fullScreen
              ? 'Full-screen calls are blocked. Incoming calls may not wake the locked screen.'
              : 'Battery optimization may prevent incoming calls in the background.'}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              if (missingCallPermissions.fullScreen) void openFullScreenIntentSettings();
              else void requestIgnoreBatteryOptimizations();
            }}
            style={styles.gatewayRetry}
          >
            <Text style={[styles.gatewayRetryText, { color: colors.text }]}>Fix</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Dismiss call permission warning"
            onPress={() => setCallPermissionBannerDismissed(true)}
            style={styles.callPermissionDismiss}
          >
            <Text style={[styles.gatewayRetryText, { color: colors.text }]}>×</Text>
          </TouchableOpacity>
        </View>
      )}
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
        onRepairPush={repairPushRegistration}
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
        chatClient={chatClientRef.current}
        chatCache={chatCacheRef.current}
        chatConversations={chatConversations}
        chatUnread={chatUnread}
        chatSocket={chatSocketRef.current}
        onChatRefresh={handleChatRefresh}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  gatewayBanner: {
    position: 'absolute',
    top: 48,
    left: 12,
    right: 12,
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  gatewayBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  gatewayRetry: {
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  gatewayRetryText: {
    fontSize: 12,
    fontWeight: '700',
  },
  callPermissionBanner: {
    zIndex: 51,
  },
  callPermissionDismiss: {
    paddingVertical: 5,
    paddingHorizontal: 7,
  },
});
