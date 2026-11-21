# Gateway and Enrollment Call Test Plan

**Target:** The **1.2.8** APK already installed on the Honor DNY-NX9 (Android 16 / API 36; versionCode 64).
**Goal:** Verify that every supported gateway/enrollment path reaches a usable call whenever the required network path is available.

**Important interpretation:** “Internet” is necessary but not sufficient. Calls also need the configured gateway, PBX/dongle path, TURN relay, and push delivery to be reachable. The app intentionally **fails closed** when a known gateway is unreachable; it must not bypass the gateway with direct SIP. A gateway outage is therefore an expected failure unless a separate HA/fallback design is added.

## Scope

Test these three deployment modes independently:

1. **Gateway-approved device** — enrollment, gateway WSS ticket, relay-only media, gateway push.
2. **Direct-PBX legacy device** — no gateway enrollment; direct PBX SIP and PBX `/api/mobile/ice`.
3. **Gateway with LAN fallback** — primary gateway unavailable, approved local gateway used; then primary recovery.

Test dimensions:

- Enrollment: detect, unclaimed, pending, approved, rejected, revoked, expired, PBX-disabled, assignment mismatch, account switch, reinstall.
- Runtime: gateway online/offline/restart, stale ticket, session invalidation, TURN failure, reconnect.
- Network: Wi-Fi, cellular, handover, airplane mode, DNS/captive portal, internet loss.
- Calls: outgoing/incoming, internal/external, foreground/background/locked/cold wake, relay-only audio.
- Device: reboot, swipe-away, OEM background policy, permissions, battery/doze, GSM preemption.
- Multi-device: fan-out, answer/cancel, revocation.

## Environment and prerequisites

- Phone: Honor DNY-NX9, Android 16, APK `1.2.8` (64), currently installed.
- Current network baseline: validated Wi-Fi `192.168.100.93/24` and validated LTE; record the active default at each test.
- **Preferred test account:** dedicated test extension and test device approval, not a production extension.
- Gateway administrator access to:
  - inspect enrollment state;
  - approve, reject, revoke, expire, and enable/disable PBX for the test device;
  - toggle the capability/enrollment test flags on a **staging** gateway;
  - view gateway logs.
- A second caller: another SIP extension and one PSTN test number routed through the test dongle/PBX.
- PBX read-only access for call verification (`core show channels`, registration/contact state). Do not restart Asterisk or modify production PBX routes.
- Ability to block the gateway independently from the PBX for outage tests. Use a staging gateway or network rule; do not take down production to simulate failure.
- Do not record claim secrets, SIP passwords, FCM tokens, or gateway bearer tokens.

## Safety and recovery

- Use a dedicated test extension. If testing with the main extension, record the current approved device and confirm the administrator can re-approve it before revoking anything.
- Run destructive tests (revoke/reject/clear data/reinstall) **last**.
- Do not `pm clear` or uninstall the main app until the test account can be restored.
- Do not block the gateway/PBX while a production call is active.
- Stop immediately on: production PBX disruption, unintended account revocation, data loss, repeated app crash, or gateway admin loss.
- Recovery after every destructive test:
  1. Re-enable network.
  2. Restore the test account or direct-PBX mode.
  3. Re-approve the device if needed.
  4. Verify SIP registration and one bidirectional echo call.
  5. Record the final gateway record/state.

## Baseline capture

Run before any scenario:

```sh
adb devices
adb -s 192.168.100.93:38317 shell dumpsys package com.sokratmobile | grep -E 'versionName|versionCode'
adb -s 192.168.100.93:38317 shell dumpsys connectivity | grep -E 'NetworkAgentInfo|VALIDATED' | head
adb -s 192.168.100.93:38317 logcat -c
```

Record:

- App version `1.2.8`, code `64`.
- Active extension/server host (not the password).
- Gateway state (`online`, `offline`, `restoring`, `blocked`) and enrollment state.
- Permissions: microphone, notifications, phone state, Bluetooth.
- Battery optimization state.
- Current SIP registration and one working call in each direction.
- Gateway admin view of the test device.
- Whether a LAN fallback endpoint is configured.

## Test matrix

### A. Enrollment lifecycle

