# Caller and dialed-number display

Call screens, history and Android incoming notifications share this policy:

1. Show a resolved app/PBX contact name when available.
2. Otherwise show the actual caller/dialed number immediately, not an `Unknown`
   placeholder while the asynchronous contact lookup runs or after it misses.
3. Retain `Unknown` only when no usable number is supplied (including withheld
   caller identity). Never substitute the signed-in extension for the caller.

The fallback preserves number formatting, international and Arabic digits,
extensions, and feature codes such as `*43`. SIP URI fallback shows only the
number/user part, not the server address. A push/SIP display label is not treated
as an address-book name.

`src/calls/callerName.ts:callDisplayName` is used by incoming/active/outgoing
screens, call state, push presentation, native notification bridges and call-log
presentation. Android's `CallerDisplayName.kt` mirrors the same rule before JS
has started. Contact lookup still uses its internal `Unknown` miss sentinel;
display code converts that sentinel into the available number.

Existing history entries named `Unknown` are corrected at display time; their
stored numbers and records are not rewritten or deleted. Newly saved calls use
the same fallback. Saved contact/PBX names and later contact renames are retained.

Tests cover numeric fallbacks, contacts, feature codes, international/Arabic
numbers, withheld identities, asynchronous SIP naming, old history, real React
Native screen rendering and Android JVM presentation logic.

## Verified test-phone update (2026-10-30)

- 22 Jest suites/213 tests passed, including6 rendered-screen regressions.
- Android JVM4/4, TypeScript, scoped ESLint and diff checks passed.
- Release APK built and signature verified against the prior installed test APK.
  SHA256: `3ce15d52edb5bbd4fc4d500e1861b88e123c40ed01ed5ea33705aac5dd4c7bf1`.
- Installed with `adb install -r` at14:07:30 EET; no uninstall/data clear. Saved
  production account223 recovered push registration and SIP registration.
- Actual phone UI hierarchy shows existing `*43` history entries with numeric
  labels and the saved account. Future incoming/outgoing-call visual acceptance
  remains distinct from the rendered-screen regressions and registration checks.

The APK still uses the lab/debug signer; this display update does not complete
production signing or incoming-call/cold-wake integration.
