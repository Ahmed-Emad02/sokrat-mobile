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
  markIncomingCallPresented,
  clearPendingIncomingCall,
} from './src/push/pushHandler';
import {
  setupCallKeep,
  reportIncomingCall,
  generateUUID,
  reportEnded,
  answerIncoming,
} from './src/calls/callKit';
import {
  dismissNativeCallNotification,
  getInitialNativeCallAction,
  subscribeNativeCallAction,
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
import { CONFIG } from './src/config';

// Main Native Phone Screen & Call Screens
import { StandardPhoneScreen } from './src/ui/StandardPhoneScreen';
import { RingingScreen } from './src/ui/RingingScreen';
import { LoginScreen } from './src/ui/LoginScreen';
export default function App() {
  const sipRef = useRef<JsSipService | null>(null);
  const incomingRef = useRef<IncomingCallInfo | null>(null);
  const activeCallUUIDRef = useRef<string | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingAnswerUUIDRef = useRef<string | null>(null);
  const pendingEndUUIDRef = useRef<string | null>(null);

  // App State
  const [account, setAccount] = useState<SavedAccount | null>(null);
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

  const answerSipCall = async (uuid: string): Promise<boolean> => {
    const answered = await sipRef.current?.answer();
    if (!answered) {
      pendingAnswerUUIDRef.current = uuid;
      return false;
    }
    pendingAnswerUUIDRef.current = null;
    updateIncoming(null);
    await clearPendingIncomingCall(uuid);
    dismissNativeCallNotification();
    return true;
  };

  const endSipCall = async (uuid: string) => {
    updateCallUUID(uuid);
    pendingAnswerUUIDRef.current = null;
    pendingEndUUIDRef.current = uuid;
    updateIncoming(null);
    await clearPendingIncomingCall(uuid);
    if (sipRef.current?.activeCall) {
      if (sipRef.current.activeCall.status === 'ringing' && sipRef.current.activeCall.direction === 'inbound') {
        await sipRef.current.decline();
      } else {
        await sipRef.current.hangup();
      }
      pendingEndUUIDRef.current = null;
    } else {
      await sipRef.current?.decline();
    }
    dismissNativeCallNotification();
    stopCallManagers();
  };
  useEffect(() => {
    // Request Android audio/microphone and notification permissions on startup
    if (Platform.OS === 'android') {
      PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ]).catch(() => {});
    }

    // 1. Initialize JsSIP Signaling Engine
    const sip = new JsSipService({
      onStateChange: (s) => setUiState(s),
      onIncomingCall: (info) => {
        const uuid = activeCallUUIDRef.current || generateUUID();
        if (pendingEndUUIDRef.current === uuid) {
          void sip.decline().finally(() => {
            pendingEndUUIDRef.current = null;
            void clearPendingIncomingCall(uuid);
          });
          return;
        }

        const correlatedInfo: IncomingCallInfo = {
          ...info,
          callId: uuid,
          nativePresented: incomingRef.current?.nativePresented || false,
        };
        updateCallUUID(uuid);
        updateIncoming(correlatedInfo);

        if (!correlatedInfo.nativePresented) {
          void reportIncomingCall(
            uuid,
            info.callerId,
            info.callerName || 'Incoming Call',
          ).then((displayed) => {
            if (displayed) {
              const current = incomingRef.current;
              if (current?.callId === uuid) {
                updateIncoming({ ...current, nativePresented: true });
              }
              void markIncomingCallPresented(uuid);
            }
          });
        }

        if (pendingAnswerUUIDRef.current === uuid) {
          void answerSipCall(uuid);
        }
      },
      onCallEstablished: (call) => {
        updateActiveCall(call);
        dismissNativeCallNotification();
        startCallManagers();
      },
      onCallEnded: (_id) => {
        const uuid = activeCallUUIDRef.current;
        const currentCall = activeCallRef.current;
        const currentIncoming = incomingRef.current;
        if (uuid) {
          reportEnded(uuid);
          void clearPendingIncomingCall(uuid);
        }
        pendingAnswerUUIDRef.current = null;
        pendingEndUUIDRef.current = null;
        updateCallUUID(null);
        updateIncoming(null);
        setIsSpeakerOn(false);
        dismissNativeCallNotification();
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

    // 2. Load stored account or auto-initialize ext 150 / sss333 / 192.168.100.128
    StorageService.getAccount().then((acc) => {
      const activeAcc: SavedAccount = {
        extension: acc?.extension || '150',
        password: acc?.password || 'sss333',
        serverHost: acc?.serverHost || '192.168.100.128',
        useTls: false,
        dnd: acc?.dnd || false,
        autoAnswer: acc?.autoAnswer || false,
      };

      setAccount(activeAcc);
      StorageService.saveAccount(activeAcc);
      CONFIG.sipDomain = activeAcc.serverHost;
      CONFIG.sipWss = `${activeAcc.useTls ? 'wss' : 'ws'}://${activeAcc.serverHost}:${activeAcc.useTls ? 8089 : 8088}/ws`;
      CONFIG.pushGateway = `http://${activeAcc.serverHost}:8095`;

      bindExtension(activeAcc.extension);
      sip.connect(activeAcc.extension, activeAcc.password, activeAcc.serverHost, activeAcc.useTls);
    });
    StorageService.getCallHistory().then(setCallsHistory);
    StorageService.getContacts().then(setContacts);

    // 3. Register Push-to-Wake Listeners (FCM)
    initPush((payload) => {
      console.log('[push] incoming call wake notification received:', payload);
      const uuid = payload.callId || generateUUID();
      const info: IncomingCallInfo = {
        type: 'incoming-call',
        callerId: payload.callerId || '',
        callerName: payload.callerName || 'Incoming Call',
        extension: payload.extension || '150',
        timestamp: payload.timestamp ? Number(payload.timestamp) : Date.now(),
        sipWss: payload.sipWss,
        callId: uuid,
        nativePresented: payload.nativePresented === '1',
      };

      updateCallUUID(uuid);
      updateIncoming(info);
      if (!info.nativePresented) {
        void reportIncomingCall(
          uuid,
          info.callerId,
          info.callerName,
        ).then((displayed) => {
          if (displayed) {
            const current = incomingRef.current;
            if (current?.callId === uuid) {
              updateIncoming({ ...current, nativePresented: true });
            }
            void markIncomingCallPresented(uuid);
          }
        });
      }

      StorageService.getAccount().then((acc) => {
        const ext = acc?.extension || '150';
        const pw = acc?.password || 'sss333';
        const host = acc?.serverHost || '192.168.100.128';
        const tls = acc?.useTls || false;
        if (!sip.isConnectedOrConnecting()) {
          sip.connect(ext, pw, host, tls);
        }
      });
    });

    // 4. Native CallKit / Telecom ConnectionService Handlers
    setupCallKeep({
      onAnswerCall: (uuid) => {
        void answerSipCall(uuid);
      },
      onEndCall: (uuid) => {
        void endSipCall(uuid);
      },
    });

    // 5. Native Android Call Notification Action Handling
    getInitialNativeCallAction().then((initial) => {
      if (!initial) return;
      const uuid = initial.callId || generateUUID();
      const info: IncomingCallInfo = {
        type: 'incoming-call',
        callerId: initial.callerId || '',
        callerName: initial.callerName || 'Incoming Call',
        extension: initial.extension || '150',
        timestamp: initial.timestamp ? Number(initial.timestamp) : Date.now(),
        callId: uuid,
        nativePresented: true,
      };
      updateCallUUID(uuid);
      updateIncoming(info);

      if (initial.action === 'ANSWER') {
        void answerSipCall(uuid);
      }
    });

    const unsubNativeAction = subscribeNativeCallAction((payload) => {
      const uuid = payload.callId || activeCallUUIDRef.current || generateUUID();
      if (payload.action === 'ANSWER') {
        void answerSipCall(uuid);
      } else if (payload.action === 'DECLINE') {
        void endSipCall(uuid);
      }
    });

    askNotificationPermission();

    return () => {
      sip.disconnect();
      unsubNativeAction();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Actions ---
  const handleOutboundCall = async (target: string) => {
    if (uiState !== 'registered' || !sipRef.current?.isRegistered()) {
      Alert.alert(
        'Not Connected',
        'Extension is currently connecting. Please ensure TLS / WSS Protocol is OFF on local LAN and status shows Connected.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      startCallManagers();
      await sipRef.current?.call(target);
      if (sipRef.current?.activeCall) {
        updateActiveCall({ ...sipRef.current.activeCall });
      }
    } catch (err) {
      console.error('[app] outbound call failed:', err);
      stopCallManagers();
    }
  };

  const handleAnswer = async () => {
    const uuid = activeCallUUIDRef.current;
    if (!uuid) return;
    answerIncoming(uuid);
    await answerSipCall(uuid);
  };

  const handleHangup = async () => {
    const uuid = activeCallUUIDRef.current;
    if (uuid) {
      await endSipCall(uuid);
      reportEnded(uuid);
    } else {
      if (incomingRef.current) {
        await sipRef.current?.decline();
      } else {
        await sipRef.current?.hangup();
      }
      stopCallManagers();
      updateIncoming(null);
    }
  };

  const handleSaveAccount = async (newAcc: SavedAccount) => {
    setAccount(newAcc);
    await StorageService.saveAccount(newAcc);
    CONFIG.sipDomain = newAcc.serverHost;
    CONFIG.sipWss = `${newAcc.useTls ? 'wss' : 'ws'}://${newAcc.serverHost}:${newAcc.useTls ? 8089 : 8088}/ws`;
    CONFIG.pushGateway = `http://${newAcc.serverHost}:8095`;
    bindExtension(newAcc.extension);
    sipRef.current?.connect(newAcc.extension, newAcc.password, newAcc.serverHost, newAcc.useTls);
  };

  const handleLogout = async () => {
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
  // 1. Not Logged In -> Show Full Dedicated Login Screen
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

  // 2. Incoming Call Overlay
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
        onSendDtmf={(d) => sipRef.current?.sendDTMF(d)}
        onTransfer={(t) => sipRef.current?.blindTransfer(t)}
        onSaveAccount={handleSaveAccount}
        onLogout={handleLogout}
        onClearHistory={handleClearHistory}
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
