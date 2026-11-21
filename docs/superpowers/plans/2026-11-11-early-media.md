# Early Media and Outgoing Ringback Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Write a failing test before each change (`skill://test-driven`) and cite fresh evidence before claiming a task done (`skill://verification-before-completion`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore audible outgoing call progress: play carrier early media when available, never discard a valid provisional SDP, and fall back to local ringback instead of silence.

**Architecture:** Keep JsSIP and react-native-webrtc as the SIP/WebRTC stack. Stop mutating remote SDP on outbound calls, retain provisional SDP until the local description exists, retry applying it once, and add a local ringback fallback that stops as soon as a remote audio track or final answer arrives.

**Tech Stack:** React Native, TypeScript, JsSIP 3.13.8, react-native-webrtc 124, react-native-incall-manager, Jest.

**Spec:** This plan implements the findings from the live PBX trace and Android capture in the current session; no separate design document exists.

## Evidence

- PBX `183 Session Progress` contains a valid SDP:
  - `m=audio 19462 UDP/TLS/RTP/SAVPF 0 126`
  - `a=rtpmap:0 PCMU/8000`
  - `a=rtpmap:126 telephone-event/8000`
  - `a=setup:active`
  - ICE ufrag/pwd and DTLS fingerprint present
  - `a=sendrecv`
- App log at the same time:
  - `peerconnection:setremotedescriptionfailed` twice
  - first `createOffer` only at final answer, ~23 seconds after dialing
- The PBX is not suppressing early media; `R` is present in the Dial options and `app_dial` reports progress.
- The app also has no local ringback fallback; the previous `startOutgoingRingback()` call was removed.

## Global Constraints

- Do not change PBX, gateway, TURN, dongle, or SIP routing for this plan.
- Preserve relay-only media: never send an SDP without a `typ relay` candidate for gateway calls.
- Do not add dependencies.
- Keep `minSdk 24` and `targetSdk 36`.
- Do not commit unless the user explicitly asks.
- Run focused Jest tests with `npx jest --runInBand --silent`.

## Review Focus

1. A valid `183` answer with PCMU/telephone-event must not be rewritten or rejected.
2. Early SDP arriving before the local offer must be retained and applied once the local description exists.
3. Multiple provisional responses and dongle trunk failover must not terminate the call or leave it silent.
4. Local ringback must stop as soon as a remote audio track is available, and on final answer/failure, so it never overlaps live audio.
5. Final answer audio and codec must remain PCMU/telephone-event with relay media; no regression to established-call audio.

### Task 1: Add sanitized early-media diagnostics

**Files:**
- Modify: `src/sip/MediaDiagnostics.ts`
- Modify: `src/sip/JsSipService.ts:990-1005`
- Test: `__tests__/jsSipMedia.test.ts`

**Interfaces:**
- Produces: `describeSdpForLog(sdp: string): { mAudioPayloads: string[]; setup?: string; direction?: string; hasIceUfrag: boolean; hasFingerprint: boolean }`
- The helper must never include ICE passwords, fingerprints, candidate addresses, or raw SDP.

- [ ] **Step 1: Write the failing helper test**

Add to `__tests__/jsSipMedia.test.ts`:

```ts
import { describeSdpForLog } from '../src/sip/MediaDiagnostics';

test('early-media diagnostics expose codec and direction only', () => {
  const sdp = [
    'v=0',
    'm=audio 19462 UDP/TLS/RTP/SAVPF 0 126',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:126 telephone-event/8000',
    'a=setup:active',
    'a=sendrecv',
    'a=ice-ufrag:secret-ufrag',
    'a=ice-pwd:secret-pwd',
    'a=fingerprint:sha-256 AA:BB:CC',
  ].join('\r\n');

  expect(describeSdpForLog(sdp)).toEqual({
    mAudioPayloads: ['0', '126'],
    setup: 'active',
    direction: 'sendrecv',
    hasIceUfrag: true,
    hasFingerprint: true,
  });
  expect(JSON.stringify(describeSdpForLog(sdp))).not.toContain('secret');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx jest __tests__/jsSipMedia.test.ts -t "early-media diagnostics" --runInBand`

Expected: FAIL because `describeSdpForLog` is undefined.

- [ ] **Step 3: Implement `describeSdpForLog` in `src/sip/MediaDiagnostics.ts`**

Parse only `m=audio` payloads, `a=setup:`, `a=sendrecv|sendonly|recvonly|inactive`, and the presence of `a=ice-ufrag:` / `a=fingerprint:`.

- [ ] **Step 4: Use the helper in the media-operation warning**

In `JsSipService`, when logging `peerconnection:setremotedescriptionfailed`, include `sdpType`, `sdpOriginator`, and the parsed summary stored from the last `sdp` event. Do not log raw SDP.

- [ ] **Step 5: Run the focused test**

Run: `npx jest __tests__/jsSipMedia.test.ts -t "early-media diagnostics" --runInBand`

Expected: PASS.

### Task 2: Stop mutating remote SDP on outbound calls

**Files:**
- Modify: `src/sip/JsSipService.ts:954-958`
- Test: `__tests__/jsSipMedia.test.ts`

**Interfaces:**
- Consumes: existing `prioritizeCodecInSdp(sdp, preferred)`.
- Produces: outbound remote SDP is never rewritten; outbound local offer and inbound remote offer behavior remains unchanged.

- [ ] **Step 1: Write the failing outbound-remote-SDP test**

Add an outbound-session case to the existing `codec preference respects native negotiation` test:

```ts
const outbound = createSession('outgoing');
// register/connect as in the existing test, then:
outbound.emit('sdp', remoteOfferDescription);
expect(remoteOfferDescription.sdp).toBe(originalSdp);
```

