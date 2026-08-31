/**
 * Sokrat VOICE Mobile Softphone App
 * Standard Phone Dialer UI with JsSIP WebRTC Engine & FCM Push-to-Wake.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, Platform, PermissionsAndroid } from 'react-native';
import { COLORS } from './src/theme';
import {
  JsSipService,
  SipState,
  ActiveCall,
  IncomingCallInfo,
} from './src/sip/JsSipService';
import { initPush, bindExtension, askNotificationPermission } from './src/push/pushHandler';
import {
  setupCallKeep,
  reportIncomingCall,
  generateUUID,
  reportEnded,
  answerIncoming,
} from './src/calls/callKit';
import {
  startCallManagers,
  stopCallManagers,
  setSpeakerphone,
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

  // App State
  const [account, setAccount] = useState<SavedAccount | null>(null);
  const [uiState, setUiState] = useState<SipState>('disconnected');
  const [callsHistory, setCallsHistory] = useState<CallRecord[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Telephony State
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [activeCallUUID, setActiveCallUUID] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);

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
        setIncoming(info);
        const uuid = generateUUID();
        setActiveCallUUID(uuid);
        reportIncomingCall(uuid, info.callerId, info.callerName || 'Incoming Call');
        startCallManagers();
      },
      onCallEstablished: (call) => {
        setActiveCall(call);
      },
      onCallEnded: (_id) => {
        if (activeCallUUID) reportEnded(activeCallUUID);
        setActiveCallUUID(null);
        setIncoming(null);
        stopCallManagers();

        if (activeCall) {
          const duration = activeCall.startTime
            ? Math.floor((Date.now() - activeCall.startTime) / 1000)
            : 0;
          StorageService.addCallRecord({
            number: activeCall.target,
            name: activeCall.targetName,
            direction: activeCall.direction,
            timestamp: activeCall.startTime || Date.now(),
            duration,
          }).then(setCallsHistory);
        } else if (incoming) {
          StorageService.addCallRecord({
            number: incoming.callerId,
            name: incoming.callerName,
            direction: 'missed',
            timestamp: incoming.timestamp,
          }).then(setCallsHistory);
        }

        setActiveCall(null);
      },
      onCallHoldChange: () => {
        // Handled via activeCall reference
      },
    });

    sipRef.current = sip;

    // 2. Load stored account or auto-initialize ext 150 / sss333 / 192.168.100.128
    StorageService.getAccount().then((acc) => {
      const activeAcc: SavedAccount = acc || {
        extension: '150',
        password: 'sss333',
        serverHost: '192.168.100.128',
        useTls: false,
        dnd: false,
        autoAnswer: false,
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
      console.log('[push] FCM wake notification received:', payload);
      const info: IncomingCallInfo = {
        type: 'incoming-call',
        callerId: payload.callerId || '',
        callerName: payload.callerName || 'Incoming Call',
        extension: payload.extension || '150',
        timestamp: payload.timestamp ? Number(payload.timestamp) : Date.now(),
        sipWss: payload.sipWss,
      };

      StorageService.getAccount().then((acc) => {
        const ext = acc?.extension || '150';
        const pw = acc?.password || 'sss333';
        const host = acc?.serverHost || '192.168.100.128';
        const tls = acc?.useTls || false;
        sip.connect(ext, pw, host, tls);
      });

      setIncoming(info);
    });

    // 4. Native CallKit / Telecom ConnectionService Handlers
    setupCallKeep({
      onAnswerCall: (uuid) => {
        answerIncoming(uuid);
        handleAnswer();
      },
      onEndCall: (uuid) => {
        reportEnded(uuid);
        handleHangup();
      },
    });

    askNotificationPermission();

    return () => {
      sip.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Actions ---
  const handleOutboundCall = async (target: string) => {
    try {
      startCallManagers();
      await sipRef.current?.call(target);
    } catch (err) {
      console.error('[app] outbound call failed:', err);
      stopCallManagers();
    }
  };

  const handleAnswer = async () => {
    setIncoming(null);
    startCallManagers();
    await sipRef.current?.answer();
  };

  const handleHangup = async () => {
    setIncoming(null);
    await sipRef.current?.hangup();
    stopCallManagers();
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
    setActiveCall(null);
    setIncoming(null);
    await StorageService.clearAccount();
  };

  // Contacts
  const handleSaveContact = async (contact: Contact) => {
    const updated = [contact, ...contacts.filter((c) => c.id !== contact.id)];
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
  if (incoming && !activeCall) {
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
        onCall={handleOutboundCall}
        onHangup={handleHangup}
        onToggleMute={() => sipRef.current?.toggleMute()}
        onToggleHold={() => sipRef.current?.toggleHold()}
        onToggleSpeaker={() => setSpeakerphone(true)}
        onSendDtmf={(d) => sipRef.current?.sendDTMF(d)}
        onTransfer={(t) => sipRef.current?.blindTransfer(t)}
        onSaveAccount={handleSaveAccount}
        onLogout={handleLogout}
        onClearHistory={handleClearHistory}
        onSaveContact={handleSaveContact}
        onDeleteContact={handleDeleteContact}
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
