# Sokrat Mobile — Embedded VPN + Cloud Wake Hybrid Plan

Status: design plan, no implementation yet  
Target: Android first; iOS after Android/WireGuard path is proven  
Goal: keep cloud-gateway/FCM wake reliability, move voice media onto an embedded private VPN to the PBX, and retain the cloud/TURN path as fallback.

## 1. Evidence and design conclusion

The current comparison is conclusive:

| Path | RTP peer | RTT/jitter | Result |
|---|---|---:|---|
| PortSIP over Tailscale | PBX `100.98.185.86`, peer `100.68.99.121:8380` | ~7 ms RTT, ~5 ms jitter, 0% loss | Clear |
| Sokrat cloud-forced TURN | `10.253.0.1` cloud TURN | ~60–135 ms RTT, 25–40 ms jitter, 0% loss | Choppy |
| Sokrat direct LAN media | phone `192.168.100.93` | ~9 ms RTT, 1–3 ms jitter | Better |

Same codec (Opus) and no packet loss. The difference is the media path, not codec or jitter-buffer depth. The correct architecture is:

> **Cloud gateway for wake/control/fallback; embedded VPN for direct SIP/RTP to the PBX.**

Do **not** use the cloud gateway as the default media relay. Do **not** force `iceTransportPolicy: relay` for normal calls.

## 2. Target topology

```text
                         FCM / HTTPS
Phone app  ───────────────────────────────►  Cloud gateway
    │                                          │
    │ embedded WireGuard tunnel                │ wake webhook
    ▼                                          ▼
  PBX  ◄────────────────────────────────────── PBX
    │
    └── direct SIP/TLS + RTP over VPN ───────► Phone app

Fallback only:
Phone app ── cloud gateway SIP/TURN ── FRP/media tunnel ──► PBX
```

Preferred deployment is a WireGuard endpoint **on or beside the PBX**. If the PBX cannot accept inbound UDP, a cloud/edge WireGuard hub is supported only as a fallback and must be treated as a lower-quality path.

## 3. Core decisions

1. Use **embedded WireGuard** in the Sokrat app. The user must not need Tailscale, ZeroTier, PortSIP, or another VPN app.
2. Keep the existing public cloud gateway for:
   - device enrollment and approval
   - FCM/APNs registration and wake
   - call-state and tenant APIs
   - short-lived SIP tickets and TURN fallback
3. Use a **split-tunnel** VPN: only the assigned PBX/VPN subnet is routed through WireGuard. Internet/FCM traffic stays on the phone's normal network.
4. Use exactly **one active Sokrat SIP registration at a time**:
   - VPN up and reachable: direct WSS to PBX.
   - VPN unavailable: gateway WSS + TURN.
   - Never leave a stale cloud contact and a direct contact ringing simultaneously.
5. The PBX must check for an existing contact before sending a wake. If direct registration exists, dial it immediately.
6. Keep the current FCM wake and PBX contact-wait flow. Extend it so it can wait for a direct VPN registration, then fall back to the cloud path.
7. Do not force TURN. Direct mode uses host candidates over the VPN; fallback mode uses gateway ICE/TURN.
8. Keep device approval authoritative. Direct PBX access is allowed only for an approved device with a valid VPN profile.

## 4. VPN implementation choice

Recommended options, subject to legal review:

- **wireguard-go** (MIT) integrated through a small JNI/Go mobile layer and Android `VpnService`.
- **BoringTun** (BSD-3) as an alternative WireGuard data plane with a native Android `VpnService`.
- **`com.wireguard.android:tunnel`** is published on Maven Central as Apache-2.0 (verify the exact version and its source), so it may be embeddable in a proprietary app with notices; do not assume the whole official WireGuard Android client is permissively licensed.

There is no royalty or commercial permission fee for the WireGuard protocol. “License” here means open-source compliance: permissive MIT/BSD/Apache code can be used in the proprietary app with attribution and notice obligations; GPL/copyleft code would require source-disclosure review. Do not embed GPL kernel/app code without legal approval.

