/**
 * Sokrat Standalone WebRTC Softphone Core Telephony Engine v2.1
 * High-performance PJSIP WebRTC Gateway with Bidirectional Audio & Multi-Window Sync
 */

(function (window) {
    'use strict';

    const DTMF_FREQS = {
        '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
        '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
        '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
        '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633]
    };

    class SokratSoftphoneCore {
        constructor(options = {}) {
            this.options = Object.assign({
                busName: 'sokrat_sp_bus',
                wsKeepAliveInterval: 20000,
                maxReconnectAttempts: 5,
                iceGatheringTimeout: 1500
            }, options);

            // Core State
            this.isOwner = true;
            this.ua = null;
            this.activePreset = null;
            this.regState = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, REGISTERED, RETRY_WAIT, AUTH_FAILED
            this.activeCalls = new Map(); // callId -> CallEntry
            this.nextCallId = 1;
            this.isDnd = false;
            this.isAutoAnswer = false;
            this.selectedAudioInputId = '';
            this.selectedAudioOutputId = '';
            this.isSpeakerMuted = false;
            this.micVolume = 100;
            this.speakerVolume = 100;

            // Audio & Media
            this.audioCtx = null;
            this.micStream = null;
            this.micPermissionGranted = false;
            this.vuAnalyser = null;
            this.vuTimer = null;
            this.remoteAudioEl = null;

            // Ringtones & Sidetones
            this.ringtoneGain = null;
            this.ringtoneOsc = null;
            this.ringtoneTimer = null;
            this.ringbackOsc = null;
            this.ringbackTimer = null;

            // Reconnection & Quality
            this.reconnectTimer = null;
            this.reconnectAttempt = 0;
            this.keepAliveTimer = null;
            this.qualityPoller = null;

            // Attended Transfer State
            this.consultCallPending = null;

            // Event Subscriptions
            this.listeners = new Map();

            // Broadcast Channel for Multi-window Coordination
            this.initBus();
            this.initHardwareListeners();
            this.initLifecycleListeners();
        }

        on(event, callback) {
            if (!this.listeners.has(event)) this.listeners.set(event, []);
            this.listeners.get(event).push(callback);
            return this;
        }

        off(event, callback) {
            if (!this.listeners.has(event)) return this;
            if (!callback) {
                this.listeners.delete(event);
            } else {
                const list = this.listeners.get(event);
                const idx = list.indexOf(callback);
                if (idx !== -1) list.splice(idx, 1);
            }
            return this;
        }

        once(event, callback) {
            const wrapper = (data) => {
                this.off(event, wrapper);
                callback(data);
            };
            return this.on(event, wrapper);
        }

        emit(event, data) {
            const list = this.listeners.get(event);
            if (list && list.length > 0) {
                [...list].forEach(cb => {
                    try { cb(data); } catch (err) { console.error(`[Softphone Event Error] ${event}:`, err); }
                });
            }
        }

        // --- MULTI-WINDOW SINGLE-TAB LEADERSHIP LOCK ---
        initBus() {
            const lineId = this.options.lineId || 'line1';
            this.tabId = `tab_${lineId}_` + Math.random().toString(36).slice(2) + '_' + Date.now();
            this.LOCK_KEY = this.options.lockKey || `sokrat_sp_owner_lock_${lineId}_v2`;
            if (this.options.busName) this.options.busName = this.options.busName;
            else this.options.busName = `sokrat_sp_${lineId}_bus`;

            // Check existing owner in localStorage
            const existingLockStr = localStorage.getItem(this.LOCK_KEY);
            let existingLock = null;
            try {
                existingLock = existingLockStr ? JSON.parse(existingLockStr) : null;
            } catch (_) {}

            const isLockFresh = existingLock && existingLock.tabId !== this.tabId && (Date.now() - existingLock.time < 3500);

            if (isLockFresh) {
                // Another tab is currently active on this device
                this.isOwner = false;
            } else {
                this.claimLeadership();
            }

            try {
                if (typeof BroadcastChannel !== 'undefined') {
                    this.bus = new BroadcastChannel(this.options.busName);
                    this.bus.onmessage = (e) => this.handleBusMessage(e.data);
                    this.bus.postMessage({ type: 'PING_OWNER', fromTab: this.tabId });
                }
            } catch (_) {}

            this.emit('ownerChange', { isOwner: this.isOwner });
            this.startLockHeartbeat();

            window.addEventListener('beforeunload', () => {
                if (this.isOwner) {
                    localStorage.removeItem(this.LOCK_KEY);
                    if (this.bus) this.bus.postMessage({ type: 'OWNER_RELEASED', fromTab: this.tabId });
                }
            });
        }

        claimLeadership() {
            this.isOwner = true;
            try {
                localStorage.setItem(this.LOCK_KEY, JSON.stringify({ tabId: this.tabId, time: Date.now() }));
            } catch (_) {}
        }

        startLockHeartbeat() {
            if (this.lockHeartbeatTimer) clearInterval(this.lockHeartbeatTimer);
            this.lockHeartbeatTimer = setInterval(() => {
                if (this.isOwner && this.ua && this.ua.isConnected()) {
                    try {
                        localStorage.setItem(this.LOCK_KEY, JSON.stringify({ tabId: this.tabId, time: Date.now() }));
                    } catch (_) {}
                } else if (!this.isOwner) {
                    // Check if previous owner abandoned/closed without take over
                    const lockStr = localStorage.getItem(this.LOCK_KEY);
                    let lock = null;
                    try { lock = lockStr ? JSON.parse(lockStr) : null; } catch (_) {}
                    if (!lock || (Date.now() - lock.time > 4500)) {
                        // Owner is gone, automatically allow this tab to take over
                        this.claimLeadership();
                        this.emit('ownerChange', { isOwner: true });
                    }
                }
            }, 1500);
        }

        handleBusMessage(data) {
            if (!data || !data.type) return;
            switch (data.type) {
                case 'PING_OWNER':
                    if (this.isOwner && this.ua && this.ua.isConnected()) {
                        this.claimLeadership();
                        if (this.bus) this.bus.postMessage({ type: 'OWNER_HEARTBEAT', fromTab: this.tabId });
                    }
                    break;
                case 'OWNER_HEARTBEAT':
                    if (data.fromTab !== this.tabId && this.isOwner && (!this.ua || !this.ua.isConnected())) {
                        this.isOwner = false;
                        this.emit('ownerChange', { isOwner: false });
                    }
                    break;
                case 'TAKE_OVER':
                    if (data.fromTab !== this.tabId && this.isOwner) {
                        this.disconnect();
                        this.isOwner = false;
                        this.emit('ownerChange', { isOwner: false });
                    }
                    break;
                case 'OWNER_RELEASED':
                    if (!this.isOwner) {
                        this.claimLeadership();
                        this.emit('ownerChange', { isOwner: true });
                    }
                    break;
                case 'FOCUS_POPOUT':
                    if (window.name === 'sokratSoftphonePopout') {
                        window.focus();
                    }
                    break;
            }
        }

        takeOverOwnership() {
            this.claimLeadership();
            if (this.bus) this.bus.postMessage({ type: 'TAKE_OVER', fromTab: this.tabId });
            this.emit('ownerChange', { isOwner: true });
        }

        // --- AUDIO ENGINE & DSP ---
        initAudioContext() {
            if (!this.audioCtx) {
                const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                if (AudioCtxClass) {
                    this.audioCtx = new AudioCtxClass();
                }
            }
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
        }

        setRemoteAudioElement(el) {
            this.remoteAudioEl = el;
            if (this.remoteAudioEl) {
                this.remoteAudioEl.autoplay = true;
                this.remoteAudioEl.playsInline = true;
                this.remoteAudioEl.muted = Boolean(this.isSpeakerMuted);
                this.remoteAudioEl.volume = this.speakerVolume / 100;
            }
            if (this.selectedAudioOutputId && this.remoteAudioEl && typeof this.remoteAudioEl.setSinkId === 'function') {
                this.remoteAudioEl.setSinkId(this.selectedAudioOutputId).catch(() => {});
            }
        }

        async acquireMicrophone(deviceId = '') {
            this.initAudioContext();
            const constraints = {
                audio: {
                    echoCancellation: { ideal: true },
                    noiseSuppression: { ideal: true },
                    autoGainControl: { ideal: true },
                    channelCount: { ideal: 1 },
                    sampleRate: { ideal: 48000 }
                },
                video: false
            };
            if (deviceId) {
                constraints.audio.deviceId = { exact: deviceId };
            }

            try {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    throw new Error('MediaDevices API is unavailable. Ensure HTTPS connection.');
                }
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                this.micStream = stream;
                this.micPermissionGranted = true;
                this.selectedAudioInputId = deviceId;
                const track = stream.getAudioTracks()[0];
                if (track) {
                    this.activeCalls.forEach(call => {
                        if (call.session && call.session.connection) {
                            try {
                                const senders = call.session.connection.getSenders();
                                const s = senders.find(sd => sd.track && sd.track.kind === 'audio');
                                if (s) s.replaceTrack(track).catch(() => {});
                            } catch (_) {}
                        }
                    });
                }
                this.startVuMeter(stream);
                this.emit('micGranted', { stream, deviceId });
                return stream;
            } catch (err) {
                this.micPermissionGranted = false;
                this.stopVuMeter();
                this.emit('micError', { error: err.message || err.name });
                throw err;
            }
        }

        startVuMeter(stream) {
            this.stopVuMeter();
            if (!this.audioCtx || !stream) return;
            try {
                const source = this.audioCtx.createMediaStreamSource(stream);
                this.vuAnalyser = this.audioCtx.createAnalyser();
                this.vuAnalyser.fftSize = 64;
                source.connect(this.vuAnalyser);

                const dataArray = new Uint8Array(this.vuAnalyser.frequencyBinCount);
                this.vuTimer = setInterval(() => {
                    if (!this.vuAnalyser) return;
                    this.vuAnalyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                    const avg = sum / dataArray.length;
                    const level = Math.min(100, Math.round((avg / 128) * 100));
                    this.emit('vuLevel', level);
                }, 75);
            } catch (_) {}
        }

        startSpeakerVuMeter(stream) {
            this.stopSpeakerVuMeter();
            if (!this.audioCtx || !stream) return;
            try {
                const source = this.audioCtx.createMediaStreamSource(stream);
                this.speakerAnalyser = this.audioCtx.createAnalyser();
                this.speakerAnalyser.fftSize = 64;
                source.connect(this.speakerAnalyser);

                const dataArray = new Uint8Array(this.speakerAnalyser.frequencyBinCount);
                this.speakerVuTimer = setInterval(() => {
                    if (!this.speakerAnalyser) return;
                    this.speakerAnalyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                    const avg = sum / dataArray.length;
                    const level = Math.min(100, Math.round((avg / 128) * 100));
                    this.emit('speakerLevel', level);
                }, 75);
            } catch (_) {}
        }

        stopSpeakerVuMeter() {
            if (this.speakerVuTimer) {
                clearInterval(this.speakerVuTimer);
                this.speakerVuTimer = null;
            }
            this.speakerAnalyser = null;
            this.emit('speakerLevel', 0);
        }

        stopVuMeter() {
            if (this.vuTimer) {
                clearInterval(this.vuTimer);
                this.vuTimer = null;
            }
            this.vuAnalyser = null;
            this.emit('vuLevel', 0);
        }

        async setOutputDevice(deviceId) {
            this.selectedAudioOutputId = deviceId;
            if (this.remoteAudioEl && typeof this.remoteAudioEl.setSinkId === 'function') {
                try {
                    await this.remoteAudioEl.setSinkId(deviceId);
                    this.emit('speakerChanged', { deviceId });
                } catch (err) {
                    this.emit('speakerError', { error: err.message });
                }
            }
        }

        toggleSpeakerMute() {
            this.isSpeakerMuted = !this.isSpeakerMuted;
            if (this.remoteAudioEl) {
                this.remoteAudioEl.muted = this.isSpeakerMuted;
            }
            this.emit('speakerMuteChanged', { isMuted: this.isSpeakerMuted });
            return this.isSpeakerMuted;
        }

        setMicVolume(volumePercent) {
            this.micVolume = Math.max(0, Math.min(100, Number(volumePercent) || 0));
            if (this.micStream) {
                const track = this.micStream.getAudioTracks()[0];
                if (track) {
                    track.enabled = (this.micVolume > 0 && !this.isMuted);
                }
            }
            this.emit('micVolumeChanged', { volume: this.micVolume });
        }

        setSpeakerVolume(volumePercent) {
            this.speakerVolume = Math.max(0, Math.min(100, Number(volumePercent) || 0));
            if (this.remoteAudioEl) {
                this.remoteAudioEl.volume = this.speakerVolume / 100;
            }
            this.emit('speakerVolumeChanged', { volume: this.speakerVolume });
        }

        initHardwareListeners() {
            if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
                navigator.mediaDevices.ondevicechange = async () => {
                    this.emit('deviceChange');
                    if (this.micStream) {
                        const tracks = this.micStream.getAudioTracks();
                        if (tracks.length === 0 || tracks[0].readyState === 'ended') {
                            try {
                                await this.acquireMicrophone(this.selectedAudioInputId);
                            } catch (_) {}
                        }
                    }
                };
            }
        }

        initLifecycleListeners() {
            window.addEventListener('online', () => {
                if (this.isOwner && this.activePreset && this.regState !== 'REGISTERED' && this.regState !== 'AUTH_FAILED') {
                    this.reconnect();
                }
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && this.isOwner && this.activePreset && (!this.ua || !this.ua.isConnected()) && this.regState !== 'AUTH_FAILED') {
                    this.reconnect();
                }
            });
        }

        // --- DTMF & RINGTONES & AUDIO TEST CHIME ---
        playDtmfSidetone(key) {
            this.initAudioContext();
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            const freqs = DTMF_FREQS[String(key).toUpperCase()];
            if (!freqs || !this.audioCtx) return;

            try {
                const now = this.audioCtx.currentTime;
                const osc1 = this.audioCtx.createOscillator();
                const osc2 = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();

                osc1.type = 'sine';
                osc1.frequency.value = freqs[0];
                osc2.type = 'sine';
                osc2.frequency.value = freqs[1];

                gain.gain.setValueAtTime(0.18, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(this.audioCtx.destination);

                osc1.start(now);
                osc2.start(now);
                osc1.stop(now + 0.18);
                osc2.stop(now + 0.18);
            } catch (_) {}
        }

        playTestChime() {
            this.initAudioContext();
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                this.audioCtx.resume().catch(() => {});
            }
            if (!this.audioCtx) return;

            try {
                const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 (Ascending Bell Chime)
                const startTime = this.audioCtx.currentTime;

                notes.forEach((freq, idx) => {
                    const noteTime = startTime + (idx * 0.13);
                    const osc = this.audioCtx.createOscillator();
                    const osc2 = this.audioCtx.createOscillator();
                    const gain = this.audioCtx.createGain();

                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(freq, noteTime);

                    osc2.type = 'triangle';
                    osc2.frequency.setValueAtTime(freq * 2, noteTime);

                    gain.gain.setValueAtTime(0, noteTime);
                    gain.gain.linearRampToValueAtTime(0.28, noteTime + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.40);

                    osc.connect(gain);
                    osc2.connect(gain);
                    gain.connect(this.audioCtx.destination);

                    osc.start(noteTime);
                    osc2.start(noteTime);
                    osc.stop(noteTime + 0.42);
                    osc2.stop(noteTime + 0.42);
                });
            } catch (err) {
                console.warn('Audio test chime error:', err);
            }
        }

                startRingtone() {
            this.stopRingtone();
            this.stopRingback();
            this.initAudioContext();
            if (!this.audioCtx) return;

            try {
                if (this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume().catch(() => {});
                }

                if (!this.activeRingtoneNodes) {
                    this.activeRingtoneNodes = new Set();
                }

                this.masterRingtoneGain = this.audioCtx.createGain();
                this.masterRingtoneGain.gain.setValueAtTime(0.22, this.audioCtx.currentTime);
                this.masterRingtoneGain.connect(this.audioCtx.destination);

                const playRingBurst = () => {
                    if (!this.audioCtx || !this.masterRingtoneGain) return;
                    try {
                        const now = this.audioCtx.currentTime;
                        const osc1 = this.audioCtx.createOscillator();
                        const osc2 = this.audioCtx.createOscillator();
                        osc1.type = 'sine';
                        osc2.type = 'sine';
                        osc1.frequency.value = 440;
                        osc2.frequency.value = 480;

                        const burstGain = this.audioCtx.createGain();
                        burstGain.gain.setValueAtTime(0, now);
                        burstGain.gain.linearRampToValueAtTime(0.25, now + 0.04);
                        burstGain.gain.setValueAtTime(0.25, now + 1.8);
                        burstGain.gain.linearRampToValueAtTime(0, now + 2.0);

                        osc1.connect(burstGain);
                        osc2.connect(burstGain);
                        burstGain.connect(this.masterRingtoneGain);

                        this.activeRingtoneNodes.add(osc1);
                        this.activeRingtoneNodes.add(osc2);
                        this.activeRingtoneNodes.add(burstGain);

                        osc1.onended = () => {
                            this.activeRingtoneNodes.delete(osc1);
                            this.activeRingtoneNodes.delete(osc2);
                            this.activeRingtoneNodes.delete(burstGain);
                        };

                        osc1.start(now);
                        osc2.start(now);
                        osc1.stop(now + 2.0);
                        osc2.stop(now + 2.0);
                    } catch (_) {}
                };

                playRingBurst();
                this.ringtoneTimer = setInterval(playRingBurst, 3500);
            } catch (_) {}
        }

        stopRingtone() {
            if (this.ringtoneTimer) {
                clearInterval(this.ringtoneTimer);
                this.ringtoneTimer = null;
            }

            if (this.masterRingtoneGain) {
                try {
                    if (this.audioCtx) {
                        this.masterRingtoneGain.gain.cancelScheduledValues(0);
                        this.masterRingtoneGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
                    }
                    this.masterRingtoneGain.disconnect();
                } catch (_) {}
                this.masterRingtoneGain = null;
            }

            if (this.activeRingtoneNodes) {
                this.activeRingtoneNodes.forEach(node => {
                    try {
                        if (typeof node.stop === 'function') node.stop();
                        if (typeof node.disconnect === 'function') node.disconnect();
                    } catch (_) {}
                });
                this.activeRingtoneNodes.clear();
            }
        }

        startRingback() {
            this.stopRingback();
            this.stopRingtone();
            this.initAudioContext();
            if (!this.audioCtx) return;

            try {
                if (this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume().catch(() => {});
                }

                // Single pair of continuous oscillators — never recreated, so
                // stop() is guaranteed to be called exactly once in stopRingback().
                const gain = this.audioCtx.createGain();
                gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
                gain.connect(this.audioCtx.destination);

                const osc1 = this.audioCtx.createOscillator();
                const osc2 = this.audioCtx.createOscillator();
                osc1.type = 'sine';
                osc2.type = 'sine';
                osc1.frequency.value = 440;
                osc2.frequency.value = 480;
                osc1.connect(gain);
                osc2.connect(gain);
                osc1.start();
                osc2.start();

                this._rbGain = gain;
                this._rbOsc1 = osc1;
                this._rbOsc2 = osc2;

                // US ringback cadence: 2 s on, 4 s off (tick every 2 s toggles)
                let on = false;
                const tick = () => {
                    on = !on;
                    try {
                        if (this._rbGain && this.audioCtx) {
                            this._rbGain.gain.setValueAtTime(on ? 0.15 : 0, this.audioCtx.currentTime);
                        }
                    } catch (_) {}
                };
                tick(); // first tick turns sound on immediately
                this.ringbackTimer = setInterval(tick, 2000);
            } catch (_) {}
        }

        stopRingback() {
            if (this.ringbackTimer) {
                clearInterval(this.ringbackTimer);
                this.ringbackTimer = null;
            }
            // Stop the two oscillators — each in its own try-catch.
            if (this._rbOsc1) {
                try { this._rbOsc1.stop(); } catch (_) {}
                try { this._rbOsc1.disconnect(); } catch (_) {}
                this._rbOsc1 = null;
            }
            if (this._rbOsc2) {
                try { this._rbOsc2.stop(); } catch (_) {}
                try { this._rbOsc2.disconnect(); } catch (_) {}
                this._rbOsc2 = null;
            }
            if (this._rbGain) {
                try { this._rbGain.gain.setValueAtTime(0, 0); } catch (_) {}
                try { this._rbGain.disconnect(); } catch (_) {}
                this._rbGain = null;
            }
            // Legacy cleanup — belt-and-suspenders for any leftover nodes
            if (this.masterRingbackGain) {
                try { this.masterRingbackGain.disconnect(); } catch (_) {}
                this.masterRingbackGain = null;
            }
            if (this.activeRingbackNodes) {
                this.activeRingbackNodes.forEach(node => {
                    try { if (typeof node.stop === 'function') node.stop(0); } catch (_) {}
                    try { if (typeof node.disconnect === 'function') node.disconnect(); } catch (_) {}
                });
                this.activeRingbackNodes.clear();
            }
        }

        // --- SIP REGISTRATION & LIFECYCLE ---
        async connect(preset, secret) {
            if (!preset || !preset.extension) {
                throw new Error('Invalid account configuration: missing extension.');
            }
            if (!preset.sipDomain) preset.sipDomain = preset.domain || window.location.hostname || '127.0.0.1';
            if (!preset.wssUrl) preset.wssUrl = preset.wss || `wss://${preset.sipDomain}:8089/ws`;
            if (!secret) {
                throw new Error('Extension password is required.');
            }

            this.takeOverOwnership();
            this.disconnect();
            this.activePreset = preset;
            this.isDnd = Boolean(preset.dnd);
            this.isAutoAnswer = Boolean(preset.autoAnswer);
            if (!this.micPermissionGranted) {
                try {
                    await this.acquireMicrophone(this.selectedAudioInputId);
                } catch (micErr) {
                    console.warn('Microphone permission ignored, proceeding with registration:', micErr);
                }
            }

            this.setRegState('CONNECTING');
            this.reconnectAttempt = 0;

            if (typeof JsSIP === 'undefined') {
                this.setRegState('DISCONNECTED');
                throw new Error('JsSIP library failed to load.');
            }

            try {
                const host = window.location.hostname || '127.0.0.1';
                const portStr = (window.location.port === '8443') ? ':8443' : (window.location.port ? ':' + window.location.port : '');
                const defaultWss = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + host + portStr + '/ws';
                const wssUrl = preset.wssUrl || defaultWss;
                const sipDomain = preset.sipDomain || host;

                const socket = new JsSIP.WebSocketInterface(wssUrl);
                const configuration = {
                    sockets: [socket],
                    uri: `sip:${preset.extension}@${sipDomain}`,
                    password: secret,
                    register: true,
                    register_expires: 120,
                    session_timers: false
                };

                this.ua = new JsSIP.UA(configuration);
                this.attachUaListeners(this.ua, preset);
                this.ua.start();
                this.startKeepAlive();
            } catch (err) {
                this.setRegState('DISCONNECTED');
                throw err;
            }
        }

        attachUaListeners(ua, preset) {
            ua.on('connecting', () => this.setRegState('CONNECTING'));
            ua.on('connected', () => {
                this.reconnectAttempt = 0;
            });
            ua.on('registered', () => {
                this.setRegState('REGISTERED');
                this.emit('registered', { preset });
            });
            ua.on('unregistered', () => {
                this.setRegState('DISCONNECTED');
                this.emit('unregistered');
            });
            ua.on('registrationFailed', (e) => {
                const code = e.response ? e.response.status_code : 0;
                if (code === 401 || code === 403) {
                    this.setRegState('AUTH_FAILED');
                    this.emit('authFailed', { code, reason: 'Invalid Extension or Password' });
                    this.disconnect(true);
                } else {
                    this.setRegState('RETRY_WAIT');
                    this.scheduleReconnect();
                }
            });
            ua.on('disconnected', () => {
                if (this.regState !== 'AUTH_FAILED' && this.regState !== 'DISCONNECTED') {
                    this.setRegState('RETRY_WAIT');
                    this.scheduleReconnect();
                }
            });
            ua.on('newRTCSession', (data) => this.handleNewRTCSession(data.session));
        }

        setRegState(state) {
            this.regState = state;
            this.emit('regStateChange', { state, preset: this.activePreset });
        }

        scheduleReconnect() {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            if (this.regState === 'AUTH_FAILED' || !this.activePreset) return;

            this.reconnectAttempt++;
            const backoffSec = Math.min(30, Math.pow(2, Math.min(5, this.reconnectAttempt)));
            this.emit('retryCountdown', { seconds: backoffSec, attempt: this.reconnectAttempt });

            this.reconnectTimer = setTimeout(() => {
                if (this.ua && !this.ua.isConnected() && this.regState !== 'AUTH_FAILED') {
                    try { this.ua.start(); } catch (_) {}
                }
            }, backoffSec * 1000);
        }

        reconnect() {
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            if (this.ua && this.regState !== 'AUTH_FAILED') {
                try { this.ua.start(); } catch (_) {}
            }
        }

        disconnect(preserveAuthFailed = false) {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.stopKeepAlive();
            this.hangupAllCalls();
            if (this.ua) {
                try {
                    this.ua.stop();
                } catch (_) {}
                this.ua = null;
            }
            if (!preserveAuthFailed) {
                this.setRegState('DISCONNECTED');
            }
        }

        startKeepAlive() {
            this.stopKeepAlive();
            this.keepAliveTimer = setInterval(() => {
                if (this.ua && this.ua.isConnected() && this.ua.transport && this.ua.transport.socket) {
                    try {
                        this.ua.transport.socket.send('\r\n\r\n');
                    } catch (_) {}
                }
            }, this.options.wsKeepAliveInterval);
        }

        stopKeepAlive() {
            if (this.keepAliveTimer) {
                clearInterval(this.keepAliveTimer);
                this.keepAliveTimer = null;
            }
        }

        // --- BIDIRECTIONAL MEDIA & CALL TELEPHONY ENGINE ---
        handleNewRTCSession(session) {
            const callId = 'call_' + (this.nextCallId++);
            const isIncoming = session.direction === 'incoming';
            const remoteUser = session.remote_identity ? (session.remote_identity.uri.user || session.remote_identity.display_name || 'Unknown') : 'Unknown';

            // DND & Busy Rejections (SIP 486)
            if (isIncoming) {
                if (this.isDnd) {
                    session.terminate({ status_code: 486, reason_phrase: 'Busy Here (DND)' });
                    this.emit('callLog', { target: remoteUser, direction: 'incoming', status: 'rejected_dnd', durationSec: 0 });
                    return;
                }
                if (this.activeCalls.size > 0) {
                    session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
                    this.emit('callLog', { target: remoteUser, direction: 'incoming', status: 'busy', durationSec: 0 });
                    return;
                }
            }

            const callEntry = {
                id: callId,
                session: session,
                direction: isIncoming ? 'incoming' : 'outgoing',
                target: remoteUser,
                status: isIncoming ? 'ringing' : 'progress',
                startTime: Date.now(),
                answerTime: null,
                isHeld: false,
                isMuted: false,
                recordingDetected: false,
                progressTimer: null,
                recordingPoller: null
            };

            this.activeCalls.set(callId, callEntry);
            this.attachSessionListeners(session, callEntry);

            if (isIncoming) {
                this.startRingtone();
                this.emit('incomingCall', callEntry);

                if (this.isAutoAnswer && this.micPermissionGranted) {
                    setTimeout(() => {
                        this.answerCall(callId);
                    }, 400);
                }
            } else {
                this.startRingback();
                this.startTrunkPoller(callEntry);
                this.emit('callProgress', callEntry);
            }
        }

        attachSessionListeners(session, callEntry) {
            // Helper: attach track/ICE listeners to a PeerConnection
            const bindPc = (pc) => {
                if (!pc || pc._sokrat_bound) return;
                pc._sokrat_bound = true;
                console.log('[SokratCore] Binding track listener to PeerConnection');
                pc.addEventListener('track', (event) => {
                    console.log('[SokratCore] track event fired, track kind:', event.track?.kind, 'readyState:', event.track?.readyState);
                    if (this.remoteAudioEl) {
                        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
                        this.remoteAudioEl.srcObject = stream;
                        this.remoteAudioEl.play().catch(() => {});
                        this.stopRingback();
                        this.startSpeakerVuMeter(stream);
                    }
                });
                pc.addEventListener('iceconnectionstatechange', () => {
                    console.log('[SokratCore] ICE state:', pc.iceConnectionState);
                });
            };

            // For outgoing calls, session.connection already exists by the time
            // handleNewRTCSession fires (JsSIP creates it during ua.call()).
            // The 'peerconnection' event was already emitted and missed.
            if (session.connection) {
                bindPc(session.connection);
            }

            // For incoming calls (or future re-INVITEs), listen for peerconnection
            session.on('peerconnection', (data) => {
                bindPc(data.peerconnection);
            });

            session.on('sdp', (data) => {
                console.log('[SokratCore] SDP event:', data.originator, data.type, 'body length:', data.sdp?.length);
            });

            session.on('progress', (e) => {
                console.log('[SokratCore] progress event, status:', e?.response?.status_code, 'hasBody:', !!e?.response?.body);
                if (callEntry.direction === 'outgoing') {
                    callEntry.status = 'progress';
                }
                this.emit('callUpdated', callEntry);
            });

            session.on('confirmed', () => {
                this.stopRingtone();
                this.stopRingback();
                if (callEntry.progressTimer) {
                    clearTimeout(callEntry.progressTimer);
                    callEntry.progressTimer = null;
                }
                callEntry.status = 'active';
                callEntry.answerTime = Date.now();

                // Secondary fallback track attachment from connection receivers
                if (session.connection && this.remoteAudioEl && (!this.remoteAudioEl.srcObject || !this.remoteAudioEl.srcObject.active)) {
                    const remoteStream = new MediaStream();
                    session.connection.getReceivers().forEach(receiver => {
                        if (receiver.track && receiver.track.kind === 'audio') {
                            remoteStream.addTrack(receiver.track);
                        }
                    });
                    this.remoteAudioEl.srcObject = remoteStream;
                    this.remoteAudioEl.play().catch(() => {});
                    this.startSpeakerVuMeter(remoteStream);
                }

                this.startQualityMetricsPoller(session);
                this.checkRecordingStatus(callEntry);
                this.emit('callAnswered', callEntry);
            });

            session.on('hold', () => {
                callEntry.isHeld = true;
                callEntry.status = 'held';
                this.emit('callUpdated', callEntry);
            });

            session.on('unhold', () => {
                callEntry.isHeld = false;
                callEntry.status = 'active';
                this.emit('callUpdated', callEntry);
            });

            session.on('ended', () => {
                this.stopRingback();
                this.handleCallEnd(callEntry, 'answered');
            });
            session.on('failed', (e) => {
                this.stopRingback();
                const statusCode = e && e.response ? e.response.status_code : null;
                const cause = (e && e.cause) ? e.cause : (statusCode || 'failed');
                const isAr = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'ar');
                let userMsg = isAr ? `انتهت المكالمة: ${cause}` : `Call ended: ${cause}`;

                if (statusCode === 603 || cause === 'Rejected' || cause === 'Declined' || cause === 'Decline') {
                    userMsg = isAr ? `تم رفض المكالمة من ${callEntry.target}` : `Call Declined by ${callEntry.target}`;
                } else if (statusCode === 486 || cause === 'Busy') {
                    userMsg = isAr ? `الرقم ${callEntry.target} مشغول` : `Extension ${callEntry.target} is Busy`;
                } else if (statusCode === 480 || cause === 'Unavailable') {
                    userMsg = isAr ? `الرقم ${callEntry.target} غير متاح` : `Extension ${callEntry.target} is Unavailable`;
                } else if (statusCode === 404 || cause === 'Not Found') {
                    userMsg = isAr ? `الرقم ${callEntry.target} غير موجود` : `Extension ${callEntry.target} Not Found`;
                } else if (statusCode === 487 || cause === 'Canceled' || cause === 'Cancelled') {
                    userMsg = isAr ? `تم إلغاء المكالمة` : `Call Cancelled`;
                } else if (statusCode === 408 || cause === 'Request Timeout') {
                    userMsg = isAr ? `انتهت مهلة الاتصال` : `Call Timed Out`;
                } else if (statusCode === 488 || cause === 'User Denied Media Access' || cause === 'Not Acceptable Here') {
                    userMsg = isAr ? `خطأ في إعدادات الوسائط: ${cause}` : `Media negotiation error: ${cause}`;
                }

                this.emit('toast', { type: 'warning', message: userMsg });
                const outcome = callEntry.answerTime ? 'answered' : (typeof cause === 'string' ? cause.toLowerCase() : String(cause));
                this.handleCallEnd(callEntry, outcome);
            });

            // Call progress timeout — if no answer within 60s, auto-terminate
            if (callEntry.status === 'progress' || callEntry.status === 'ringing') {
                callEntry.progressTimer = setTimeout(() => {
                    if (callEntry.status === 'progress' || callEntry.status === 'ringing') {
                        try { session.terminate({ status_code: 408, reason_phrase: 'Request Timeout' }); } catch (_) {}
                        this.emit('toast', { type: 'warning', message: 'Call timed out — no answer after 60s' });
                    }
                }, 60000);
            }
        }

        handleCallEnd(callEntry, outcome) {
            this.stopRingtone();
            this.stopRingback();
            this.stopTrunkPoller();
            this.stopQualityMetricsPoller();
            if (callEntry.progressTimer) {
                clearTimeout(callEntry.progressTimer);
                callEntry.progressTimer = null;
            }
            if (callEntry.recordingPoller) {
                clearInterval(callEntry.recordingPoller);
                callEntry.recordingPoller = null;
            }

            const durationSec = callEntry.answerTime ? Math.round((Date.now() - callEntry.answerTime) / 1000) : 0;
            this.activeCalls.delete(callEntry.id);

            if (this.activeCalls.size === 0) {
                if (this.remoteAudioEl) {
                    try {
                        this.remoteAudioEl.pause();
                        if (this.remoteAudioEl.srcObject && typeof this.remoteAudioEl.srcObject.getTracks === 'function') {
                            this.remoteAudioEl.srcObject.getTracks().forEach(t => {
                                try { t.stop(); } catch (_) {}
                            });
                        }
                    } catch (_) {}
                    this.remoteAudioEl.srcObject = null;
                }
                this.stopSpeakerVuMeter();
            }

            this.emit('callEnded', { callId: callEntry.id, target: callEntry.target, durationSec, outcome });
            this.emit('callLog', {
                target: callEntry.target,
                direction: callEntry.direction,
                status: outcome,
                durationSec,
                timestamp: new Date().toISOString()
            });
        }

        // Poll server for trunk channel state during outgoing calls.
        // When the GSM trunk drops (callee declined), terminate the call
        // since chan_dongle won't signal it back via SIP.
        startTrunkPoller(callEntry) {
            this.stopTrunkPoller();
            // Wait 3 s before first poll — let Dial() establish the trunk channel
            this._trunkPollDelay = setTimeout(() => {
                this._trunkPoller = setInterval(async () => {
                    try {
                        const base = (typeof window !== 'undefined' && window.location)
                            ? window.location.pathname.replace(/\/[^/]*$/, '/')
                            : '/';
                        const resp = await fetch(base + 'api/trunk-call-state');
                        const data = await resp.json();
                        // Caller channel is up but trunk is gone → callee declined
                        if (data.callerActive && !data.trunkActive) {
                            this.stopTrunkPoller();
                            const isAr = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'ar');
                            this.emit('toast', {
                                type: 'warning',
                                message: isAr ? `تم رفض المكالمة من ${callEntry.target}` : `Call Declined by ${callEntry.target}`
                            });
                            try { callEntry.session.terminate(); } catch (_) {}
                            this.handleCallEnd(callEntry, 'declined');
                        }
                    } catch (_) {}
                }, 2000);
            }, 3000);
        }

        stopTrunkPoller() {
            if (this._trunkPollDelay) {
                clearTimeout(this._trunkPollDelay);
                this._trunkPollDelay = null;
            }
            if (this._trunkPoller) {
                clearInterval(this._trunkPoller);
                this._trunkPoller = null;
            }
        }

        makeCall(targetNumber) {
            if (!this.ua || !this.ua.isConnected()) {
                throw new Error('Softphone is offline. Connect to extension first.');
            }
            if (this.activeCalls.size > 0 && !this.consultCallPending) {
                throw new Error('A call is already active on this line.');
            }
            const cleanTarget = String(targetNumber).trim();
            if (!cleanTarget) throw new Error('Target number cannot be empty.');
            this.initAudioContext();

            const options = {
                mediaConstraints: { audio: true, video: false },
                rtcOfferConstraints: {
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: false
                },
                pcConfig: {
                    // LAN-only: empty iceServers — host candidates are sufficient.
                    // For WAN/remote, restore: { urls: 'stun:stun.l.google.com:19302' }
                    iceServers: [],
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require'
                },
                iceGatheringTimeout: this.options.iceGatheringTimeout,
                sessionTimersExpires: 120
            };

            // Pass already-acquired mic stream to avoid redundant getUserMedia
            if (this.micStream && this.micStream.active) {
                options.mediaStream = this.micStream;
            }

            try {
                this.ua.call(`sip:${cleanTarget}@${this.activePreset.sipDomain}`, options);
            } catch (err) {
                this.stopRingback();
                throw err;
            }
        }

        answerCall(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;
            this.stopRingtone();
            this.initAudioContext();

            const answerOpts = {
                mediaConstraints: { audio: true, video: false },
                pcConfig: {
                    // LAN-only: empty iceServers — host candidates are sufficient.
                    iceServers: [],
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require'
                },
                iceGatheringTimeout: this.options.iceGatheringTimeout
            };

            // Pass already-acquired mic stream
            if (this.micStream && this.micStream.active) {
                answerOpts.mediaStream = this.micStream;
            }

            callEntry.session.answer(answerOpts);
        }


                hangupCall(callId) {
            this.stopRingback();
            this.stopRingtone();

            const callEntry = this.activeCalls.get(callId);
            if (!callEntry) return;

            if (callEntry.progressTimer) {
                clearTimeout(callEntry.progressTimer);
                callEntry.progressTimer = null;
            }

            if (callEntry.session) {
                try {
                    if (callEntry.direction === 'incoming' && !callEntry.answerTime) {
                        callEntry.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
                    } else {
                        callEntry.session.terminate();
                    }
                } catch (_) {}
            }

            this.handleCallEnd(callEntry, callEntry.answerTime ? 'answered' : 'declined');
        }

        hangupAllCalls() {
            this.stopRingback();
            this.stopRingtone();
            this.activeCalls.forEach(call => {
                try { call.session.terminate(); } catch (_) {}
            });
            this.activeCalls.clear();
            if (this.remoteAudioEl) {
                try {
                    this.remoteAudioEl.pause();
                    if (this.remoteAudioEl.srcObject && typeof this.remoteAudioEl.srcObject.getTracks === 'function') {
                        this.remoteAudioEl.srcObject.getTracks().forEach(t => {
                            try { t.stop(); } catch (_) {}
                        });
                    }
                } catch (_) {}
                this.remoteAudioEl.srcObject = null;
            }
            this.stopSpeakerVuMeter();
        }

        toggleMute(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;

            if (callEntry.isMuted) {
                callEntry.session.unmute({ audio: true });
                callEntry.isMuted = false;
            } else {
                callEntry.session.mute({ audio: true });
                callEntry.isMuted = true;
            }
            this.emit('callUpdated', callEntry);
        }

        toggleHold(callId) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) return;

            if (callEntry.isHeld) {
                callEntry.session.unhold();
            } else {
                callEntry.session.hold();
            }
        }

        sendDtmf(callId, digit) {
            const callEntry = this.activeCalls.get(callId);
            if (callEntry && callEntry.session && callEntry.status === 'active') {
                try {
                    callEntry.session.sendDTMF(digit);
                } catch (_) {}
            }
            this.playDtmfSidetone(digit);
        }

        sendDtmfSequence(callEntry, sequence) {
            if (!callEntry || !callEntry.session) return;
            const digits = String(sequence).split('');
            digits.forEach((d, idx) => {
                setTimeout(() => {
                    try {
                        callEntry.session.sendDTMF(d);
                        this.playDtmfSidetone(d);
                    } catch (_) {}
                }, idx * 160);
            });
        }

        blindTransfer(callId, targetNumber) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) throw new Error('No active call to transfer.');
            const target = String(targetNumber).trim().replace(/[^\d+*#]/g, '');
            if (!target) throw new Error('Target extension is required.');

            const rawHost = (this.activePreset && this.activePreset.sipDomain) ? this.activePreset.sipDomain : (window.location.hostname || '127.0.0.1');
            const host = rawHost.split(':')[0];
            const targetUri = `sip:${target}@${host}`;
            const ext = (this.activePreset && this.activePreset.extension) ? this.activePreset.extension : '150';
            const contactHeader = (this.ua && this.ua.contact) ? this.ua.contact.toString() : `<sip:${ext}@${host}>`;

            const isAr = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'ar');
            const transferredMsg = isAr ? `تم التحويل إلى ${target}` : `Transferred to ${target}`;

            const cleanupAndNotify = () => {
                this.emit('toast', { type: 'success', message: transferredMsg });
                this.handleCallEnd(callEntry, 'transferred');
            };

            try {
                callEntry.session.refer(targetUri, {
                    extraHeaders: [
                        `Contact: ${contactHeader}`
                    ],
                    eventHandlers: {
                        requestSucceeded: () => {
                            cleanupAndNotify();
                        },
                        requestFailed: (e) => {
                            console.warn('[SokratCore] SIP REFER rejected, falling back to Asterisk DTMF transfer (##)...', e);
                            try {
                                this.sendDtmfSequence(callEntry, `##${target}`);
                                cleanupAndNotify();
                            } catch (dtmfErr) {
                                const cause = e ? (e.cause || 'Rejected') : 'Transfer failed';
                                this.emit('toast', { type: 'error', message: `Transfer failed: ${cause}` });
                            }
                        }
                    }
                });
            } catch (err) {
                // Direct DTMF fallback if refer() throws
                try {
                    this.sendDtmfSequence(callEntry, `##${target}`);
                    cleanupAndNotify();
                } catch (dtmfErr) {
                    this.emit('toast', { type: 'error', message: `Transfer error: ${err.message}` });
                    throw err;
                }
            }
        }

        // --- ATTENDED TRANSFER ---
        attendedTransfer(callId, targetNumber) {
            const callEntry = this.activeCalls.get(callId);
            if (!callEntry || !callEntry.session) throw new Error('No active call to transfer.');
            const target = String(targetNumber).trim().replace(/[^\d+*#]/g, '');
            if (!target) throw new Error('Target extension is required.');

            // Hold current call before consultation
            if (!callEntry.isHeld) {
                try {
                    callEntry.session.hold();
                    callEntry.isHeld = true;
                    this.emit('callUpdated', callEntry);
                } catch (_) {}
            }
            this.consultCallPending = { originalCallId: callId, target };
            this.makeCall(target);
        }

        completeAttendedTransfer() {
            if (!this.consultCallPending) return;
            const origEntry = this.activeCalls.get(this.consultCallPending.originalCallId);
            const consultEntry = Array.from(this.activeCalls.values()).find(c => c.id !== this.consultCallPending.originalCallId);
            const target = this.consultCallPending.target || 'target';
            const isAr = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'ar');
            const transferredMsg = isAr ? `تم التحويل إلى ${target}` : `Transferred to ${target}`;

            const cleanupAndNotify = () => {
                this.emit('toast', { type: 'success', message: transferredMsg });
                if (origEntry) this.handleCallEnd(origEntry, 'transferred');
                if (consultEntry) this.handleCallEnd(consultEntry, 'transferred');
            };

            if (origEntry && consultEntry && origEntry.session && consultEntry.session) {
                try {
                    const rawHost = (this.activePreset && this.activePreset.sipDomain) ? this.activePreset.sipDomain : (window.location.hostname || '127.0.0.1');
                    const host = rawHost.split(':')[0];
                    const ext = (this.activePreset && this.activePreset.extension) ? this.activePreset.extension : '150';
                    const contactHeader = (this.ua && this.ua.contact) ? this.ua.contact.toString() : `<sip:${ext}@${host}>`;
                    const targetUri = consultEntry.session.remote_identity.uri.toString();

                    origEntry.session.refer(targetUri, {
                        replaces: consultEntry.session,
                        extraHeaders: [
                            `Contact: ${contactHeader}`
                        ],
                        eventHandlers: {
                            requestSucceeded: () => {
                                cleanupAndNotify();
                            },
                            requestFailed: (e) => {
                                const cause = e ? (e.cause || 'Rejected') : 'Transfer failed';
                                this.emit('toast', { type: 'error', message: `Attended transfer failed: ${cause}` });
                            }
                        }
                    });
                } catch (err) {
                    this.emit('toast', { type: 'error', message: `Transfer error: ${err.message}` });
                }
            }
            this.consultCallPending = null;
        }

        cancelAttendedTransfer() {
            if (!this.consultCallPending) return;
            const origEntry = this.activeCalls.get(this.consultCallPending.originalCallId);
            const consultEntry = Array.from(this.activeCalls.values()).find(c => c.id !== this.consultCallPending.originalCallId);

            if (consultEntry && consultEntry.session) {
                try { consultEntry.session.terminate(); } catch (_) {}
            }
            if (origEntry && origEntry.session && origEntry.isHeld) {
                try {
                    origEntry.session.unhold();
                    origEntry.isHeld = false;
                    this.emit('callUpdated', origEntry);
                } catch (_) {}
            }
            this.consultCallPending = null;
        }

        // --- CALL RECORDING DETECTION ---
        checkRecordingStatus(callEntry) {
            if (!callEntry || !callEntry.session) return;
            // Poll for recording indicators via SIP session info headers
            // Asterisk MixMonitor sets Record: on — detected via SIP INFO or re-INVITE headers
            callEntry.recordingPoller = setInterval(() => {
                if (!callEntry.session || callEntry.status !== 'active') {
                    if (callEntry.recordingPoller) {
                        clearInterval(callEntry.recordingPoller);
                        callEntry.recordingPoller = null;
                    }
                    return;
                }
                // Check last incoming request headers for recording indicators
                try {
                    const lastReq = callEntry.session.last_provisional_response ||
                                    callEntry.session._dialog && callEntry.session._dialog.last_response;
                    if (lastReq) {
                        const recordHeader = lastReq.getHeader && lastReq.getHeader('Record');
                        const wasRecording = callEntry.recordingDetected;
                        callEntry.recordingDetected = (recordHeader && recordHeader.toLowerCase() === 'on');
                        if (callEntry.recordingDetected !== wasRecording) {
                            this.emit('recordingStatus', {
                                callId: callEntry.id,
                                isRecording: callEntry.recordingDetected
                            });
                        }
                    }
                } catch (_) {}
            }, 5000);
        }

        // --- WEBRTC STATS & QUALITY METRICS ---
        startQualityMetricsPoller(session) {
            this.stopQualityMetricsPoller();
            if (!session || !session.connection) return;

            this.qualityPoller = setInterval(async () => {
                try {
                    const stats = await session.connection.getStats();
                    let jitterMs = 0;
                    let packetsLost = 0;
                    let totalPackets = 0;

                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                            jitterMs = Math.round((report.jitter || 0) * 1000);
                            packetsLost = report.packetsLost || 0;
                            totalPackets = (report.packetsReceived || 0) + packetsLost;
                        }
                    });

                    const lossPercent = totalPackets > 0 ? ((packetsLost / totalPackets) * 100).toFixed(1) : 0;
                    let quality = 'excellent';
                    if (lossPercent > 5 || jitterMs > 60) quality = 'poor';
                    else if (lossPercent > 2 || jitterMs > 30) quality = 'good';

                    this.emit('callQuality', { jitterMs, lossPercent, quality });
                } catch (_) {}
            }, 2500);
        }

        stopQualityMetricsPoller() {
            if (this.qualityPoller) {
                clearInterval(this.qualityPoller);
                this.qualityPoller = null;
            }
            this.emit('callQuality', null);
        }

        destroy() {
            this.disconnect();
            if (this.lockHeartbeatTimer) {
                clearInterval(this.lockHeartbeatTimer);
                this.lockHeartbeatTimer = null;
            }
            if (this.bus && typeof this.bus.close === 'function') {
                this.bus.close();
                this.bus = null;
            }
            if (this.audioCtx) {
                try { this.audioCtx.close(); } catch (_) {}
                this.audioCtx = null;
            }
            this.listeners.clear();
        }
    }

    window.SokratSoftphoneCore = SokratSoftphoneCore;

})(window);
