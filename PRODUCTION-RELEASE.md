# Employee APK release and upgrade

The `release` build type alone does not identify the signer. Use the production
signing flag and verify the certificate before distributing an employee APK.

## Persistent production signer

Provision a dedicated release keystore outside this repository. Keep an offline
backup and record its public SHA-256 signing fingerprint. Supply these variables
through the build environment/secret manager (never through Git or chat):

- `SOKRAT_RELEASE_STORE_FILE`
- `SOKRAT_RELEASE_STORE_PASSWORD`
- `SOKRAT_RELEASE_KEY_ALIAS`
- `SOKRAT_RELEASE_KEY_PASSWORD`
- `SOKRAT_ANDROID_VERSION_CODE` — monotonically increasing positive integer
- `SOKRAT_ANDROID_VERSION_NAME`

On the Windows build host, from `android/`:

```powershell
.\gradlew.bat assembleRelease -PproductionRelease=true --console=plain
```

Missing configuration or an unavailable keystore fails the build; production
mode never falls back to the debug signer. Verify the result using the SDK's
`apksigner verify --print-certs`, archive its SHA-256, and compare the certificate
fingerprint with the release inventory before distribution.

## Install and upgrade

- First employee installation uses the production-signed APK. Log in using the
  public gateway host and SIP credentials, then deliberately approve the phone.
- Later APKs must use the **same signing key** and a higher version code.
  `adb install -r` or Android's normal update keeps account/enrollment data.
- A production key cannot update a debug-signed lab install in place. Do not
  uninstall or clear a phone to bypass that restriction without explicit consent;
  use a separate fresh employee test phone for production-signer acceptance.
- Public enrolled accounts use HTTPS APIs and WSS; failed TLS validation must
  not be bypassed with a plaintext URL or a certificate exception.
- Validate cold wake, answer, decline, media and hangup against the approved
  production tenant before distributing widely. APNs/iOS remains separately
  unverified; Android testing does not establish universal OEM wake reliability.

## Primary-session ownership rollout — 1.2.24 (84)

Build the ordinary production `release` variant, not `audioDiagnostic`, with
version name `1.2.24` and code `84`. Keep the existing production signer; do not
clear enrollment or account data. This update is client-side and applies to
direct-PBX and gateway accounts on all servers.

No PBX busy-policy, call-waiting or AOR change is required. Before and after
rollout, inspect `core show channels concise` and the mobile extension's
`core show hint 102@ext-local` (substitute the actual extension). With call
waiting off, BUSY during a real GSM call remains correct. After hangup, the
mobile channel must disappear and its hint return Idle.

On each approved server/device pair, verify extension-to-mobile,
mobile-to-extension, hangup and immediate callback; then verify consultation
and cancel/resume for attended transfer. A pending dial, failed consultation
or rejected second dial must not replace the primary or stop its microphone.
An APK build and automated regressions do not replace these device checks.

Distribute through the existing signed CRM APK download flow or an approved
manual update. The app has no automatic update manifest. Updating a client
does not retroactively remove an existing PBX call leg; let it finish or
investigate it individually rather than changing server-wide busy policy.

Also include cancelled incoming answers followed by a new call during slow
media preparation, and reconnect after consultation. Late callbacks must not
silence the new call or leave stale client-side BUSY state.


## Incoming push rollout — 1.2.25 (85)

Use the ordinary production `release` variant with the existing signer, version
name `1.2.25` and code `85`. An in-place update must retain saved accounts and
approval. Do not distribute the diagnostic variant or clear application data.

Validate push-to-SIP call-id correlation, user Answer/Decline, caller cancellation,
active/held End, duplicate delivery, and an old call finishing after a newer
incoming call. Check that blocked app notifications or a muted incoming channel
are surfaced. Notification permission and full-screen access remain deliberate
user choices; an installer must not grant them silently.

Use the cold-process procedure in `MOBILE-PUSH.md`; an idle foreground service
is not a cold test. Provider acceptance is not proof of phone receipt or SIP
registration. Record which device/server combinations were actually exercised.
The documented same-extension/different-PBX binding limitation remains; do not
describe extension matching as complete tenant isolation.

Build from a clean source snapshot using `npm ci` and the tracked patches,
vendored SDK inputs and header closure. No sibling repository or generated
legacy web bundle is required. Recheck the signing certificate and APK checksum
before installation. UDP policy, early media, NetEq and dongle audio are unchanged.
