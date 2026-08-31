/**
 * Sokrat VOICE Mobile Softphone App
 * Powered by Sokrat Voice (JsSIP + WebRTC Engine & Dark-Tech Console UI).
 */
import React, { useEffect, useRef } from 'react';
import {
  StyleSheet,
  StatusBar,
  Platform,
  PermissionsAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { initPush, bindExtension, askNotificationPermission } from './src/push/pushHandler';
import {
  setupCallKeep,
  answerIncoming,
  reportEnded,
} from './src/calls/callKit';
import { startCallManagers, stopCallManagers } from './src/calls/incall';

export default function App() {
  const webViewRef = useRef<any>(null);
  useEffect(() => {
    // Request Android microphone and notification permissions on boot
    if (Platform.OS === 'android') {
      PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ]).catch(() => {});
    }

    // 1. FCM Background Push-to-Wake Listener
    initPush((payload) => {
      console.log('[mobile] FCM push received:', payload);
      webViewRef.current?.injectJavaScript(`
        if (window.softphoneUI && window.softphoneUI.core) {
          console.log('[sokrat-voice] wake on incoming call');
        }
        true;
      `);
    });

    // 2. Native CallKit / Telecom ConnectionService Handlers
    setupCallKeep({
      onAnswerCall: (uuid) => {
        answerIncoming(uuid);
        startCallManagers();
        webViewRef.current?.injectJavaScript(`
          if (window.softphoneUI && window.softphoneUI.core) {
            const firstCall = Array.from(window.softphoneUI.core.activeCalls.values())[0];
            if (firstCall && firstCall.session) {
              window.softphoneUI.core.answerCall(firstCall.id);
            }
          }
          true;
        `);
      },
      onEndCall: (uuid) => {
        reportEnded(uuid);
        stopCallManagers();
        webViewRef.current?.injectJavaScript(`
          if (window.softphoneUI && window.softphoneUI.core) {
            window.softphoneUI.core.hangupActiveCall();
          }
          true;
        `);
      },
    });

    askNotificationPermission();
  }, []);

  const handleMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'REG_STATE_CHANGE' && data.state === 'REGISTERED' && data.extension) {
        bindExtension(data.extension);
      }
    } catch {}
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#050507" />
      <WebView
        ref={webViewRef}
        source={{ uri: 'file:///android_asset/sokrat-voice/index.html' }}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        androidLayerType="hardware"
        onMessage={handleMessage}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050507',
  },
  webview: {
    flex: 1,
    backgroundColor: '#050507',
  },
});
