/**
 * Sokrat VOICE Mobile Softphone App
 * Standard Phone Dialer UI with JsSIP WebRTC Engine & FCM Push-to-Wake.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, Platform, PermissionsAndroid, Alert } from 'react-native';
import { COLORS } from './src/theme';
import {
  JsSipService,
  SipState,
  ActiveCall,
  IncomingCallInfo,
} from './src/sip/JsSipService';
import {
  initPush,
  bindExtension,
  askNotificationPermission,
  clearPendingIncomingCall,
  unregisterCurrentDevice,
} from './src/push/pushHandler';
import { CONFIG } from './src/config';
import {
  setupCallKeep,
  reportIncomingCall,
  reportEnded,
  answerIncoming,
} from './src/calls/callKit';
import {
  acknowledgeNativeCallAction,
  clearNativeCallWindow,
  dismissNativeCallNotification,
  getPendingNativeCalls,
  recordNativeCallAction,
  subscribeNativeCallAction,
  setNativeSpeakerVolume,
  CallActionPayload,
} from './src/calls/nativeCallNotification';
import {
  startCallManagers,
  stopCallManagers,
  setSpeakerphone,
  setMicrophoneMute,
} from './src/calls/incall';
import {
  StorageService,
  SavedAccount,
  CallRecord,
  Contact,
} from './src/storage/store';
import { LoginScreen } from './src/ui/LoginScreen';
import { RingingScreen } from './src/ui/RingingScreen';
import { StandardPhoneScreen } from './src/ui/StandardPhoneScreen';
export default function App() {
  const sipRef = useRef<JsSipService | null>(null);
  const incomingRef = useRef<IncomingCallInfo | null>(null);
  const activeCallUUIDRef = useRef<string | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingAnswerUUIDRef = useRef<string | null>(null);
  const pendingEndUUIDRef = useRef<string | null>(null);

  // App State
  const [account, setAccount] = useState<SavedAccount | null>(null);
  const [isAuthLoaded, setIsAuthLoaded] = useState(false);
  const [uiState, setUiState] = useState<SipState>('disconnected');
  const [callsHistory, setCallsHistory] = useState<CallRecord[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Telephony State
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [activeCallUUID, setActiveCallUUID] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);

  const updateIncoming = (value: IncomingCallInfo | null) => {
    incomingRef.current = value;
    setIncoming(value);
  };

  const updateCallUUID = (value: string | null) => {
    activeCallUUIDRef.current = value;
    setActiveCallUUID(value);
  };

  const updateActiveCall = (value: ActiveCall | null) => {
    activeCallRef.current = value;
    setActiveCall(value);
  };

  const answerSipCall = async (callId: string): Promise<boolean> => {
    pendingAnswerUUIDRef.current = callId;
    recordNativeCallAction(callId, 'ANSWER');
    startCallManagers();
    const answered = await sipRef.current?.answer(callId);
    if (!answered) return false;
    pendingAnswerUUIDRef.current = null;
    acknowledgeNativeCallAction(callId, 'ANSWER');
    if (sipRef.current?.activeCall) {
      updateActiveCall({
        ...sipRef.current.activeCall,
        status: 'active',
        startTime: Date.now(),
      });
    }
    updateIncoming(null);
    await clearPendingIncomingCall(callId);
    dismissNativeCallNotification(callId);
    return true;
  };

  const endSipCall = async (callId: string) => {
    updateCallUUID(callId);
    pendingAnswerUUIDRef.current = null;
    pendingEndUUIDRef.current = callId;
    recordNativeCallAction(callId, 'DECLINE');
    updateIncoming(null);
    dismissNativeCallNotification(callId);
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
      PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ]).then((result) => {
        if (result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] !==
            PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[app] microphone permission denied; calls cannot be answered');
        }
      }).catch((error) => {
        console.warn('[app] permission preflight failed:', error);
      });
    }

    const sip = new JsSipService({
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

        if (pendingAnswerUUIDRef.current === callId) {
          void answerSipCall(callId);
        }
      },
      onCallEstablished: (call) => {
        updateActiveCall(call);
        updateCallUUID(call.id);
        pendingAnswerUUIDRef.current = null;
        acknowledgeNativeCallAction(call.id, 'ANSWER');
        dismissNativeCallNotification(call.id);
        void clearPendingIncomingCall(call.id);
        startCallManagers();
      },
      onCallEnded: (callId) => {
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
        stopCallManagers();

        if (currentCall) {
          const duration = currentCall.startTime
            ? Math.floor((Date.now() - currentCall.startTime) / 1000)
            : 0;
          StorageService.addCallRecord({
            number: currentCall.target,
            name: currentCall.targetName,
            direction: currentCall.direction,
            timestamp: currentCall.startTime || Date.now(),
            duration,
          }).then(setCallsHistory);
        } else if (currentIncoming) {
          StorageService.addCallRecord({
            number: currentIncoming.callerId,
            name: currentIncoming.callerName,
            direction: 'missed',
            timestamp: currentIncoming.timestamp,
          }).then(setCallsHistory);
        }
        updateActiveCall(null);
        clearNativeCallWindow();
      },
      onCallHoldChange: (isHeld) => {
        if (activeCallRef.current) {
          updateActiveCall({ ...activeCallRef.current, isHeld });
        }
      },
      onCallMuteChange: (isMuted) => {
        if (activeCallRef.current) {
          updateActiveCall({ ...activeCallRef.current, isMuted });
        }
        setMicrophoneMute(isMuted);
      },
    });
    sipRef.current = sip;

    StorageService.getAccount().then((storedAccount) => {
      const activeAccount: SavedAccount = {
        extension: storedAccount?.extension || '150',
        password: storedAccount?.password || 'sss333',
        serverHost: storedAccount?.serverHost || '192.168.100.128',
        useTls: false,
        dnd: storedAccount?.dnd || false,
        autoAnswer: storedAccount?.autoAnswer || false,
        preferredCodec: storedAccount?.preferredCodec || 'opus',
        micVolume: storedAccount?.micVolume ?? 85,
        speakerVolume: storedAccount?.speakerVolume ?? 85,
      };
      sip.setPreferredCodec(activeAccount.preferredCodec || 'opus');
      sip.setMicVolume(activeAccount.micVolume ?? 85);
      sip.setSpeakerVolume(activeAccount.speakerVolume ?? 85);
      void setNativeSpeakerVolume(activeAccount.speakerVolume ?? 85);
      setAccount(activeAccount);
      void StorageService.saveAccount(activeAccount);
      CONFIG.sipDomain = activeAccount.serverHost;
      CONFIG.sipWss =
        `${activeAccount.useTls ? 'wss' : 'ws'}://${activeAccount.serverHost}:` +
        `${activeAccount.useTls ? 8089 : 8088}/ws`;
      CONFIG.pushGateway = `http://${activeAccount.serverHost}:8095`;
      bindExtension(activeAccount.extension);
      void sip.connect(
        activeAccount.extension,
        activeAccount.password,
        activeAccount.serverHost,
        activeAccount.useTls,
      );
    });
    StorageService.getCallHistory().then(setCallsHistory);
    StorageService.getContacts().then(setContacts);

    initPush((payload) => {
      const callId = payload.callId;
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

      void StorageService.getAccount().then((storedAccount) => {
        if (!storedAccount) {
          console.error(`[app][callId=${callId}] cannot bootstrap SIP: no account`);
          return;
        }
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
    };

    void getPendingNativeCalls().then((calls) => {
      calls.forEach(handleNativeAction);
    });
    const unsubscribeNativeAction = subscribeNativeCallAction(handleNativeAction);
    askNotificationPermission();

    return () => {
      sip.disconnect();
      unsubscribeNativeAction();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Actions ---
  const handleOutboundCall = async (target: string) => {
    const destination = target.trim();
    if (!destination) return;
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
    } catch (err) {
      console.error('[app] outbound call failed:', err);
      stopCallManagers();
    }
  };

  const handleAnswer = async () => {
    const callId = activeCallUUIDRef.current;
    if (!callId) return;
    answerIncoming(callId);
    const answered = await answerSipCall(callId);
    if (!answered && sipRef.current?.activeCall?.id === callId) {
      Alert.alert('Call failed', 'Microphone access failed or the call is no longer available.');
    }
  };

  const handleHangup = async () => {
    const callId = activeCallUUIDRef.current;
    if (callId && activeCallRef.current?.status !== 'active') {
      await endSipCall(callId);
      reportEnded(callId);
      return;
    }
    await sipRef.current?.hangup();
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
  const handleSaveAccount = async (newAcc: SavedAccount) => {
    setAccount(newAcc);
    await StorageService.saveAccount(newAcc);
    sipRef.current?.setPreferredCodec(newAcc.preferredCodec || 'opus');
    sipRef.current?.setMicVolume(newAcc.micVolume ?? 85);
    sipRef.current?.setSpeakerVolume(newAcc.speakerVolume ?? 85);
    void setNativeSpeakerVolume(newAcc.speakerVolume ?? 85);
    CONFIG.sipDomain = newAcc.serverHost;
    CONFIG.sipWss = `${newAcc.useTls ? 'wss' : 'ws'}://${newAcc.serverHost}:${newAcc.useTls ? 8089 : 8088}/ws`;
    CONFIG.pushGateway = `http://${newAcc.serverHost}:8095`;
    bindExtension(newAcc.extension);
    sipRef.current?.connect(newAcc.extension, newAcc.password, newAcc.serverHost, newAcc.useTls);
  };

  const handleLogout = async () => {
    await unregisterCurrentDevice();
    sipRef.current?.disconnect();
    setAccount(null);
    updateActiveCall(null);
    updateIncoming(null);
    updateCallUUID(null);
    await clearPendingIncomingCall();
    await StorageService.clearAccount();
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
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.root}>
        <StatusBar barStyle="light-content" />
      </SafeAreaProvider>
    );
  }

  // 2. Incoming Call Overlay (Ringing Screen takes precedence over login)
  if (incoming) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.root}>
        <StatusBar barStyle="light-content" />
        <RingingScreen
          callerId={incoming.callerId}
          callerName={incoming.callerName}
          onAnswer={handleAnswer}
          onDecline={handleHangup}
        />
      </SafeAreaProvider>
    );
  }

  // 3. Not Logged In -> Show Full Dedicated Login Screen
  if (!account) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.root}>
        <StatusBar barStyle="light-content" />
        <LoginScreen
          onLogin={async (ext, password, serverHost) => {
            const newAcc: SavedAccount = {
              extension: ext,
              password,
              serverHost: serverHost || '192.168.100.128',
              useTls: false,
              dnd: false,
              autoAnswer: false,
            };
            await handleSaveAccount(newAcc);
          }}
          state={uiState}
        />
      </SafeAreaProvider>
    );
  }
  // Standard Phone Application View
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.root}>
      <StatusBar barStyle="light-content" />
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
        onToggleSpeaker={() => {
          const next = !isSpeakerOn;
          setIsSpeakerOn(next);
          setSpeakerphone(next);
        }}
        onSendDtmf={(d: string) => sipRef.current?.sendDTMF(d)}
        onTransfer={(t: string) => sipRef.current?.blindTransfer(t)}
        onSaveAccount={handleSaveAccount}
        onLogout={handleLogout}
        onClearHistory={handleClearHistory}
        onDeleteCallRecord={handleDeleteCallRecord}
        onSaveContact={handleSaveContact}
        onDeleteContact={handleDeleteContact}
        onSaveContactsBatch={handleSaveContactsBatch}
        onToggleFavorite={handleToggleFavorite}
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