| ID | Setup | Action | Expected result / evidence |
|---|---|---|---|
| ENR-01 | Host is a direct-PBX host with no gateway capability | Sign in with test extension | `legacy` mode; SIP registers directly; outgoing/incoming call works; no enrollment record created |
| ENR-02 | Gateway reachable, host unknown; clean device record | Sign in | `detecting` → `pending`; gateway creates unclaimed/pending device; app shows approval wait |
| ENR-03 | Pending approval | Leave app foreground for 5 min, background it, reopen | Poll resumes; no duplicate device; still pending; admin sees one enrollment |
| ENR-04 | Pending approval | Disable internet for 30 s during the poll, restore | `Waiting for the gateway…`; retry with backoff; approval resumes without a new device identity |
| ENR-05 | Admin approves while app is on the pending screen | Wait/poll | `approved`; assignment extension matches test account; SIP WSS ticket registered; gateway call works |
| ENR-06 | Approved device | Force-stop and relaunch app | Cached approved assignment is reused; no re-enrollment; SIP registers; call works |
| ENR-07 | Admin sets test PBX disabled | Sign in or claim while disabled | `pbx_disabled` / “The PBX is disabled…” wait state; no SIP call; enabling PBX lets enrollment complete |
| ENR-08 | Admin marks enrollment expired | Sign in/claim | Up to 3 automatic re-enroll attempts; then `expired` error; no direct fallback |
| ENR-09 | Admin rejects device | Sign in/claim | Terminal “not approved” error; no SIP registration; no direct-PBX bypass |
| ENR-10 | Admin revokes approved device | Relaunch and attempt a call | `revoked`; cached assignment invalidated; no direct fallback; re-approval creates/restores a usable session |
| ENR-11 | Gateway returns an assignment for a different extension | Claim | Fail closed with an assignment-mismatch error; no SIP call |
| ENR-12 | Account switched from extension A to extension B | Sign in with B | B enrolls separately; A’s approval is not reused; no cross-extension call; return to A restores A only |
| ENR-13 | Public gateway unreachable; approved LAN fallback configured | Launch/sign in | Primary probe fails; fallback capability + approval used; SIP/media/push work through fallback |
| ENR-14 | Primary gateway returns 404 or approval disabled; host is unknown | Sign in | Legacy/direct-PBX mode; call works |
| ENR-15 | Primary gateway returns 404/approval disabled; host is a known gateway | Sign in | Fail closed; must not use legacy/direct PBX |
| ENR-16 | Primary gateway returns 5xx or authorization error | Sign in | Fail closed; no direct bypass; retry only after gateway recovery |
| ENR-17 | Claim credential invalid/revoked | Sign in/claim | `unauthorized`/`revoked`; no SIP call; no direct fallback |
| ENR-18 | Clear app data or reinstall | Sign in | New stable device identity/enrollment; old approval behavior is explicit; admin can approve/revoke without affecting another test device |

### B. Gateway runtime

| ID | Setup | Action | Expected result / evidence |
|---|---|---|---|
| GW-01 | Approved gateway, gateway and PBX reachable | Place outgoing call; receive incoming call | Fresh WSS ticket; SIP registered; TURN relay-only media; bidirectional audio |
| GW-02 | Approved cached device, gateway unreachable, PBX reachable | Launch app and call | Fail closed (gateway-detected/unreachable); **no direct SIP**; record expected failure |
| GW-03 | Gateway goes down during registration | Observe state; restore gateway | Backoff/retry; new ticket on recovery; call works; no crash |
| GW-04 | Gateway restart while app is registered | Wait for reconnect | New ticket minted; SIP re-registers; outgoing/incoming call works |
| GW-05 | Stale/consumed SIP ticket | Force reconnect or network change | A new one-use ticket is minted; no stale-ticket loop |
| GW-06 | Gateway returns 401/403/revoked during ticket/heartbeat | Observe and re-enroll | Session invalidated; no direct bypass; UI shows the terminal state |
| GW-07 | TURN/ICE endpoint unavailable or returns no relay credentials | Attempt outgoing/incoming | Call is blocked with a clear audio-relay error; no call with silent/no audio |
| GW-08 | Primary gateway comes back after fallback was selected | Restart/relogin | Correct endpoint selection; no simultaneous direct/primary/fallback session |
| GW-09 | Approved device; push token registered | Refresh FCM token; logout/login; receive incoming call | Token re-registers under the same approved device; incoming push works; logout removes device token |
| GW-10 | Gateway API latency/timeouts | Place call while gateway API is slow | Bounded timeout/retry; no hang/crash; clear state; direct bypass never occurs |
| GW-11 | Gateway capability is reachable but device approval is required | Sign in with no approved record | Pending/approval path, not legacy; no SIP registration before approval |

### C. Network and lifecycle

