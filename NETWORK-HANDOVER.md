# Active-call network handover

The 1.0.0 release does not recover media when switching Wi-Fi/data.
Source changes here add bounded recovery. Production-signed 1.0.1/code2 is now
installed in place on the existing phone; matching gateway overlay is activated.
Saved account/push/SIP registration resumed, but live audio acceptance is pending.

## Recovery

- Keep the same JsSIP UA, RTCSession, peer connection, call ID and microphone.
  Do not call `connect()`/`ua.stop()` to recover an established call.
- `HandoverSocket` implements the JsSIP Socket contract. Each reconnect obtains
  a new one-use gateway ticket. Late callbacks and superseded ticket requests
  cannot reopen a stopped socket. No direct-PBX or plaintext fallback is added.
- Each gateway UA generates a fresh random 128-bit `flow`. This is a continuity
  identifier, NOT authority. The gateway must also validate a fresh ticket,
  device credential and unchanged tenant/extension/authorization revision.
- Debounce network changes, reconnect signaling, wait for SIP registration, then
  refresh TURN credentials and issue `renegotiate({rtcOfferConstraints:
  {iceRestart:true}})`. Busy offers are retried within 20 seconds. Hold/mute and
  consultation legs are retained; hangup/logout cancels stale recovery work.
- The existing relay-gathering guard still waits for fresh relay candidates.
  `patches/jssip+3.13.8.patch` prevents the previous generation's `_iceReady`
  flag from bypassing fresh ICE gathering. JsSIP is pinned to this version;
  re-test/re-diff the patch when upgrading. `npm ci` must run postinstall.

## Gateway prerequisite

Requires the matching `src/sip-proxy.js` handover changes in the gateway repo.
Opted-in authenticated flows retain the original PBX WebSocket for up to 20s
after detected phone disconnection, preserving PBX Contact/dialog routing and
incoming-dialog validation. Pending PBX messages (including BYE) are byte-bounded
and delivered when the same flow resumes. Ordinary non-flow clients retain
immediate disconnection cleanup. Revocation/malformed SIP/PBX failure never gets
a grace period. No PBX routing, trunk, SIP endpoint or audio settings are changed.

## Acceptance before shipping an updated APK

Automated checks: full Jest suite, TypeScript, scoped ESLint and gateway suite,
including real WebSocket handover, dialog isolation, expiry, queue overflow,
ticket replay and revocation tests. These do not prove audible handover.

On the **same production signer**, update via `adb install -r` (never uninstall
or clear accounts). Deploy the gateway change in an agreed idle test window.
Test both incoming and outgoing established calls:

1. Wi-Fi → cellular and cellular → Wi-Fi: same call/session, audio resumes both
   ways, call duration continues. A brief audio gap is expected, not zero loss.
2. Repeated switches, muted/held calls, consultation legs, and remote/local
   hangup during the switch. No ghost calls or microphone leaks.
3. Brief offline gap, then reconnect; longer outages must not be advertised as
   seamless recovery. The existing JsSIP ICE-failed/transaction failure behavior
   can still end a call. Switching during initial ringing or an in-flight SIP
   transaction is not guaranteed to preserve that transaction.
4. Retest cold wake, decline and caller cancel, and unchanged desktop calls.

Activation evidence is recorded in the suite `CODEX-MAP.md`; these build and
registration checks do not establish that real handover audio works.
