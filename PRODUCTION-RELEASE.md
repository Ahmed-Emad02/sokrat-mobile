# Employee APK release and upgrade

The installed lab APK is **test-signed**, not an employee release. Do not label
`assembleRelease` output production-ready without the production signing flag.

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
