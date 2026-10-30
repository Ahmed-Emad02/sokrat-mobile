# Push wake and incoming Answer acceptance

## Local fixes (2026-10-29)

- Retry Android FCM token acquisition and server registration with 5–60 second
  backoff. Recheck on foreground and network-driven account binding.
- Stop account-scoped retries on logout/account changes; drain pending registration
  before removing the device. Never use direct PBX fallback for pending enrollment.
- Retain RNFirebase's native token-refresh event emitter in the custom messaging
  service. The plain Firebase base class did not emit `onTokenRefresh` to JS.
- Queue a headless push without marking it delivered before the React callback
  exists, so mounting the app does not silently deduplicate the queued call away.
- Treat `session.answer()` as dispatch, not connection. Keep the incoming UI until
  SIP confirmation, preserve an early native Answer until INVITE arrives, silence
  ringing without deleting the pending action, and reject unrelated stale actions.

Unit tests exercise these paths with mocked native modules/SIP. They are not proof
of provider delivery, Android wake, real ICE/DTLS, or two-way audio.

## Outstanding server prerequisite

The inspected PBX's normal extension path (`ext-local` → `exten-vm` → `dial-one`
→ `Dial`) never invoked the installed shared push sender. Showing a loaded
`sub-sokrat-push-send` context or getting HTTP 200 from a manual hook invocation
does not verify a normal incoming call triggers push. HTTP 200 with zero matching
recipients is also not delivery.

A reviewed PBX adapter must invoke wake only for dynamically identified,
push-capable WebRTC recipients and keep the call alive long enough for a missing
mobile contact to register. Preserve customer hooks, desktop SIP calls, dual
registration, DND/forwarding and outbound routes. Do not activate old fixture-only
hooks broadly or inject wildcard routing/early-media/audio changes.

## Physical acceptance checklist

1. Update the idle phone without uninstalling/clearing data; verify the existing
   gateway enrollment/account is retained.
2. Confirm a matching tenant token exists for the approved device, PBX and
   extension. Never print the token or claim secret in diagnostics.
3. Place a real call while the phone is foregrounded, backgrounded and locked;
   tap Answer before and after INVITE arrives. Exactly one UI/call should remain.
4. Incoming UI stays in connecting state until SIP confirmation; ringing stops on
   Answer. Establish two-way audio and verify local/remote hangup clears all UI.
5. Repeat rapid taps, delayed SHOW/push, caller cancellation, media failure,
   duplicate notifications, and an unrelated/stale call action.
6. After a supported PBX wake adapter is installed, test process-dead/swiped-away
   wake and contact recovery. Android force-stop is a different OS state and must
   not be advertised as an ordinary supported wake scenario.
7. Repeat on each PBX, including desktop-only and simultaneous desktop/mobile
   registrations, hold, transfer and normal outbound calling.

The ordinary app log did not retain the incident, but the separate Android crash
buffer did: two crashes around the reported time show `IllegalStateException`
from `MediaPlayer.isPlaying()` in incall-manager's `myMediaPlayer`, called by
`InCallManagerModule.start()`. A native player-lifecycle fix is being validated;
do not assume the SIP state fix alone covers this crash.

The first test APK was installed with `adb install -r` (no data clear). The saved
extension remained present, but the phone displayed Connecting. The gateway still
held only this same installation's old push row, tied to a revoked device on a
retired PBX. Ownership migration and retirement/reassignment invalidation require
server-side regression coverage and deployment before token/wake acceptance.

Record physical acceptance results separately from source/test findings.