Use a remote offer containing Opus, PCMU, PCMA, and telephone-event; assert it is unchanged for an outbound call.

- [ ] **Step 2: Run it and verify it fails**

Run: `npx jest __tests__/jsSipMedia.test.ts -t "outbound remote" --runInBand`

Expected: FAIL because the current handler mutates every `type === 'offer'`.

- [ ] **Step 3: Restrict the SDP filter**

In `session.on('sdp', ...)`, apply `prioritizeCodecInSdp` only when:

```ts
data?.type === 'offer' &&
data.sdp &&
(session.direction === 'incoming' || data.originator === 'local')
```

Remote SDP for an outbound session must pass through untouched.

- [ ] **Step 4: Run the media suite**

Run: `npx jest __tests__/jsSipMedia.test.ts --runInBand`

Expected: PASS, including the existing incoming-offer codec tests.

### Task 3: Retain and apply provisional SDP after the local description exists

**Files:**
- Modify: `src/sip/JsSipService.ts:990-1025,1499-1520`
- Test: `__tests__/jsSipMedia.test.ts`

**Interfaces:**
- Consumes: `JsSIP` `sdp` events with `{ originator, type, sdp }`.
- Produces: `private pendingEarlySdp: { type: 'offer' | 'answer'; sdp: string } | null`
- Produces: `private applyPendingEarlySdp(session): void`
- Only applies when `connection.localDescription` exists and `connection.remoteDescription` is null; catches and logs sanitized diagnostics on failure.

- [ ] **Step 1: Write the failing retry test**

Create a fake outgoing session whose connection has:

```ts
localDescription: { sdp: 'v=0\r\nm=audio 5000 ...' },
remoteDescription: null,
setRemoteDescription: jest.fn(async () => undefined),
```

Emit a remote `answer` SDP followed by `progress`; expect `setRemoteDescription` to be called once with the stored SDP. Emit `confirmed` and ensure it is not called again.

- [ ] **Step 2: Run it and verify it fails**

Run: `npx jest __tests__/jsSipMedia.test.ts -t "provisional SDP" --runInBand`

Expected: FAIL because no retry exists.

- [ ] **Step 3: Implement the pending-SDP path**

- Store the last remote SDP in the `sdp` handler for outbound sessions.
- In `progress`, after `attachEarlyMediaAudio(session)`, call `applyPendingEarlySdp(session)`.
- If `connection.localDescription` is not ready, leave it pending.
- If `connection.remoteDescription` is already set, clear without applying.
- Clear on `confirmed`, `ended`, and `failed`.
- Use `RTCSessionDescription` from `react-native-webrtc` if exported; otherwise pass the native-compatible object directly.

- [ ] **Step 4: Run the media suite**

Run: `npx jest __tests__/jsSipMedia.test.ts --runInBand`

Expected: PASS.

### Task 4: Add local outgoing ringback fallback

**Files:**
- Modify: `src/calls/incall.ts:74-86`
- Modify: `src/sip/JsSipService.ts:838-846,1001-1025,1499-1518`
- Test: `__tests__/incallRingback.test.js`
- Test: `__tests__/jsSipMedia.test.ts`

**Interfaces:**
- Produces: `startOutgoingRingback(): void`
- Existing `stopOutgoingRingback(): void` remains.
- Ringback uses `InCallManager.startRingback(Platform.OS === 'android' ? '_BUNDLE_' : '_DEFAULT_')`.
- Stops on remote audio track/stream, `confirmed`, `ended`, or `failed`.

- [ ] **Step 1: Write the failing ringback test**

Add to `__tests__/incallRingback.test.js`:

```js
test('starts the native outgoing ringback', () => {
  startOutgoingRingback();
  expect(InCallManager.startRingback).toHaveBeenCalledWith(
    Platform.OS === 'android' ? '_BUNDLE_' : '_DEFAULT_',
  );
});
```

Expected: FAIL because `startOutgoingRingback` is not exported.

- [ ] **Step 2: Implement `startOutgoingRingback`**

Wrap `InCallManager.startRingback` in the same error handling style as `startRingtone`.

- [ ] **Step 3: Start and stop it at the correct points**

- Start it in the outbound branch after `startCallManagers()`.
- Keep it running after `progress` if no remote audio track is attached.
- Stop it in the `track`/`addstream` handlers when a remote stream is set, in `attachEarlyMediaAudio` when tracks are found, and in `confirmed`/`ended`/`failed`.
- Do not stop it on `progress` alone.

- [ ] **Step 4: Run ringback and media tests**

Run: `npx jest __tests__/incallRingback.test.js __tests__/jsSipMedia.test.ts --runInBand`

Expected: PASS.

### Task 5: Verify on device with a real early-media call

**Files:**
- No source changes; verification only.

- [ ] **Step 1: Build and install a signed APK**

Use the existing production keystore/build script. Do not clear app data.

- [ ] **Step 2: Make an outbound call to a number with carrier early media**

Capture:

```sh
adb logcat -d -v threadtime | grep -E '\[sip\]|\[media\]|setRemoteDescription|remote audio|rn-webrtc'
```

- [ ] **Step 3: Check the acceptance criteria**

- The `183` SDP is applied; no `setremotedescriptionfailed`.
- A remote audio track is logged before the `200 OK`, or local ringback is audible when no early media exists.
- Ringback stops when remote audio starts.
- Final call audio still uses PCMU/telephone-event over relay media.
- PBX trace still shows `183 Session Progress` with the same valid SDP.

- [ ] **Step 4: Report evidence**

State the APK version, call timestamp, app log lines, and PBX `183`/`200` lines. Do not claim fixed without both app and PBX evidence.