Do not implement WireGuard cryptography by hand.

Minimum Android requirements:

- `VpnService` with `BIND_VPN_SERVICE`.
- Foreground notification while the tunnel is active.
- One-time `VpnService.prepare()` consent.
- Start tunnel before SIP registration on FCM wake.
- Detect another active VPN; if `prepare()` cannot establish, use cloud fallback and tell the user.
- Optional system “Always-on VPN” support for the Sokrat VPN service; document that force-stopping the app still blocks FCM wake.
- Split tunnel routes:
  - PBX WireGuard address/subnet
  - PBX SIP/API addresses
  - no `0.0.0.0/0`, no unnecessary DNS
- MTU: start at 1380; test 1280/1420 on mobile networks.
- Persistent keepalive: 25 seconds while registered, lower only if battery testing requires it.

## 5. Data plane and profile contract

Add a VPN profile to the PBX assignment. It contains **no device private key**:

```ts
type GatewayVpnProfile = {
  profileId: string;
  endpoint: string;          // public or private WG host:port
  serverPublicKey: string;   // Curve25519 public key
  address: string;           // assigned device address, e.g. 10.66.20.17/32
  allowedIPs: string[];      // PBX routes only, e.g. ["10.66.20.0/24"]
  privateSipWssUrl: string;  // wss://<pbx-vpn-ip>:8089/ws
  privateApiUrl: string;     // https://<pbx-vpn-ip>:8080
  keepaliveSeconds: number;
  mtu: number;
  directSipEnabled: boolean;
  expiresAt?: string;        // profile rotation marker
};
```

The app generates a WireGuard key pair locally. The private key never leaves the device and is stored with Android Keystore-backed encryption. Only the public key is registered.

### PBX-side peer model

- Interface: `wg0`, e.g. `10.66.20.1/24`.
- One peer per approved device:
  - public key
  - AllowedIPs = device address `/32`
  - optional preshared key
  - device ID / PBX ID / creation time / revoked time
- Server peer AllowedIPs must be `/32`, never route the whole tenant subnet through a device.
- Firewall:
  - UDP WireGuard port from the public internet
  - WSS `8089` and API `8080` only from the WireGuard interface/subnet
  - no public SIP exposure
- Revocation must remove the peer and close the device’s cloud SIP/TURN sessions.

## 6. Gateway APIs and provisioning

### New device-authenticated APIs

```http
POST   /api/gateway/vpn/peer
DELETE /api/gateway/vpn/peer
GET    /api/gateway/vpn/profile
```

`POST /api/gateway/vpn/peer` body:

```json
{
  "profileId": "pbx_.../device_...",
  "publicKey": "base64-curve25519-public-key"
}
```

Response: the profile above, with the allocated device address. Never return a private key or SIP password.

`DELETE /api/gateway/vpn/peer` removes the peer by device ID/public key and is called on logout, revoke, or profile rotation.

### PBX provisioning adapter

The gateway must not shell out arbitrary commands. Add a small authenticated PBX peer-management service:

- listens only on loopback/control network or a private FRP/mTLS channel
- accepts add/remove/list by device public key
- validates key format and address allocation
- updates WireGuard through `wg set`/`wg-quick` with an allowlisted operation
- audits every peer add/remove
- is idempotent for retries

Gateway `tenant-runtime`/control store must persist:

```text
pbx.vpnEnabled
pbx.vpnEndpoint
pbx.vpnServerPublicKey
pbx.vpnSubnet
pbx.privateSipWssURL
pbx.privateApiURL
deviceVpnPeer: { publicKey, address, createdAt, revokedAt }
```

`_claimAssignment` includes `vpn` only when the PBX has `vpnEnabled` and a valid profile.

### FCM payload

Do not add secrets to FCM. Add only routing metadata:

```json
{
  "msg": "incoming-call",
  "type": "incoming-call",
  "callId": "...",
  "extension": "102",
  "vpnProfileId": "...",
  "directSip": "1",
  "fallback": "1",
  "timestamp": "..."
}
```

