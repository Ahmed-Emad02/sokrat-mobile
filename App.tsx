/**
 * Sokrat VOICE Mobile Softphone App
 * Complete WebRTC softphone client matching sokrat-voice.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, View } from 'react-native';
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

// UI Components
import { Header } from './src/ui/Header';
import { TabBar, TabId } from './src/ui/TabBar';
import { DialerTab } from './src/ui/DialerTab';
import { RecentsTab } from './src/ui/RecentsTab';
import { ContactsTab } from './src/ui/ContactsTab';
import { SettingsTab } from './src/ui/SettingsTab';
import { RingingScreen } from './src/ui/RingingScreen';
import { ActiveCallModal } from './src/ui/ActiveCallModal';
import { LoginScreen } from './src/ui/LoginScreen';

export default function App() {
  const sipRef = useRef<JsSipService | null>(null);

  // App State
  const [account, setAccount] = useState<SavedAccount | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('keypad');
  const [uiState, setUiState] = useState<SipState>('disconnected');
  const [callsHistory, setCallsHistory] = useState<CallRecord[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Telephony State
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [activeCallUUID, setActiveCallUUID] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isHeld, setIsHeld] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(false);

  useEffect(() => {
    // 1. Initialize SIP Service Engine
    const sip = new JsSipService({
      onStateChange: (s) => setUiState(s),
      onIncomingCall: (info) => {
        // DND Guard
        if (account?.dnd) {
          sipRef.current?.decline();
          return;
        }

        setIncoming(info);
        const uuid = generateUUID();
        setActiveCallUUID(uuid);
        reportIncomingCall(uuid, info.callerId, info.callerName || 'Incoming Call');
        startCallManagers();

        // Auto-Answer Guard
        if (account?.autoAnswer) {
          setTimeout(() => {
            handleAnswer();
          }, 1000);
        }
      },
      onCallEstablished: (call) => {
        setActiveCall(call);
        setIsMuted(false);
        setIsHeld(false);
      },
      onCallEnded: (callId, cause) => {
        if (activeCallUUID) reportEnded(activeCallUUID);
        setActiveCallUUID(null);
        setIncoming(null);
        stopCallManagers();

        // Save call record to history if there was an active call
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
          // Missed call
          StorageService.addCallRecord({
            number: incoming.callerId,
            name: incoming.callerName,
            direction: 'missed',
            timestamp: incoming.timestamp,
          }).then(setCallsHistory);
        }

        setActiveCall(null);
      },
      onCallHoldChange: (held) => {
        setIsHeld(held);
      },
    });

    sipRef.current = sip;

    // 2. Load stored state on boot
    StorageService.getAccount().then((acc) => {
      if (acc) {
        setAccount(acc);
        CONFIG.sipDomain = acc.serverHost;
        CONFIG.sipWss = `${acc.useTls ? 'wss' : 'ws'}://${acc.serverHost}:${acc.useTls ? 8089 : 8088}/ws`;
        CONFIG.pushGateway = `http://${acc.serverHost}:8095`;
        bindExtension(acc.extension);
        sip.connect(acc.extension, acc.password, acc.serverHost, acc.useTls);
      }
    });

    StorageService.getCallHistory().then(setCallsHistory);
    StorageService.getContacts().then(setContacts);

    // 3. Register push listeners (FCM / PushKit)
    initPush((payload) => {
      const info: IncomingCallInfo = {
        type: 'incoming-call',
        callerId: payload.callerId || '',
        callerName: payload.callerName || 'Incoming Call',
        extension: payload.extension || '',
        timestamp: payload.timestamp ? Number(payload.timestamp) : Date.now(),
        sipWss: payload.sipWss,
      };

      StorageService.getAccount().then((acc) => {
        const ext = acc?.extension || payload.extension;
        const pw = acc?.password;
        if (ext && pw) {
          sip.connect(ext, pw, acc.serverHost, acc.useTls);
        }
      });

      setIncoming(info);
    });

    // 4. Native CallKit / Telecom ConnectionService handlers
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

  // --- Login & Account Actions ---
  const handleLogin = async (ext: string, password: string, serverHost: string) => {
    const useTls = false; // default plain WS on port 8088 on LAN (no self-signed cert errors)
    const newAcc: SavedAccount = {
      extension: ext,
      password,
      serverHost: serverHost || CONFIG.sipDomain,
      useTls,
      dnd: false,
      autoAnswer: false,
    };

    CONFIG.sipDomain = newAcc.serverHost;
    CONFIG.sipWss = `${useTls ? 'wss' : 'ws'}://${newAcc.serverHost}:${useTls ? 8089 : 8088}/ws`;
    CONFIG.pushGateway = `http://${newAcc.serverHost}:8095`;

    setAccount(newAcc);
    await StorageService.saveAccount(newAcc);
    bindExtension(ext);
    await sipRef.current?.connect(ext, password, newAcc.serverHost, useTls);
  };

  const handleLogout = async () => {
    sipRef.current?.disconnect();
    setAccount(null);
    setActiveCall(null);
    setIncoming(null);
    await StorageService.clearAccount();
  };

  const handleSaveServerSettings = async (host: string, useTls: boolean) => {
    if (!account) return;
    const updated: SavedAccount = { ...account, serverHost: host, useTls };
    setAccount(updated);
    await StorageService.saveAccount(updated);
    CONFIG.sipDomain = host;
    CONFIG.sipWss = `${useTls ? 'wss' : 'ws'}://${host}:${useTls ? 8089 : 8088}/ws`;
    CONFIG.pushGateway = `http://${host}:8095`;
    sipRef.current?.connect(updated.extension, updated.password, host, useTls);
  };

  const handleToggleDnd = async (val?: boolean) => {
    if (!account) return;
    const nextDnd = val !== undefined ? val : !account.dnd;
    const updated: SavedAccount = { ...account, dnd: nextDnd };
    setAccount(updated);
    await StorageService.saveAccount(updated);
  };

  const handleToggleAutoAnswer = async (val?: boolean) => {
    if (!account) return;
    const nextAuto = val !== undefined ? val : !account.autoAnswer;
    const updated: SavedAccount = { ...account, autoAnswer: nextAuto };
    setAccount(updated);
    await StorageService.saveAccount(updated);
  };

  // --- Telephony Actions ---
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

  const handleToggleMute = () => {
    if (sipRef.current) {
      const muted = sipRef.current.toggleMute();
      setIsMuted(muted);
    }
  };

  const handleToggleHold = () => {
    if (sipRef.current) {
      const held = sipRef.current.toggleHold();
      setIsHeld(held);
    }
  };

  const handleToggleSpeaker = () => {
    const next = !isSpeaker;
    setIsSpeaker(next);
    setSpeakerphone(next);
  };

  const handleSendDtmf = (digit: string) => {
    sipRef.current?.sendDTMF(digit);
  };

  const handleTransfer = (target: string) => {
    sipRef.current?.blindTransfer(target);
  };

  // --- Contact Actions ---
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

  // 1. Not Logged In -> Show LoginScreen
  if (!account) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.root}>
        <StatusBar barStyle="light-content" />
        <LoginScreen onLogin={handleLogin} state={uiState} />
      </SafeAreaProvider>
    );
  }

  // 2. Incoming Call Screen
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

  // 3. Logged In Softphone View (Header + Tabs + Bottom Navigation + ActiveCall Modal)
  const unreadMissed = callsHistory.filter((c) => c.direction === 'missed').length;

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.appContainer}>
        {/* Sokrat Header */}
        <Header
          extension={account.extension}
          serverHost={account.serverHost}
          state={uiState}
          isDnd={account.dnd}
          isAutoAnswer={account.autoAnswer}
          onToggleDnd={() => handleToggleDnd()}
          onToggleAutoAnswer={() => handleToggleAutoAnswer()}
        />

        {/* Active Tab View */}
        <View style={styles.tabContent}>
          {activeTab === 'keypad' && (
            <DialerTab
              onCall={handleOutboundCall}
              isRegistered={uiState === 'registered'}
            />
          )}

          {activeTab === 'recents' && (
            <RecentsTab
              calls={callsHistory}
              onCallNumber={handleOutboundCall}
              onClearHistory={handleClearHistory}
            />
          )}

          {activeTab === 'contacts' && (
            <ContactsTab
              contacts={contacts}
              onCallContact={handleOutboundCall}
              onSaveContact={handleSaveContact}
              onDeleteContact={handleDeleteContact}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              extension={account.extension}
              serverHost={account.serverHost}
              useTls={account.useTls}
              state={uiState}
              isDnd={account.dnd}
              isAutoAnswer={account.autoAnswer}
              onSaveServer={handleSaveServerSettings}
              onToggleDnd={(val) => handleToggleDnd(val)}
              onToggleAutoAnswer={(val) => handleToggleAutoAnswer(val)}
              onLogout={handleLogout}
            />
          )}
        </View>

        {/* Bottom Tab Navigation */}
        <TabBar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          unreadMissedCount={unreadMissed}
        />

        {/* Active Call Modal Overlay */}
        <ActiveCallModal
          call={activeCall}
          isMuted={isMuted}
          isHeld={isHeld}
          isSpeaker={isSpeaker}
          onToggleMute={handleToggleMute}
          onToggleHold={handleToggleHold}
          onToggleSpeaker={handleToggleSpeaker}
          onSendDtmf={handleSendDtmf}
          onTransfer={handleTransfer}
          onHangup={handleHangup}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  appContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'space-between',
  },
  tabContent: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
});
