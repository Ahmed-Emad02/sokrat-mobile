# Gateway client integration snapshot — 2026-10-28

This feature-branch snapshot preserves the previously local mobile work as a
single integrated source baseline. Gateway changes share App, SIP, native call
notification and phone-screen code with earlier theme, transfer, caller-name,
dial-input, audio-route and WhatsApp shortcut changes; those dependencies have
not been discarded or represented as an isolated gateway-only patch.

## Included

- Gateway capability detection, manual device approval, persisted device identity,
  single-use SIP tickets and relay-only media configuration.
- Authenticated gateway APIs and signalling use the configured gateway origin,
  never the assignment's private upstream PBX API/WebSocket addresses.
- Native secure-random modules for Android/iOS enrollment secrets.
- Caller-name resolution, incoming-call answer handling, audio-route selection,
  transfer/UI work and selection-aware keypad editing from the local baseline.

## Verification and limitations

- Jest: 15 suites, 154 tests pass; TypeScript `tsc --noEmit` passes.
- Existing Android release build was installed on Honor without clearing data.
- Android `assembleRelease` rerun succeeds. APK:
  `android/app/build/outputs/apk/release/app-release.apk` (112,685,572 bytes),
  SHA-256 `b98c3fd0ad616c8d4cf8e33c3a0d69629fca7ea2f9b09601820fdd052647dbd2`.
  This matches the previously installed Honor artifact; no reinstall was needed.
- Existing-PBX tenant registration and inbound answered/outbound ringing were
  observed. These do not establish audible two-way/cellular audio quality.
- Killed-app FCM wake, hold/transfers, concurrent CRM registration and a second
  actual PBX remain acceptance work. No automatic device approval is introduced.
- iOS source is included but cannot be built on this Windows/WSL machine.
- Plain HTTP/WS coexistence remains unchanged; this is not a TLS migration or
  a production release certification. Android artifacts are test/debug-signed.

Source publication on a feature branch does not turn on global gateway
enforcement or change customer PBX routing. Review this integrated snapshot
before any merge to the customer-facing main branch.