The app already knows the profile; FCM must not contain the WireGuard private key, SIP password, or TURN secret.

## 7. Mobile state machine

```text
START
  │
  ├─ no approved VPN profile ──► CLOUD_ONLY
  │
  ├─ VPN consent denied ──────► CLOUD_ONLY
  │
  └─ VPN profile approved
        │
        ▼
   VPN_STARTING
        │ handshake + PBX reachability
        ├─ fail ───────────────► CLOUD_FALLBACK
        ▼
   DIRECT_REGISTERING
        │ SIP REGISTER direct WSS
        ├─ fail ───────────────► CLOUD_FALLBACK
        ▼
   DIRECT_ACTIVE
        │
        ├─ VPN lost ───────────► CLOUD_FALLBACK (new calls)
        └─ revoke ─────────────► STOP + revoke profile
```

Rules:

- On entering `DIRECT_ACTIVE`, ensure the cloud SIP socket is closed/unregistered.
- On entering `CLOUD_FALLBACK`, unregister the direct contact if reachable and establish the gateway SIP session.
- Do not switch mode during an active call by default. New calls use the new mode. A later phase can add ICE restart/TURN continuity.
- The gateway HTTP control session remains independent of the SIP mode.
- The UI must show `Direct VPN`, `Cloud fallback`, or `Connecting`, not a silent quality downgrade.

## 8. Wake and incoming-call flow

### Current flow to preserve

PBX push hook sends FCM before dialing and waits for a contact. Existing gateway heartbeat/FCM suppression and native incoming-call UI remain.

### New flow

1. Incoming call reaches PBX.
2. PBX checks `PJSIP_DIAL_CONTACTS(<extension>)`.
3. If a direct/cloud app contact already exists, dial immediately; no wake.
4. If no contact:
   - PBX sends the wake webhook to the cloud gateway.
   - Gateway sends high-priority FCM.
5. App foreground service wakes:
   - starts/checks embedded VPN
   - waits for tunnel handshake and private PBX reachability
   - registers direct WSS using the approved extension credentials
   - sends ACK/heartbeat with `mode=direct`
6. PBX wake loop sees the direct contact and dials.
7. If VPN/registration does not complete within the direct budget:
   - app stops the direct attempt
   - registers through the cloud gateway using a ticket
   - sends ACK with `mode=cloud`
   - PBX completes the call through the fallback path
8. If neither registers by the final deadline, existing PBX timeout/voicemail behavior applies.

Direct registration budget: target 4–6 seconds; total PBX wait must remain at least 10–12 seconds to cover cold start. Measure on a killed app, locked screen, and VPN off.

### Outgoing calls

- If `DIRECT_ACTIVE`, dial direct over VPN.
- Otherwise use current cloud gateway/TURN path.
- Use one SIP session; do not ring both.

## 9. Registration and duplicate prevention

The app currently has one JsSIP UA/socket. Keep that invariant:

- Direct WSS: `wss://<pbx-vpn-ip>:8089/ws`
- Cloud WSS: existing gateway ticket URL
- On mode change, stop the old transport before starting the new one.
- If PBX still exposes an old contact, use `remove_unavailable`, wait for contact expiry, or explicitly unregister with `expires=0`.
- PBX dialplan should prefer the direct contact when both exist; ideally both never coexist.
- Desktop/MicroSIP contacts remain independent and continue to ring as configured.

## 10. Mobile file-level implementation

### Android

- `android/app/src/main/java/com/sokratmobile/SokratVpnService.kt`
  - `VpnService`
  - WireGuard backend
  - tunnel start/stop/status
  - notification and foreground lifecycle
  - split tunnel configuration
- `android/app/src/main/java/com/sokratmobile/VpnModule.kt`
  - React Native bridge: `prepare`, `start`, `stop`, `status`, `profile`
- `android/app/src/main/AndroidManifest.xml`
  - `BIND_VPN_SERVICE`
  - VPN service + intent filter
  - foreground service type/notification
  - optional boot receiver
