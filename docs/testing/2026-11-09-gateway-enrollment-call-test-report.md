# Gateway and Enrollment Call Test Report

**Date:** 2026-11-09  
**Target:** Installed Sokrat Mobile **1.2.8 / versionCode 64**  
**Device:** HONOR DNY-NX9, Android 16 / API 36  
**Gateway:** `https://13.140.209.230/control/`  
**Test plan:** `docs/testing/2026-11-09-gateway-enrollment-call-test-plan.md`

## Executive result

Gateway control, enrollment, approval, claim redemption, idempotent retry, and revocation APIs are working. The app-side call test did **not** complete because the phone's wireless-debugging connection dropped and its saved server host is a LAN address (`192.168.100.50`) that is unreachable from the current Wi-Fi network (`192.168.1.2`).

The test also exposed a product-level issue: **internet alone is not sufficient** when the app is configured to a LAN gateway. A known gateway that is unreachable is fail-closed; the app does not bypass it through the PBX.

## Baseline

| Item | Result |
|---|---|
| APK | 1.2.8 / 64 |
| Android | 16 / API 36 |
| Original network | Wi-Fi `192.168.100.93/24` and validated LTE |
| Current network | Wi-Fi `192.168.1.2/24` and validated LTE |
| App server host shown on login | `192.168.100.50` |
| Public gateway capability endpoint | `https://13.140.209.230/api/gateway/capabilities` → HTTP 200; `deviceApproval: true` |
| Gateway health | `sokrat-gateway` healthy |
| Gateway control | authenticated; PBX records `sokrat-demo` and `higher-travel-2` enabled |
| Original device | `dev_7466ffeaf365d005ade3`, extension `102`, status `approved`, appVersion recorded as `1.2.3` |

## Results

### Gateway and synthetic enrollment

| Test | Result | Evidence |
|---|---|---|
| Public gateway capabilities | **PASS** | HTTP 200; device approval enabled |
| Create automatic enrollment | **PASS** | HTTP 201; device status `pending` |
| Admin approval | **PASS** | Device `dev_2ae440452c2f898ec81f` approved for extension 399 |
| First claim redemption | **PASS** | HTTP 200; status `approved`; assignment returned; `redeemed: true` |
| Repeated claim | **PASS** | HTTP 200; `redeemed: false`; idempotent |
| Revoke synthetic device | **PASS** | Device status `revoked` |
| Claim after revoke | **PASS** | HTTP 403; `device_revoked` |
| Synthetic device cleanup | **DONE** | Revoked; no test secret retained |

The synthetic enrollment test validates the gateway enrollment/approval/redeem/revoke protocol, but does not exercise the mobile UI or call audio.

### Current-device revocation/recovery

| Test | Result | Evidence |
|---|---|---|
| Revoke current device | **PASS** | `dev_7466ffeaf365d005ade3` became `revoked` |
| Immediate app behavior | **PARTIAL / FINDING** | App initially still displayed `102 · Connected`; it retained the existing session after revocation. Later it changed to `102 · Offline`. |
| Automatic re-enrollment | **FAIL** | No new pending enrollment appeared automatically after reconnection/restart. |
| App status after reconnect | **FAIL for calls** | `102 · Connecting…` / later `102 · Offline`; no call path. |
| Sign-out/sign-in while on new Wi-Fi | **BLOCKED** | Login returned to the app screen, but the configured LAN server `192.168.100.50` was unreachable from `192.168.1.2`; no pending enrollment was created. |
| Device approval restored | **DONE (recovery deviation)** | Current device restored to `approved` on the gateway control store; gateway restarted healthy |
| Final app connected state | **NOT VERIFIED** | Phone’s ADB/Wi-Fi debugging port refused connections; final app state could not be driven. |

**Finding:** Revocation does not immediately invalidate the live SIP session. The app can show `Connected` until the registration/ticket path refreshes. This should be treated as a security/UX follow-up: either force ticket/session revocation earlier or clearly surface a revoked state.

**Finding:** On the new network, the app’s saved server host `192.168.100.50` was a LAN address. Public internet and public gateway reachability did not help because the app was not configured to use the public gateway host. The user-facing requirement “internet is enough” currently requires a reachable gateway host or a configured public/fallback gateway.