| ID | Setup | Action | Expected result / evidence |
|---|---|---|---|
| NET-01 | Wi-Fi validated | Register and call | Gateway/PBX connection established; both audio directions |
| NET-02 | Wi-Fi off, validated cellular | Register and call | Same call behavior over cellular |
| NET-03 | Active call on Wi-Fi | Turn Wi-Fi off, remain on cellular | Signaling reconnects/ICE restart; call audio recovers or call reports failure; no silent dead call |
| NET-04 | Active call on cellular | Join Wi-Fi | Same expected recovery; no duplicate call |
| NET-05 | Registered | Airplane mode on for 30 s, then off | Offline/waiting state; reconnect; new call works |
| NET-06 | Registered/calling | DNS failure or captive portal | Bounded error; no direct fallback; call not falsely shown as connected |
| NET-07 | All network off | Attempt call | Clear “no network” state; no phantom call or enrollment success |
| NET-08 | App background / screen locked | Receive call | Native notification/full-screen path shown; answer works; audio two-way |
| NET-09 | App swipe-away (not force-stop) | Receive push | Cold wake/headless SIP bootstrap; notification and answer work |
| NET-10 | Device reboot, app not opened | Receive push | Record whether FCM cold-wakes; if not, classify as expected Android/OEM limitation |
| NET-11 | Doze/battery restricted | Receive incoming call | Record delivery; the notification/permission/battery banner must reflect the limitation |
| NET-12 | GSM call arrives during active SIP call | Answer/end cellular call | SIP call held and resumed; no dead audio; permission path verified |
| NET-13 | Bluetooth headset, speaker, earpiece | Switch routes during call | Correct device, two-way audio; A2DP-only device is not offered |
| NET-14 | Microphone/notification permission denied | Launch, receive/place call | Clear banner; no silent missing notification; granting restores behavior |
| NET-15 | API 34+ full-screen intent denied | Receive call while locked | Notification/answer surface remains; call screen may not wake; classify as user-setting limitation, not a silent failure |
| NET-16 | DND or incoming-call channel muted | Receive call | Record whether the ring/notification is suppressed; the app must not claim the call is unreachable if only system policy suppressed it |

### D. Call matrix

| ID | Call path | Expected result |
|---|---|---|
| CALL-01 | Gateway → internal extension | Both directions audio; correct caller name/number; no direct-PBX signaling |
| CALL-02 | Gateway → external PSTN/dongle | Both directions audio; dongle/PBX path; relay media |
| CALL-03 | PSTN/dongle → gateway app | Incoming push/notification; answer; both directions |
| CALL-04 | Internal extension → app | Same incoming path |
| CALL-05 | Gateway-approved app after reboot | Rehydrated session; call works after app launch |
| CALL-06 | Gateway fallback path | Call works while primary remains down |
| CALL-07 | Relay-only/TURN | Call works even when host candidates are blocked |
| CALL-08 | 10-minute call + network standby | No audio drop, ghost call, or duplicate notification |
| CALL-09 | Second device on same extension | Both receive fan-out; one answer stops/silences the other; cancel clears both |
| CALL-10 | App foreground while push arrives | No duplicate native/in-app call; one answer path |
| CALL-11 | Caller declines/ends before INVITE | No ghost notification; no stale action |
| CALL-12 | Gateway revoked during active call | Call behavior is deterministic; no bypass; next call blocked |

## Pass criteria

A scenario passes only when:

- The UI reaches the expected terminal state (not merely a spinner).
- A known gateway is never bypassed with direct SIP.
- SIP registration and both media directions work for a successful call.
- Incoming push produces one actionable notification, and answer/decline works.
- Expected failures show a clear error/wait state and recover after the dependency returns.
- Logs show no unhandled exception and no repeated credential leak.

Record for each case: ID, timestamp, network, gateway mode, gateway state before/after, enrollment state, call direction, audio result, app foreground/background, evidence file, pass/fail, notes.

## Evidence capture

```sh
# App/gateway/SIP/push state
adb -s 192.168.100.93:38317 logcat -v time | grep -Ei 'gateway|enroll|\[sip\]|push|CallNotificationModule|FATAL EXCEPTION'

# Package and service state
adb -s 192.168.100.93:38317 shell dumpsys package com.sokratmobile
adb -s 192.168.100.93:38317 shell dumpsys activity services com.sokratmobile

# Network state
adb -s 192.168.100.93:38317 shell dumpsys connectivity

# Screen recording / screenshot
adb -s 192.168.100.93:38317 shell screenrecord /sdcard/gateway-test.mp4
adb -s 192.168.100.93:38317 exec-out screencap -p > gateway-test.png
```

Use gateway admin logs and PBX read-only call state for server-side evidence. Do not paste secrets or raw tokens into reports.

## Execution order

1. Baseline and working echo call.
2. ENR-01 and ENR-14 (legacy paths).
3. ENR-02, ENR-03, ENR-04, ENR-05 (normal approval).
4. GW-01 through GW-07 (runtime/media).
5. NET-01 through NET-08, CALL-01 through CALL-08.
6. ENR-07 through ENR-13 (waiting/fallback/account transitions).
7. ENR-09/10/17 and GW-08/GW-10 (terminal failures; restore after each).
8. ENR-18 (reinstall/data clear; last).
9. NET-09 through NET-14, CALL-09 through CALL-12.
10. Restore original account/device approval and verify one final call.

## Final report template

| Field | Result |
|---|---|
| APK/version | 1.2.8 / 64 |
| Gateway mode tested | approved / legacy / fallback |
| Gateway online/offline | |
| Enrollment state | |
| Outgoing call | pass/fail + evidence |
| Incoming call | pass/fail + evidence |
| Two-way audio | pass/fail |
| Network handover | pass/fail |
| Push/cold wake | pass/fail |
| Gateway fail-closed behavior | expected / unexpected |
| Restored baseline | yes/no |
| Open blockers | |
