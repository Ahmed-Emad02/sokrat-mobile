# Android ringtone/Answer native lifecycle patch

## Evidence and cause

The parent session supplied historical physical-phone crash-buffer records at
`10-29 10:37:20` and `10-29 10:37:22`: fatal `mqt_v_native`,
`IllegalStateException` from `android.media.MediaPlayer.isPlaying`, through
`InCallManagerModule$myMediaPlayer.isPlaying:1522`, called by `start:559`.
These records do **not** prove that the first newly installed Answer/token APK
crashed; there is no post-patch physical acceptance result yet.

In upstream 4.2.2, ringtone stop runs on a separate worker. It calls
`stop(); reset(); release();` before clearing the shared ringtone reference.
`start()` can therefore query a released player. That query has no native catch;
the catch in `startPlay()` and the JS ringtone wrapper do not cover it. Also,
`stop()` is unsuitable during asynchronous preparation and can prevent release
and reference cleanup if it throws. A late prepared callback can start playback
or change audio mode after Answer unless serialized with release.

## Narrow fix

- Pin `react-native-incall-manager` to exactly `4.2.2` in both package manifests.
- Apply `patches/react-native-incall-manager+4.2.2.patch` through the existing
  `patch-package` postinstall; do not rely on an untracked node_modules edit.
- Answer cancels ringtone regardless of playing/preparing state, with no
  `isPlaying()` query. Ringtone reference/worker cancellation use one lock and
  generation counter; stop detaches and releases synchronously. A late start
  cannot stop active call audio, and an old timer cannot stop a replacement.
- Serialize player preparation, status query, release, and prepared callback on
  the player monitor. Release is terminal/idempotent; no preceding stop/reset.
  Catch native invalid-state queries and start failures, then release resources.
- End the ringtone worker Looper on stop and retain the existing conditional
  audio-restore behavior. Do not release the call's partial wake lock on Answer.

`src/calls/incall.ts` needs no JS catch-only workaround: asynchronous native
exceptions on the React Native module thread cannot be fixed by a JS catch.
No Answer/SIP/push/UI logic or PBX/server configuration is changed by this patch.

## Regression checks

```sh
npm test -- --runInBand __tests__/incallNativeLifecycle.test.js
node scripts/test-incall-player.cjs
```

The second command requires a JDK (`JAVA_HOME` or `java`/`javac` on PATH). It
extracts the **actual installed patched Java player and prepared callback** and
compiles/runs them against a strict fake MediaPlayer. Checks cover ordinary
playback, stop during preparation, duplicate stop, late prepared callback (no
playback or mode change), failed data source cleanup, invalid native query,
and concurrent status query/release. `--write-harness <directory>` emits the
Java source for compiling/running with a separate Windows JDK when WSL has none.
The four Jest checks protect patch pin/install wiring and ringtone coordination
source structure; they are not Android instrumentation tests.

## Limits / acceptance still needed

The synchronization fix does not migrate the whole library to a single owning
Looper; Android's documentation recommends same-thread player access. It closes
the identified Java release/query/callback races, but cannot establish all OEM
media-thread behavior. Nor does the JVM fake exercise Android audio focus,
Bluetooth, sensors, wake locks, native codecs, actual Handler scheduling, or SIP.

Parent owns Android build/install. Rebuild is required for this native patch.
Retest Answer immediately while ringtone is preparing, Answer after ringing,
notification/lock-screen Answer, remote cancel, repeated calls and hangup. Check
two-way audio and fresh crash-buffer/logcat timestamps. Until then, report only
source/JVM regression validation, not a verified on-device crash fix.

Reference: https://developer.android.com/reference/android/media/MediaPlayer
(`release` is valid in any state; no further use after release; MediaPlayer is
not thread-safe). Context7 was consulted; its results were not specific enough,
so the official MediaPlayer API reference was read directly.
