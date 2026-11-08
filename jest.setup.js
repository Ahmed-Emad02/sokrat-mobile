/**
 * Jest setup: mock native VoIP modules that require device-native
 * TurboModules so the unit test suite runs in a plain Node environment.
 */
jest.mock('react-native-webrtc', () => {
  const noop = () => {};
  return {
    RTCPeerConnection: function RTCPeerConnection() {},
    RTCSessionDescription: function RTCSessionDescription() {},
    RTCIceCandidate: function RTCIceCandidate() {},
    MediaStream: function MediaStream() {},
    mediaDevices: { getUserMedia: jest.fn(() => Promise.resolve({})) },
    registerGlobals: noop,
  };
});

jest.mock('react-native-callkeep', () => {
  return {
    __esModule: true,
    default: {
      setup: jest.fn(() => Promise.resolve(true)),
      getInitialEvents: jest.fn(() => Promise.resolve([])),
      clearInitialEvents: jest.fn(),
      setAvailable: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      displayIncomingCall: jest.fn(),
      answerIncomingCall: jest.fn(),
      reportEndCallWithUUID: jest.fn(),
      reportConnectedOutgoingCallWithUUID: jest.fn(),
      setCurrentCallActive: jest.fn(),
      setCurrentCallEnded: jest.fn(),
      startCall: jest.fn(),
      endCall: jest.fn(),
      endAllCalls: jest.fn(),
    },
    CONSTANTS: { END_CALL_REASONS: { REMOTE_ENDED: 2 } },
  };
});

jest.mock('react-native-voip-push-notification', () => {
  return {
    __esModule: true,
    default: {
      registerVoipToken: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      onVoipNotificationCompleted: jest.fn(),
    },
  };
});

jest.mock('react-native-incall-manager', () => {
  return {
    __esModule: true,
    default: {
      start: jest.fn(),
      stop: jest.fn(),
      setForceSpeakerphoneOn: jest.fn(),
      setSpeakerphoneOn: jest.fn(),
      setKeepScreenOn: jest.fn(),
      setMicrophoneMute: jest.fn(),
      startRingtone: jest.fn(),
      stopRingtone: jest.fn(),
      startRingback: jest.fn(),
      stopRingback: jest.fn(),
      chooseAudioRoute: jest.fn(() => Promise.resolve('EARPIECE')),
    },
  };
});

jest.mock('@react-native-community/push-notification-ios', () => {
  return {
    __esModule: true,
    default: {
      addEventListener: jest.fn(),
      requestPermissions: jest.fn(),
      setApplicationIconBadgeNumber: jest.fn(),
    },
  };
});

jest.mock('@react-native-firebase/messaging', () => {
  const noop = () => {};
  return {
    getMessaging: () => ({}),
    setBackgroundMessageHandler: noop,
    getToken: jest.fn(() => Promise.resolve('mock-token')),
    deleteToken: jest.fn(() => Promise.resolve()),
    onTokenRefresh: noop,
    requestPermission: jest.fn(() => Promise.resolve(1)),
    onMessage: noop,
  };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const mockComponent = (name) => (props) => React.createElement(View, { testID: name, ...props });
  return {
    __esModule: true,
    default: mockComponent('Svg'),
    Svg: mockComponent('Svg'),
    Path: mockComponent('Path'),
    Circle: mockComponent('Circle'),
    Rect: mockComponent('Rect'),
    Line: mockComponent('Line'),
    Polyline: mockComponent('Polyline'),
    Polygon: mockComponent('Polygon'),
    G: mockComponent('G'),
  };
});
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  clear: jest.fn(() => Promise.resolve()),
}));

jest.mock('jssip', () => {
  class WebSocketInterface {
    constructor() {}
  }
  class UA {
    constructor() {}
    on() {}
    start() {}
    stop() {}
    call() {}
    isRegistered() { return true; }
  }
  return {
    WebSocketInterface,
    UA,
  };
});
// sip.js imports browser-only APIs (WebSocketTransport reads `window.location`)
// that don't exist in Node/Jest. Mock the few symbols we consume.
jest.mock('sip.js', () => {
  const makeUri = (s) => (s && String(s).length ? { user: 'x', host: 'x' } : undefined);
  class Emitter {
    listeners = [];
    addListener = (l) => this.listeners.push(l);
    removeListener = (l) => { this.listeners = this.listeners.filter((x) => x !== l); };
  }
  class UserAgentLike {
    static makeURI = makeUri;
    userId = '';
    instanceId = '';
    contact = {};
    stateChange = new Emitter();
    configuration = {};
    transport = {};
    userAgentCore = { transport: { send: jest.fn(), isConnected: jest.fn(() => false) } };
    constructor(opts = {}) { this.opts = opts; this.state = 'Stop'; this.userId = opts.uri?.user || ''; }
    isConnected = () => false;
    start = jest.fn(() => Promise.resolve());
    stop = jest.fn(() => Promise.resolve());
    register = jest.fn(() => Promise.resolve());
    unregister = jest.fn(() => Promise.resolve());
  }
  class RegistererLike extends Emitter {
    state = 'Terminated';
    constructor(ua, opts) { super(); this.options = opts; this.userAgent = ua; }
    register = jest.fn(() => Promise.resolve());
    unregister = jest.fn(() => Promise.resolve());
    dispose = jest.fn();
  }
  const InvitationLike = class {};
  const SessionLike = class {};
  const InviterLike = class {
    constructor() {}
    invite = jest.fn(() => Promise.resolve());
    cancel = jest.fn(() => Promise.resolve());
    bye = jest.fn(() => Promise.resolve());
  };
  return {
    UserAgent: UserAgentLike,
    Registerer: RegistererLike,
    Invitation: InvitationLike,
    Session: SessionLike,
    Inviter: InviterLike,
  };
});

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(() => Promise.resolve({ assets: [] })),
}));
jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(() => Promise.resolve([])),
  types: { allFiles: '*/*' },
}));
jest.mock('react-native-nitro-sound', () => ({
  __esModule: true,
  default: {
    startRecorder: jest.fn(() => Promise.resolve('')),
    stopRecorder: jest.fn(() => Promise.resolve('')),
    addRecordBackListener: jest.fn(),
    removeRecordBackListener: jest.fn(),
    startPlayer: jest.fn(() => Promise.resolve('')),
    stopPlayer: jest.fn(() => Promise.resolve('')),
  },
}));
jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    config: jest.fn(() => ({ fetch: jest.fn(() => Promise.resolve({ path: () => '' })) })),
    fs: { dirs: { CacheDir: '/tmp' }, stat: jest.fn(() => Promise.resolve({ size: 0 })) },
    android: { actionViewIntent: jest.fn() },
  },
}));
