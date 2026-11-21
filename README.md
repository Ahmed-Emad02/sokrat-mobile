This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

## Reproducible Android builds

Run `npm ci` from this repository. Postinstall applies the tracked dependency
patches and the existing audio-route hook; no sibling softphone checkout is
required. Gradle generates the standalone Hermes bundle. Do not restore the old
tracked `android/app/src/main/assets/index.android.bundle` or embedded web assets.

The vendored `android/app/libs/tunnel-sokrat.aar` is a required SDK input, not a
release APK. It is the app-specific repack of WireGuard tunnel `1.0.20260102`;
replacing it with the stock artifact requires revalidation. The official WebRTC
header closure and SDK checksum are pinned in `android/app/src/main/cpp/vendor`.
Use `PRODUCTION-RELEASE.md` for signing and in-place employee upgrades.

## UDP-only media

The mobile app accepts only UDP STUN/TURN URLs and disables native ICE-TCP
candidates for outgoing and incoming calls. Mixed server responses keep their
UDP endpoints and credentials; TCP/TLS-only responses fail media configuration
instead of silently falling back to TCP. Existing or older servers cannot
re-enable TCP by advertising an extra URL.

Direct-PBX and LAN calls may still use direct UDP. Gateway sessions remain
relay-only to preserve tenant isolation. SIP WebSocket and HTTPS signaling are
unchanged. A network that blocks UDP cannot establish media with this policy;
TCP is deliberately not a recovery path. Apply an APK update and start a new
call to use the policy; an already-running call is not renegotiated in place.


## Outgoing early media

Local ringback continues through 180 responses and through 183 responses that
have not delivered audio. A sending, non-rejected audio SDP section plus inbound
audio RTP starts carrier early-media playback before the final SIP answer;
the call remains ringing until JsSIP confirms it. Polling stops at confirmation
or teardown, and callbacks from a previous call cannot stop the current ringback.
JsSIP owns provisional/final SDP sequencing; the app does not replay SDP itself.

## Incoming ringtone

Settings offers an incoming-call ringtone choice on Android. **Phone default**
is the out-of-the-box selection: InCallManager resolves `_DEFAULT_` to
`Settings.System.DEFAULT_RINGTONE_URI`, so the extension rings with the phone's
own ringtone. **Custom audio** opens the system file picker, copies the chosen
audio file into the app's document directory and plays it through nitro-sound's
MediaPlayer, restarting playback until the call is answered, declined or ends.
Choosing **Phone default** again removes the copied file. The native
incoming-call notification keeps its own ringtone channel, which the user can
still change in Android's notification settings. Outgoing local ringback never
uses the incoming ringtone: Android loops the dedicated
`res/raw/incallmanager_ringback.wav` asset through InCallManager's MediaPlayer
path (`_BUNDLE_`); `_DTMF_` is deliberately avoided because its ToneGenerator
thread crashes the app on Android 16.

## Call teardown safety

An outbound call can never ring forever. A signaling transport lost during a
call gets an 8 s grace to reconnect (the handover socket reopens with a fresh
ticket); if it stays down the call ends locally with `SIGNALING_LOST` instead of
freezing the screen and ringback. Outbound ringing is bounded at 60 s
(`NO_ANSWER`, HTTP-style 408), and a 2xx that never reaches `confirmed` is
abandoned after 10 s. A received 2xx stops the local ringback immediately.
Dongle-routed calls also reconcile gateway call-state every 2 s: two samples
with the trunk gone, or two samples with the caller gone after it was once
seen, end the call. Internal extension calls never start reconciliation.

## Internal calls and primary-session ownership

Normal outbound calls reserve one primary slot before microphone or TURN
preparation. A second ordinary dial cannot replace a live or pending call.
An incoming call may win while outbound media is still being prepared; the
superseded attempt must release only its own resources. Disconnect/reconnect
also invalidates pending dials. Only explicit attended transfer may create a
consultation alongside the held primary call.

The UI checks ownership before starting call audio. A rejected or superseded
dial must not stop audio managers belonging to an existing or newer call.

For extension-to-mobile BUSY reports, inspect the actual PBX channels and hint
before changing routing. A live GSM `PJSIP/<extension>-*` leg legitimately blocks
another incoming call when extension call waiting is off. An orphaned leg can
look identical; CDR overlap alone cannot distinguish an app session overwrite
from a restart or an undelivered BYE. Do not force call waiting on, bypass the
busy macro, or reduce AOR contacts to hide the condition.

The ownership fix is an APK update for both direct-PBX and gateway accounts,
not a server dialplan patch. Existing calls must finish before upgrading.
Verify normal calls in both directions, hangup returning the mobile hint to
Idle with no remaining call leg, and an immediate callback on each server.
UDP media, early-media handling, native NetEq and dongle audio remain unchanged.

Incoming answers also acquire audio without publishing it. Late answer media
or failures must release only their own capture, never stop or orphan the next
call's microphone. Disconnect clears consultation metadata before SDK teardown,
so a failed teardown cannot leave the client permanently busy after reconnect.

## One-way audio and codec negotiation

If microphone energy and RTP packet counts increase but the PBX decodes no
microphone audio, compare the native RTP codec with the codec advertised in SIP.
Packet counts alone do not prove that speech is being decoded.