- `SokratConnectionService.kt`
  - start VPN before direct SIP
  - keep native call notification/full-screen behavior
- `SokratFirebaseMessagingService.kt`
  - high-priority wake → foreground service → VPN → SIP
- `android/app/build.gradle`
  - native WireGuard dependency
  - no test-only forced-relay flags

### TypeScript

- `src/vpn/types.ts` — profile/state/error contracts.
- `src/vpn/VpnManager.ts` — native bridge, consent, start/stop, timeout, reachability.
- `src/vpn/keyStore.ts` — generate/store private key via Keystore-backed storage; public key export.
- `src/vpn/health.ts` — PBX private reachability and handshake readiness.
- `src/gateway/types.ts` — add `vpn` profile to assignment; add direct SIP URLs.
- `src/gateway/client.ts` — `registerVpnPeer` / `removeVpnPeer`; no secrets in responses.
- `src/gateway/session.ts` — approved profile hydration; direct/cloud mode; do not bypass approval.
- `src/sip/JsSipService.ts`
  - `connectionMode: 'direct-vpn' | 'cloud-gateway'`
  - direct WSS support
  - media configuration for direct host candidates
  - cloud ticket/TURN fallback
  - no forced relay
- `src/push/pushHandler.ts`
  - wake → `VpnManager.ensureReady()` → direct SIP → fallback
  - ACK only after registration
- `src/calls/connectionService.ts` — start/stop VPN with service lifecycle.
- `App.tsx` / account UI — mode status, VPN permission, fallback notice.
- `__tests__/` — profile parsing, mode selection, fallback, no secret output.

## 11. Gateway file-level implementation

- `src/control/store.js`
  - PBX VPN fields and validation
  - device VPN peer state
  - public PBX projection
  - `_claimAssignment` includes `vpn`
- `src/control/public/index.html` / `app.js`
  - PBX VPN endpoint/public key/private SIP URL fields
  - device VPN status and revoke action
- `src/tenant-runtime.js`
  - assignment includes `vpn`
  - peer add/remove/rotation hooks
- `src/vpn-provisioning.js` (new)
  - PBX peer manager client; idempotent add/remove; audit
- `src/index.js`
  - new VPN routes
  - feature flag/gating
- tests:
  - profile validation
  - peer add/remove/revoke
  - assignment exclusion for disabled PBX
  - no private key/SIP secret in API/FCM payload
  - fallback unchanged

## 12. PBX file-level implementation

- WireGuard server configuration and peer manager:
  - `wg0` interface
  - public UDP port/firewall
  - per-device peer API/allowlist
- Asterisk:
  - direct WSS transport already on `8089`
  - certificate/SAN or pinned private certificate
  - firewall limits SIP/API ports to VPN subnet
  - wake macro: check contact first; wait for direct or fallback registration
  - ensure direct contact uses same extension and flow identity
  - no Asterisk restart for app/UI changes
- Keep existing public/cloud fallback routes; do not remove them.

## 13. Security and revocation

- Device private key generated on device; never uploaded.
- Public key registration authenticated with device claim secret.
- Profile API over TLS; FCM carries only non-secret routing IDs.
- VPN peer allowed only to assigned PBX subnet and required ports.
- Split tunnel avoids exposing all traffic.
- Revocation sequence:
  1. mark device revoked in gateway
  2. remove WireGuard peer at PBX
  3. close cloud SIP sessions/TURN credentials
  4. remove push token
  5. UI shows revoked; no direct or cloud call path
- Rotate WireGuard keys and profiles on device re-enrollment or policy age.
- Certificate pinning or private CA for private WSS.
- No static private key in repo, installer, FCM, or logs.

## 14. Fallback behavior

- VPN permission denied, tunnel failure, PBX unreachable, or another VPN active:
  - cloud gateway SIP + TURN fallback
  - same FCM wake and inbound UI
  - quality lower; surface this in diagnostics