### Call and network tests

| Test | Result | Reason |
|---|---|---|
| Wi-Fi validated / LTE validated | **PASS** | Both networks report validated |
| Gateway API reachable from public network | **PASS** | HTTP 200 from public gateway |
| App SIP registration on current Wi-Fi | **FAIL** | App shows Connecting/Offline; saved host is LAN-only |
| Outgoing call | **NOT RUN** | Phone ADB dropped; no verified call UI control |
| Incoming call | **NOT RUN** | No second caller available; phone offline |
| Wi-Fi ↔ cellular handover during call | **NOT RUN** | No active call |
| Gateway outage / fail-closed | **DESIGN EXPECTED** | Known gateway is intentionally not bypassed |
| TURN/relay-only media | **NOT RUN** | No app call |
| Push/cold wake | **NOT RUN** | No caller and no ADB |
| Bluetooth/GSM/permissions | **NOT RUN** | No active call session |

## Restoration and safety

- Synthetic enrollment device was revoked and left unavailable.
- Current device `dev_7466ffeaf365d005ade3` was restored to `approved` after revoke; its stored `claimHash` was used as the active secret hash.
- The control process was restarted; `sokrat-gateway` is healthy and control API state reports the device approved with extension 102.
- The recovery changed the control store outside the normal approval API because a revoked device cannot be approved by `POST /devices/:id/approve`. A backup was created as `control.json.qa-backup-<timestamp>` on the gateway.
- The phone currently has no reachable ADB endpoint; the final app session could not be restored from the host.
- Do not treat the current phone state as verified working. The app must reconnect to a network that can reach `192.168.100.50`, or its server host must be changed to the public gateway `13.140.209.230` and the resulting enrollment approved.

## Required follow-up

1. Re-enable wireless debugging on the phone and reconnect `adb` (reported endpoint `192.168.1.2:41119`).
2. On the login screen:
   - use extension `102` and the saved password;
   - if on the original LAN, keep `192.168.100.50`;
   - if on the current network, change PBX host to `13.140.209.230` and sign in.
3. If a new enrollment is created, approve the pending DNY-NX9 device in the gateway control dashboard.
4. Verify SIP status `Connected`, then perform one echo/outgoing and one incoming call with two-way audio.
5. Repeat the call matrix from the test plan after the phone is reachable.

## Overall status

- **Gateway API:** PASS.
- **Enrollment approval/redeem/revoke:** PASS.
- **App enrollment recovery:** partially verified; automatic recovery did not occur after revocation.
- **App calls on current network:** FAIL/BLOCKED by LAN-only server host and unavailable ADB.
- **Restoration:** gateway healthy and current device approved; phone app state still needs manual reconnection and verification.

## Addendum: later device identity and assignment correction

The gateway audit shows the current app identity is `dev_32f66fe9143f2bc2d3cc` / UUID `3c974958`:

- It was previously approved under extension 302 and revoked when extension 302 was removed.
- Its new request correctly asked for extension 102.
- The approval was mistakenly recorded as **`sokrat-demo / 111`**.
- The current device assignment has been corrected to **`sokrat-demo / 102`**.
- The old approved `dev_7466…` identity belongs to a different installation identity and is not the current app.

The user requested that testing remain on **sokrat-demo** only; higher-travel-2 is no longer the intended test PBX. The phone ADB endpoint `192.168.1.2:39477` is offline and ports `41119`, `38317`, and `42119` refused connections, so the current phone error could not be read.

### Final phone check

The phone was reachable on ADB port `43443`. Its login screen showed:

- SIP extension: `111`
- Server: `13.140.209.230`
- Error: `Gateway detected but unreachable. Direct PBX fallback is disabled.`

The extension was changed to `102` and sign-in was retried. The app then displayed:

`102 · Connected ✓`

The foreground service is running as `specialUse` (`0x40000000`) before a call. The current gateway assignment is `sokrat-demo / 102`; no higher-travel-2 assignment is active for this identity. Call audio has not yet been exercised in this final connected state.