JsSIP emits a local SDP answer after native `setLocalDescription`. Do not remove
codecs from that answer: it can advertise PCMU while native WebRTC still sends
Opus. Apply codec preferences to offers, including incoming offers before native
answer generation, and leave answers unchanged. An unavailable preference must
keep a supported offered codec; non-audio media sections must remain intact.

For an already-installed affected build, select **Auto** under **Preferred Audio
Codec**, then **Save & Connect**. This restores native negotiation without
reinstalling or deleting accounts.

## Android NetEq minimum delay

Android audio receivers request a native 200 ms minimum through
`RtpReceiverInterface::SetJitterBufferMinimumDelay(0.200)`. This is not an ignored
JavaScript configuration key. The hook covers incoming, outgoing and replacement
audio receivers; the 50-packet cap and the existing ADM settings are unchanged.
The AAR, official C++ headers and their dependencies are pinned and verified by
the build. The JNI target must use Chromium's relative C++ virtual-table ABI;
a compile-time guard rejects the ordinary NDK ABI, which crashes on the first
receiver virtual call. An SDK update must deliberately update this integration.

The receiver API applies the cached minimum when the remote audio SSRC is
signaled. The test PBX endpoint has BUNDLE enabled, allowing Asterisk to advertise
that SSRC. A peer that never signals its audio SSRC is not covered by this SDK
API; do not claim the floor is active there.

This trades roughly 120 ms of extra latency over the prior 80 ms start target
for tolerance of the observed delivery bursts. Historical capture correlation
showed a 154 ms consecutive-packet gap, 79 ms of non-silent concealment and an
approximately 84 ms interval target, without packet loss/discards. It does not
prove that all present-day audible chops have the same cause.

After installing, validate a new call using interval deltas:
`1000 * delta(jitterBufferTargetDelay) / delta(jitterBufferEmittedCount)` should
be approximately 200 ms or higher while audio is emitted. Compare concealment
and acceleration/deceleration counters with actual audio; do not treat
`jitterBufferMinimumDelay` alone as proof of the configured floor.

## Audio interruption diagnostics

Confirmed calls emit `[media]` audio statistics every two seconds for up to ten
minutes, stopping when the call ends or fails. Reports contain counters, not audio
recordings. Compare consecutive reports and a matching sent/received recording:
cumulative jitter-buffer averages alone do not establish the cause of a chop.

### Local counter file

The Android `audioDiagnostic` build also exports these sanitized samples to
`audio-diagnostics/latest-media-stats.jsonl` under the app's external-files
directory. Normal `debug` and `release` builds disable this export. The file
contains counters, codec/protocol labels, timestamps and the app's speaker
percentage—not call audio, SDP, addresses or credentials.

The first successful sample of each confirmed call replaces the previous file;
later samples append in order. A background writer caps the file at 1 MiB and
each sample at 16 KiB of text. JavaScript allows one file write in flight;
an export failure disables file export for that sampling session without
changing call audio or the existing statistics logger.

```sh
adb pull /sdcard/Android/data/com.sokratmobile/files/audio-diagnostics/latest-media-stats.jsonl .
```

### Native downlink PCM capture

The `audioDiagnostic` Android build type adds an opt-in PCM tap at WebRTC's
`AudioTrack.write` boundary. Ordinary `debug` and `release` builds do not include
the tap or its receiver. Build it with `:app:assembleAudioDiagnostic`, using the
existing production-signing environment and `-PproductionRelease=true` for an
in-place employee-device update.
Run the isolated PCM queue tests with
`:app:testDebugUnitTest --tests 'com.sokratmobile.diagnostics.*Test'`.
Diagnostic Java is included only in that host-test source set, not the debug APK.

Only callers holding Android's privileged `DUMP` permission, including an
authorized ADB shell, can arm the diagnostic receiver:

```sh
adb shell am broadcast -n com.sokratmobile/.diagnostics.PlayoutCaptureReceiver \
  -a com.sokratmobile.AUDIO_DIAGNOSTIC_START --ei durationSeconds 240
adb shell am broadcast -n com.sokratmobile/.diagnostics.PlayoutCaptureReceiver \
  -a com.sokratmobile.AUDIO_DIAGNOSTIC_STOP
```

Capture requires Android 11 or newer. It is off until explicitly armed and expires
within 600 seconds; an admitted callback gets at most one second to drain.
PCM, versioned binary per-write timings, and format/health JSON files are written
beneath the app's
external-files `audio-diagnostics` directory. The audio callback only copies into
a bounded, preallocated queue; a worker performs file I/O. Inspect
`captureComplete`, `droppedCaptureFrames`, and `shortAudioTrackWrites` before
treating a recording as evidence. `drainTimedOut` marks an unfinished callback at
shutdown. A new output-track instance ends the recording
instead of silently concatenating potentially different formats. Captures can
contain private call audio; stop capture and retrieve files only for an
authorized diagnostic call.

## Local contacts and speed dials

Fresh storage starts with no local contacts or assigned speed-dial targets.
Configure targets for the account's PBX dialplan; key 1 has no implicit voicemail
number. Clearing a slot leaves it unassigned after saving and reopening the app.
Existing saved contacts, favourites and explicit targets—including `*97`—are
preserved. No migration deletes records resembling the former sample contacts.

These source changes do not alter builds already installed on devices. A separately
approved build and native-device acceptance are required before shipping this cleanup.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