- Cloud gateway/TURN failure:
  - direct VPN path can still be used if signaling is healthy; however incoming wake depends on cloud gateway.
  - Keep existing cloud webhook as the only wake source for now.
- If PBX cannot expose WireGuard publicly, use a cloud/edge WireGuard hub; mark its quality lower and test separately. Do not silently call it “direct.”

## 15. Test plan

### Functional

- app killed + screen locked + VPN off → FCM wake → direct SIP register → answer.
- app killed + VPN on/always-on → direct register within budget.
- VPN permission denied → cloud fallback answer.
- another VPN active → cloud fallback without stopping the other VPN.
- incoming when direct contact already registered → no FCM wake, immediate dial.
- outgoing direct/cloud selection.
- mode switch while idle; no duplicate contacts.
- PBX contact revocation and device revoke.
- key rotation/profile expiry.
- multiple devices/desktops on the same extension.
- Wi-Fi ↔ cellular handover; VPN reconnect.
- cloud gateway down/restart; direct call path unaffected; wake unavailable.
- PBX unreachable; direct fails; cloud fallback.
- repeated incoming calls; no leaked channels.

### Quality

- Direct VPN RTP peer must be the PBX/private address, never cloud TURN.
- Target direct path: RTT/jitter near PortSIP baseline (~7 ms/5 ms on LAN; mobile network dependent), 0% loss.
- Fallback path measured separately; do not use fallback results for direct acceptance.
- Verify Asterisk channelstats, `rtp set debug`, contact transport, and app `getStats`:
  - selected candidate pair
  - packets lost/received
  - jitterBufferDelay/concealedSamples
- Echo and real two-way calls, earpiece/speaker/headset.
- Incoming cold start latency and ring success rate.

### Automated

- Unit: profile parser, mode state machine, fallback, key handling, no secret leakage.
- Android instrumentation: VpnService start/stop, permission denial, FCM headless path.
- Gateway: peer API, revocation, assignment gating, FCM payload contract.
- PBX: peer manager, contact wait, firewall/route config, no duplicate dial.

## 16. Rollout and observability

- Feature flags:
  - `pbx.vpnEnabled`
  - `tenant.vpnRolloutPercent`
  - app remote config/assignment
- Canary one device/PBX, then all test bench, then production.
- Metrics:
  - wake→VPN ready time
  - VPN handshake success
  - direct SIP registration success
  - direct vs cloud fallback rate
  - answer rate
  - RTT/jitter/loss per path
  - revoke propagation time
- Alerts for direct registration failures or FCM wake failures.
- Rollback: disable VPN profile in control store; app falls back to cloud; keep existing gateway/TURN path deployed.

## 17. Open decisions / risks

1. **PBX public UDP**: if no inbound WireGuard endpoint, a cloud/edge hub is required; quality will be lower. Decide test bench vs production topology.
2. **License**: wireguard-go MIT/BoringTun BSD vs GPL Android library.
3. **One VPN limit**: embedded Sokrat VPN cannot coexist with another active VpnService; enterprise VPN users fall back.
4. **Always-on**: users can force-stop or deny; FCM cannot override Android security.
5. **SIP credential model**: direct WSS uses existing extension password; later device-specific short-lived credentials or mTLS may be safer.
6. **Live-call failover**: switching VPN→cloud mid-call is not included initially; add ICE restart/TURN only after baseline.
7. **PBX provisioning**: gateway needs a secure peer-management channel; do not use unrestricted SSH.
8. **iOS**: design is Android-first; iOS Network Extension entitlement is separate work.

## 18. Definition of done

- A killed/locked phone receives an incoming call through FCM within the existing wake budget.
- Audio media flows directly over the embedded VPN to the PBX and is demonstrably smoother than the cloud-relay path.
- No direct cloud TURN media is used when VPN is healthy.
- If VPN is unavailable, calls still arrive through the existing cloud fallback.
- Revocation removes the peer and all call paths.
- No private keys or SIP secrets appear in APIs, FCM, logs, or repository files.
- Automated tests and a real phone-to-PBX incoming/outgoing call matrix pass.
