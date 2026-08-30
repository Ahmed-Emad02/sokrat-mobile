/**
 * @format
 */

import { registerGlobals } from 'react-native-webrtc';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// Register WebRTC DOM globals required by sip.js (RTCPeerConnection, navigator.mediaDevices, etc.)
registerGlobals();

AppRegistry.registerComponent(appName, () => App);
