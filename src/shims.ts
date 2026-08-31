/**
 * Sokrat VOICE React Native shims for sip.js and WebRTC.
 * MUST be imported as the first line of index.js before any other imports.
 */
import { registerGlobals } from 'react-native-webrtc';

// 1. Shims for browser window and Web Audio globals used by sip.js
const g = globalThis as Record<string, unknown>;

if (typeof g.window !== 'object' || !g.window) {
  g.window = g;
}

const win = g.window as Record<string, unknown>;
if (typeof win.addEventListener !== 'function') {
  win.addEventListener = () => {};
}
if (typeof win.removeEventListener !== 'function') {
  win.removeEventListener = () => {};
}

// Dummy AudioContext for sip.js WebAudioSessionDescriptionHandler top-level instantiation
if (typeof g.AudioContext !== 'function') {
  class DummyAudioContext {
    state = 'running';
    createMediaStreamDestination() {
      return { stream: {} };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  g.AudioContext = DummyAudioContext;
  g.webkitAudioContext = DummyAudioContext;
  win.AudioContext = DummyAudioContext;
  win.webkitAudioContext = DummyAudioContext;
}

// 2. Register WebRTC DOM globals (RTCPeerConnection, RTCSessionDescription, navigator.mediaDevices, etc.)
registerGlobals();
