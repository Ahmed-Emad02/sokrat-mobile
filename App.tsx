/**
 * Sokrat VOICE mobile App entry.
 *
 * Boot order matters for push-to-wake:
 *  1. initPush()      — registers PushKit/FCM listeners BEFORE registration
 *  2. setupCallKeep() — primes CallKit / TelecomManager
 *  3. sip.connect()   — on login OR on incoming push (cold start)
 */
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'react-native';
import { COLORS } from './src/theme';
import { SipService, SipState, IncomingCallInfo } from './src/sip/sipService';
import { initPush, bindExtension, askNotificationPermission } from './src/push/pushHandler';
import {
  setupCallKeep, reportIncomingCall, generateUUID, reportEnded, answerIncoming,
} from './src/calls/callKit';
import { startCallManagers, stopCallManagers } from './src/calls/incall';
import { LoginScreen } from './src/ui/LoginScreen';
import { RingingScreen } from './src/ui/RingingScreen';

export default function App() {
  console.log('[App] rendering App component');
  const sipRef = useRef<SipService | null>(null);
  const [uiState, setUiState] = useState<SipState>('disconnected');
  const [account, setAccount] = useState<{ extension: string } | null>(null);
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [activeCallUUID, setActiveCallUUID] = useState<string | null>(null);
  useEffect(() => {
    const sip = new SipService({
      onStateChange: (s) => setUiState(s),
      onIncomingCall: (info) => {
        setIncoming(info);
        // MUST report to CallKit within the OS cold-start budget.
        const uuid = generateUUID();
        setActiveCallUUID(uuid);
        reportIncomingCall(uuid, info.callerId, info.callerName || 'Incoming Call');
        startCallManagers();
      },
      onCallEnded: (_id) => {
        if (activeCallUUID) reportEnded(activeCallUUID);
        setActiveCallUUID(null);
        setIncoming(null);
        stopCallManagers();
      },
      onCallEstablished: () => {},
    });
    sipRef.current = sip;

    // 1. Push listeners (PushKit/FCM) — must be first.
    initPush((payload) => {
      const info: IncomingCallInfo = {
        type: 'incoming-call',
        callerId: payload.callerId || '',
        callerName: payload.callerName || 'Incoming Call',
        extension: payload.extension || '',
        timestamp: payload.timestamp ? Number(payload.timestamp) : Date.now(),
        sipWss: payload.sipWss,
      };
      const ext = account?.extension || payload.extension || '';
      const pw = ''; // loaded from secure store in a real build
      if (ext && pw) {
        sip.connect(ext, pw).then(() => sip && console.log('[app] woke by push'));
      }
      setIncoming(info);
    });

    // 2. Native call screen handlers.
    setupCallKeep({
      onAnswerCall: (uuid) => {
        answerIncoming(uuid);
        setIncoming(null);
        sipRef.current?.answer();
        startCallManagers();
      },
      onEndCall: (uuid) => {
        reportEnded(uuid);
        setIncoming(null);
        sipRef.current?.hangup();
        stopCallManagers();
      },
    });

    askNotificationPermission();

    return () => {
      sip.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = async (ext: string, password: string) => {
    setAccount({ extension: ext });
    bindExtension(ext);
    await sipRef.current?.connect(ext, password);
  };

  if (!account) {
    return (
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ flex: 1, backgroundColor: COLORS.bg }}>
        <StatusBar barStyle="light-content" />
        <LoginScreen onLogin={handleLogin} state={uiState} />
      </SafeAreaProvider>
    );
  }
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ flex: 1, backgroundColor: COLORS.bg }}>
      <StatusBar barStyle="light-content" />
      {incoming ? (
        <RingingScreen
          callerId={incoming.callerId}
          callerName={incoming.callerName}
          onAnswer={() => {
            const uuid = activeCallUUID || generateUUID();
            answerIncoming(uuid);
            setIncoming(null);
            sipRef.current?.answer();
          }}
          onDecline={() => {
            const uuid = activeCallUUID;
            if (uuid) reportEnded(uuid);
            setIncoming(null);
            sipRef.current?.hangup();
          }}
        />
      ) : (
        <LoginScreen
          onLogin={handleLogin}
          state={uiState}
          registeredAs={account.extension}
        />
      )}
    </SafeAreaProvider>
  );
}
