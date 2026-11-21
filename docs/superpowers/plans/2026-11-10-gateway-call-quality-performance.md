# Gateway + Mobile Call Quality and Performance Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session. Write a failing test before each change (`skill://test-driven`) and cite fresh evidence before claiming a task done (`skill://verification-before-completion`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove avoidable gateway and ICE latency from the mobile call path, improve RTP quality by allowing direct/host media paths, reduce repeated claim/ticket work, make control-plane hiccups non-destructive, and preserve `sokrat-demo` multi-tenant and per-PBX multi-extension routing.

**Architecture:** Keep the gateway as the tenant/PBX routing authority, but stop forcing every gateway call through TURN and stop doing a full gateway claim before every SIP connect. Resolve a per-call media policy, cache the approved assignment per host+extension, use TURN as fallback rather than mandate, and make transient control-plane failures non-fatal to an established SIP session. Any direct-PBX fallback is **per-PBX opt-in** and only to the PBX assigned to that tenant.

**Tech Stack:** React Native, TypeScript, Kotlin, Android 16 / API 36 device, JsSIP, react-native-webrtc, Node.js gateway (`sokrat-push-gateway-master`), Jest, Node test runner, Gradle.

**Spec:** This plan's Scope section is the specification, derived from the 2026-11-10 call-quality/performance judgment. No separate design document exists.

## Global Constraints

- **Multi-tenant isolation is non-negotiable.** Every cache, active session, TURN/ICE credential, ticket, and fallback must be keyed by at least `(host, extension, pbxId, deviceId, authorizationRevision)`.
- **Multi-extension routing is non-negotiable.** An extension on one PBX must never reuse another extension's assignment, TURN credentials, direct fallback, SIP socket, or ticket.
- **Never use `assignment.apiURL` or `assignment.wsURL` as a client origin.** Those are upstream PBX endpoints; gateway clients use the gateway origin. A direct fallback must use an explicitly configured public PBX URL from the same PBX.
- **Do not change enrollment/approval semantics** except where this plan explicitly adds a per-PBX direct-fallback configuration.
- **Security relaxation is limited to latency:** do not remove tenant/PBX identity checks; do relax checks that block an already-authorized session on transient control-plane errors.
- Do not restart Asterisk/PBX or run destructive gateway maintenance without operator approval.
- Do not add dependencies; preserve existing React Native, JsSIP, and gateway stack.
- Do not log raw claim secrets, SIP passwords, TURN credentials, or gateway bearer tokens.
- Do not commit unless the user explicitly asks.

## Scope

Implement these call-quality/performance fixes:

1. **Per-call media policy.** Gateway calls should offer host/STUN candidates and use TURN as fallback, not force `iceTransportPolicy: 'relay'` for every call.
2. **Fast ICE setup.** Release SDP as soon as a usable candidate exists; reserve bounded relay waiting only for explicit relay-only sessions and reduce its budget.
3. **Cached gateway assignment and duplicate-claim removal.** A valid approved assignment should be reusable without a network `/claim` on every connect, restart, or headless wake.
4. **Ticket/reconnect overhead.** Keep one-use tickets, but remove duplicate session/claim work from the ticket path and prewarm media configuration so the first call does not pay every serial HTTP cost.
5. **Non-destructive control-plane failures.** A transient gateway/control authorization exception must not tear down an established SIP proxy session; explicit revoke/reject still must.
6. **Per-PBX direct fallback (opt-in).** If the gateway is unavailable, only an explicitly enabled PBX may use a configured public direct SIP/ICE endpoint; no automatic cross-tenant or cross-PBX bypass.
7. **Incoming cold-wake consolidation.** One approved session lookup, not two, before headless SIP registration.
8. **Audio-quality measurement and tuning.** A/B hardware vs software AEC/NS, PSTN/dongle codec behavior, and speaker boost limiting; only change defaults when device tests prove improvement.

Deferred:

- Full control-plane/tenant-process split.
- Removing one-use ticket semantics entirely.
- Any global direct-PBX bypass that ignores tenant/PBX assignment.
- Rewriting Asterisk, PBX routing, or dongle configuration.

## Review Focus

1. **Two PBXs, two extensions:** calls must keep the correct `pbxId`, extension, TURN relay, and SIP identity with no cache/session bleed.
2. **Same PBX, multiple extensions:** switching or reconnecting extension A must never use extension B's cached assignment or ticket.
3. **Gateway outage:** an approved existing session should survive transient control-plane errors; a new session may use direct fallback only for the assigned, opt-in PBX.
4. **Wi-Fi ↔ cellular during a call:** no duplicate claim, no 12 s ICE block, and no control-plane heartbeat exception drops the active call.
5. **Cold incoming wake:** notification plus one cached session lookup reaches SIP registration within the wake budget, without duplicate `/claim`.

---

### Task 1: Make media policy per-call and stop forcing TURN

**Files:**
- Modify: `src/network.ts` — stop forcing `iceTransportPolicy: 'relay'` solely because TURN is present.
- Modify: `src/sip/JsSipService.ts` — replace service-wide `mediaRelayRequired` behavior with per-session policy; expose direct/STUN candidates.
- Modify: `src/gateway/session.ts` — preserve gateway ICE servers but do not mark relay mandatory.
- Modify: `/mnt/g/suite/apps/sokrat-push-gateway-master/src/tenant-ice.js` — return TURN plus STUN/direct-capable configuration for the assigned PBX.
- Test: `__tests__/network.test.ts`
- Test: `__tests__/jsSipMedia.test.ts`
- Test: `/mnt/g/suite/apps/sokrat-push-gateway-master/test/tenant-ice.test.js`

**Interfaces:**
- Consumes: existing `MediaConfiguration` and `GatewaySession.assignment`.
- Produces: `MediaConfiguration` without an automatic `iceTransportPolicy: 'relay'`; a per-call `relayPolicy: 'auto' | 'relay-only'` passed only to that session's ICE gathering.
- Preserves: `gatewayMediaConfiguration()` still returns the assigned PBX's TURN credentials; it no longer means “relay mandatory.”

- [ ] **Step 1: Write the failing network/gateway tests**

Add to `__tests__/network.test.ts`:

```ts
it('keeps TURN as a fallback instead of forcing relay', () => {
  const configuration = buildMediaConfiguration({
    iceServers: ['turn:turn.example.com:3478?transport=udp'],
  });
  expect(configuration.iceServers).toHaveLength(1);
  expect(configuration.iceTransportPolicy).toBeUndefined();
});

it('keeps a no-TURN configuration usable without inventing relay', () => {
  const configuration = buildMediaConfiguration({
    iceServers: ['stun:stun.example.com:3478'],
  });
  expect(configuration.iceTransportPolicy).toBeUndefined();
});
```

Add to the mobile ICE media test:

```ts
it('does not wait for a relay candidate when a direct candidate is available', async () => {
  // Build a session/service with a host candidate and no relay candidate.
  // The local SDP must be released without waiting ICE_RELAY_WAIT_MS.
  // Assert the ready callback fires before the fake-timer relay budget.
});
```

Add to gateway `test/tenant-ice.test.js`:

```js
test('returns TURN for the assigned PBX without making relay mandatory', () => {
  // Call the ICE endpoint for pbx-demo and pbx-prod.
  // Assert each response contains only its own relay credentials and
  // no `iceTransportPolicy: 'relay'` client-side requirement.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```sh
cd /mnt/g/suite/apps/sokrat-mobile-main
npx jest __tests__/network.test.ts __tests__/jsSipMedia.test.ts --runInBand --forceExit
cd /mnt/g/suite/apps/sokrat-push-gateway-master
node --test test/tenant-ice.test.js
```

Expected: FAIL on the forced-relay assertions.

- [ ] **Step 3: Implement the per-call policy**

In `src/network.ts`:

- Remove the `requiresRelay` conversion to `iceTransportPolicy: 'relay'`.
- Keep `requiresRelay` only if the UI needs to display “TURN available”; do not use it to force relay.
- Keep empty ICE validation as a fatal configuration error.

In `src/sip/JsSipService.ts`:

- Replace `private mediaRelayRequired: boolean` with a per-session map or per-call value, for example:
  ```ts
  type SessionMediaPolicy = { relayOnly: boolean; generation: number };
  private mediaPolicies = new WeakMap<object, SessionMediaPolicy>();
  ```
- Set `relayOnly` only when the resolved configuration came from an explicit relay-only policy. For gateway calls, default to `auto`.
- Pass the call's `relayOnly` to `attachIceGathering`; do not let one call or warm-transfer consultation change another session's policy.
- Keep `gatewayMediaConfiguration()` for TURN credentials; do not use it to set global relay state.

In gateway `src/tenant-ice.js`:

- Return the assigned PBX's TURN URLs and credentials.
- Preserve the per-PBX relay lookup; never return a different PBX's relay.
- If the deployment provides a STUN URL for the same PBX, include it; otherwise host candidates remain available because relay is not forced.

- [ ] **Step 4: Add multi-PBX/multi-extension policy tests**

In `__tests__/jsSipMedia.test.ts`, add:

- Two simultaneous sessions with different `pbxId`/extension assignments; assert each receives its own media policy.
- A warm-transfer consultation session; assert changing one policy does not alter the other.
- A gateway call; assert `pcConfig.iceTransportPolicy` is absent and TURN remains in `iceServers`.

- [ ] **Step 5: Run the focused tests**

```sh
npx jest __tests__/network.test.ts __tests__/jsSipMedia.test.ts __tests__/gateway.test.ts --runInBand --forceExit
cd /mnt/g/suite/apps/sokrat-push-gateway-master
node --test test/tenant-ice.test.js test/relay-allocation.test.js
npx tsc --noEmit
```

Expected: PASS. Existing gateway TURN tests may need expectation updates only where they asserted forced relay.

### Task 2: Reduce ICE waiting and prewarm media

**Files:**
- Modify: `src/sip/JsSipService.ts:58-66,1370-1540` — lower relay-only budgets and release SDP on first usable candidate.
- Modify: `src/sip/JsSipService.ts` registration/connect — prewarm `resolveMediaConfiguration` after registration.
- Modify: `src/sip/JsSipService.ts` call options — set `iceCandidatePoolSize` to a small value (for example 2) for pre-gather.
- Test: `__tests__/jsSipMedia.test.ts`

**Interfaces:**
- `relayOnly` sessions get a short bounded budget: `ICE_RELAY_WAIT_MS = 2000`, `ICE_RELAY_GRACE_MS = 150`, `ICE_RELAY_CAP_MS = 1500` (verify on real devices before finalizing).
- `auto` sessions never wait for a relay candidate and release `ready()` as soon as the peer connection's candidate path is available.

- [ ] **Step 1: Write failing timing tests**

Use fake timers and assert:

- An `auto` gateway session with one host candidate releases before 2s, ideally before 300ms.
- A `relay-only` session with no candidate aborts at the new shorter budget.
- A relay candidate arriving during the grace releases immediately.
- A `prepareCall`/registration prewarm resolves `/ice` before the first dial.

- [ ] **Step 2: Run the tests to verify failure**

```sh
npx jest __tests__/jsSipMedia.test.ts --runInBand --forceExit
```

Expected: FAIL against the current 12,000ms budget or the first-dial HTTP fetch.

- [ ] **Step 3: Implement the shorter bounded gather**

- Change constants and all comments that refer to 10–15s.
- In `attachIceGathering`, only start `noRelayTimer` when `relayOnly`.
- In `auto`, call `readyFn()` on the first usable candidate; do not wait for `iceGatheringState === complete`.
- Abort only if `relayOnly` and no relay candidate/SDP relay line exists after the reduced budget.
- Prewarm media after SIP registration:
  ```ts
  ua.on('registered', () => {
    // existing recovery
    void this.resolveMediaConfiguration().catch(() => {});
  });
  ```
- Set `iceCandidatePoolSize: 2` only after measuring memory/CPU on the target phone; if it harms low-end Android, keep 0 and rely on prewarm.

- [ ] **Step 4: Run the focused tests and time a real device**

```sh
npx jest __tests__/jsSipMedia.test.ts __tests__/network.test.ts --runInBand --forceExit
npx tsc --noEmit
```

On the phone, record:
- first outgoing INVITE time;
- first incoming answer time;
- TURN allocation time;
- call setup-to-audio time on Wi-Fi and LTE.

Expected: no call waits 12s for relay when a direct path exists.

### Task 3: Cache approved assignments and remove duplicate claim calls

**Files:**
- Modify: `src/gateway/session.ts:145-220` — add a cached approved session path.
- Modify: `src/sip/JsSipService.ts:432-510` — use the cached session first.
- Modify: `src/push/pushHandler.ts:332-356` — remove the preliminary duplicate session lookup.
- Modify: `App.tsx` `attemptGatewayRestore`/`handleSaveAccount` only if needed to pass the cached path.
- Test: `__tests__/gateway.test.ts`
- Test: `__tests__/heartbeat.test.ts` or `__tests__/pushRegistration.test.ts`

**Interfaces:**
- Produces: `getCachedGatewaySession(host: string, extension: string): Promise<GatewaySession | null>`.
- `getCachedGatewaySession` reads only an approved persisted record with a matching extension; it performs no network request.
- Produces: `revalidateGatewaySession(session: GatewaySession): Promise<void>` in the background; failures mark the session stale but do not block an established UA.
- `getOrLoadGatewaySession` remains the full revalidation path for explicit login/recovery.

- [ ] **Step 1: Write failing tests**

Add to `__tests__/gateway.test.ts`:

```ts
it('uses a cached approved assignment without a claim request per connect', async () => {
  // Save one approved record for host+extension.
  // Call getCachedGatewaySession twice.
  // Assert the claim endpoint was called zero times.
});

it('keeps extension A and extension B sessions independent', async () => {
  // Approved assignments for ext 102 and ext 111 on the same PBX.
  // Assert each cached session retains its own extension and assignment.
});
```

Add to the push/heartbeat tests:

```ts
it('bootstraps an incoming wake with one session lookup', async () => {
  // mock getOrLoadGatewaySession and connect
  // Assert the wake path does not call getOrLoad twice.
});
```

- [ ] **Step 2: Run the tests to verify failure**

```sh
npx jest __tests__/gateway.test.ts __tests__/heartbeat.test.ts --runInBand --forceExit
```

Expected: FAIL because `connect()` calls `getOrLoadGatewaySession`, and `bootstrapHeadlessSip` calls it again.

- [ ] **Step 3: Implement the cached session**

- Add `getCachedGatewaySession` in `src/gateway/session.ts`:
  - Load the enrollment record for exact `(host, extension)`.
  - Require `gatewayMode`, `status === 'approved'`, matching assignment extension, and device id.
  - Build a session with the existing `createGatewaySession`; no `/claim`.
- In `JsSipService.connect`:
  - Try cached session first.
  - Only fall back to `getOrLoadGatewaySession` when no cached approved session exists or its generation is stale.
  - Keep `buildGatewaySipWebSocketUrl` ticket issuance; this is still one request per WS connect.
- In `bootstrapHeadlessSip`:
  - Let `connect()` resolve the cached session; remove the preliminary `getOrLoadGatewaySession` call.
  - Keep the 8s registration wait or reduce it only after measuring cold-wake latency.
- In `attemptGatewayRestore`:
  - Use the cached session to mount SIP immediately.
  - Start `getOrLoadGatewaySession`/claim revalidation in the background.
  - On explicit `revoked`/`rejected`, set blocked; do not clear the account.
- **Multi-extension guard:** `getCachedGatewaySession` must match both host and extension; never return a session from another extension.

- [ ] **Step 4: Add a background revalidation test**

- Cached session returns immediately.
- A slow `/claim` must not block the first SIP connect.
- A background revoked result sets gateway blocked and marks the cached session invalid.
- A different extension’s approved record is not returned.

- [ ] **Step 5: Run the focused tests**

```sh
npx jest __tests__/gateway.test.ts __tests__/heartbeat.test.ts __tests__/pushRegistration.test.ts --runInBand --forceExit
npx tsc --noEmit
```

Expected: PASS; claim count drops to zero on ordinary connect/reconnect paths.

### Task 4: Make transient control-plane failures non-destructive

**Files:**
- Modify: `/mnt/g/suite/apps/sokrat-push-gateway-master/src/sip-proxy.js:235-255`
- Modify: `/mnt/g/suite/apps/sokrat-push-gateway-master/src/device-tickets.js` only if needed to distinguish transient authorization failures.
- Test: `/mnt/g/suite/apps/sokrat-push-gateway-master/test/sip-proxy.test.js`
- Test: `/mnt/g/suite/apps/sokrat-push-gateway-master/test/device-tickets.test.js`

**Interfaces:**
- `isAuthorized` returning `false`/`null` remains a hard revocation and closes the session.
- `isAuthorized` throwing a transient error keeps the session open and retries; log only.
- No authorization result may be used for a different `(device, pbxId, extension, authorizationRevision)`.

- [ ] **Step 1: Write the failing proxy test**

```js
test('does not terminate a SIP session on a transient authorization exception', async () => {
  // Establish an authorized session.
  // Make isAuthorized throw once.
  // Advance the 10s heartbeat.
  // Assert the client is still open.
});

test('still terminates on explicit revocation', async () => {
  // Make isAuthorized return false/null.
  // Assert the client closes with authorization_revoked.
});
```

- [ ] **Step 2: Run the test to verify failure**

```sh
cd /mnt/g/suite/apps/sokrat-push-gateway-master
node --test test/sip-proxy.test.js test/sip-live-session.test.js
```

Expected: FAIL because the current heartbeat catch calls `session.close('heartbeat_exception')`.

- [ ] **Step 3: Implement the split**

- In `sip-proxy.js`, wrap `isAuthorized` in a try/catch.
- On explicit false/null: close with `authorization_revoked`.
- On exception: log, keep the session, and reschedule the next heartbeat; optionally count consecutive failures and close only after a long threshold.
- Preserve the route object and authorization revision used by the existing session; never recompute against another PBX/extension.

- [ ] **Step 4: Run gateway proxy tests**

```sh
node --test test/sip-proxy.test.js test/sip-live-session.test.js test/sip-handover.test.js
```

Expected: PASS; explicit revocation still closes, transient error does not.

### Task 5: Add guarded per-PBX direct fallback

**Files:**
- Modify: `/mnt/g/suite/apps/sokrat-push-gateway-master/src/control/store.js` — PBX record fields for `directWsURL`, `directApiURL`, and `allowDirectFallback` (default false).
- Modify: `/mnt/g/suite/apps/sokrat-push-gateway-master/src/control/router.js` — validate/expose the fields in the PBX editor.
- Modify: `/mnt/g/suite/apps/sokrat-push-gateway-master/src/tenant-runtime.js` — include the fields in the assignment only when enabled.
- Modify: `src/gateway/types.ts`, `src/gateway/client.ts`, `src/gateway/session.ts` — carry and validate the per-PBX fallback.
- Modify: `src/sip/JsSipService.ts` — use direct fallback only after gateway session creation fails, and only for the current assignment.
- Modify: `src/network.ts` — direct fallback uses the existing `/api/mobile/ice` path for the assigned PBX.
- Test: gateway `test/control-store.test.js`, `test/control-router.test.js`, `test/tenant-ice.test.js`.
- Test: mobile `__tests__/gateway.test.ts`, `__tests__/jsSipMedia.test.ts`.

**Interfaces:**
- `GatewayAssignment.fallback?: { wsURL: string; apiURL: string }`.
- `EnrollmentRecord`/assignment remains keyed by `pbxId` and `extension`.
- `JsSipService.connect` direct-fallback decision:
  ```
  if (gatewaySession creation fails) {
    use only gatewaySession.assignment.fallback when allowDirectFallback === true
  }
  ```

- [ ] **Step 1: Write failing multi-tenant tests**

- Two PBXs enabled with distinct direct URLs; a device assigned to demo must receive only demo's fallback.
- Fallback disabled: gateway failure must still fail closed.
- Fallback enabled: gateway failure uses direct SIP only for the assigned extension; TURN comes from the same PBX's `/api/mobile/ice`.
- Extension A on demo and extension B on prod must never use each other's fallback.

- [ ] **Step 2: Run tests to verify failure**

```sh
cd /mnt/g/suite/apps/sokrat-push-gateway-master
node --test test/control-store.test.js test/control-router.test.js test/tenant-ice.test.js
cd /mnt/g/suite/apps/sokrat-mobile-main
npx jest __tests__/gateway.test.ts __tests__/jsSipMedia.test.ts --runInBand --forceExit
```

- [ ] **Step 3: Implement the data model and validation**

- Add `directWsURL`, `directApiURL`, `allowDirectFallback` to each PBX record; default (`false`, empty URLs) keeps current behavior.
- Validate `directWsURL` is `ws:`/`wss:` and `directApiURL` is `http:`/`https:`.
- Include fallback fields in the assignment only if enabled and valid.
- Preserve `wsURL`/`apiURL` as the upstream PBX endpoints; do not use them as client fallback.
- Add UI fields to the existing PBX editor with explicit “enables direct fallback when gateway is unavailable” copy.

- [ ] **Step 4: Implement mobile fallback selection**

- On gateway session failure:
  - If the approved assignment has a valid fallback and the PBX flag is true, choose direct `wsURL` for JsSIP and direct `apiURL` for `/api/mobile/ice`.
  - Set a session-scoped `directFallback` flag; do not mutate the gateway assignment or other sessions.
  - If fallback fails, restore the gateway blocked/offline state; do not try another PBX.
- Reuse existing SIP credentials for the configured extension; do not reuse another extension's password/session.
- **No fallback for an unassigned PBX, a missing assignment, a revoked device, or an extension mismatch.**

- [ ] **Step 5: Run tests and a two-PBX manual test**

```sh
cd /mnt/g/suite/apps/sokrat-push-gateway-master
node --test test/control-store.test.js test/control-router.test.js test/tenant-ice.test.js
cd /mnt/g/suite/apps/sokrat-mobile-main
npx jest __tests__/gateway.test.ts __tests__/gatewayRouting.test.ts __tests__/jsSipMedia.test.ts --runInBand --forceExit
npx tsc --noEmit
```

Manual: stop gateway for the test device, verify only the explicitly enabled demo PBX falls back; verify extension 102 on demo cannot call through higher-travel-2's fallback.

### Task 6: Audio quality measurement and safe tuning

**Files:**
- Modify: `android/app/src/main/java/com/sokratmobile/MainApplication.kt` only if measurements support it.
- Modify: `src/sip/JsSipService.ts` codec/gain paths only if measurements support it.
- Modify: `src/ui/StandardPhoneScreen.tsx` speaker gain UI only if a limiter is added.
- Test: `__tests__/jsSipMedia.test.ts`, `__tests__/audioLevels.test.ts`, `__tests__/incallAudioRoute.test.js`.

- [ ] **Step 1: Record baseline audio metrics**

On the installed 1.2.8 build, measure:
- MOS/voice quality or at least packet loss/jitter/RTT during 5-minute calls;
- echo/noise on speaker, earpiece, wired, Bluetooth;
- CPU and battery during software AEC3/NS;
- PCMU vs Opus on internal and PSTN/dongle calls.

Do not change defaults from this task until the baseline is recorded.

- [ ] **Step 2: A/B hardware AEC/NS**

Create a temporary build variant or a runtime native setting that enables hardware AEC/NS while retaining software fallback. Test on the Honor device and at least one other Android OEM. Keep the variant only if call quality/CPU improves without new echo.

- [ ] **Step 3: Codec policy for PSTN/dongle**

Test PCMU vs Opus on external/dongle calls. If Opus introduces transcoding or setup delay, set the default preference to PCMU for external-number calls while retaining Opus for app-to-app. Do not infer target type from the extension alone; use PBX/trunk metadata or a user setting.

- [ ] **Step 4: Speaker boost limiter**

If >100% software boost clips or distorts, add a soft limiter or cap the default at 100% while keeping the user setting. Test earpiece, speaker, and Bluetooth.

- [ ] **Step 5: Run audio tests**

```sh
npx jest __tests__/jsSipMedia.test.ts __tests__/audioLevels.test.ts __tests__/incallAudioRoute.test.js --runInBand --forceExit
npx tsc --noEmit
```

### Task 7: Multi-tenant and multi-extension verification

**Files:**
- Test: mobile `__tests__/gateway.test.ts`, `gatewayRouting.test.ts`, `jsSipMedia.test.ts`, `pushRegistration.test.ts`.
- Test: gateway `test/tenant-ice.test.js`, `test/sip-proxy.test.js`, `test/control-store.test.js`, `test/control-router.test.js`.

- [ ] **Step 1: Multi-PBX test**

Use two PBX assignments with distinct `pbxId`, TURN relays, extensions, and direct fallback:
- demo / 102
- prod / 111

Assert:
- `getCachedGatewaySession` returns only the exact host+extension assignment.
- ICE configuration uses only that PBX's relay.
- Gateway failure for demo never uses prod fallback.
- A call on demo never resolves SIP to prod.

- [ ] **Step 2: Multi-extension test on one PBX**

Use demo / 102, demo / 111, demo / 302:
- Approve and cache all three.
- Connect one at a time; assert the active session and ticket are extension-specific.
- Switch extension; old session/ticket must not be reused.
- Trigger network handover; only the active extension reconnects.

- [ ] **Step 3: Concurrency/warm-transfer test**

- Start a call on 102 and a consultation session on another line/PBX only if the app supports it.
- Ensure per-session media policy, ICE gathering, and fallback state do not bleed.
- Ensure the gateway proxy keeps each `(pbxId, extension, deviceId)` authorization separate.

- [ ] **Step 4: Run final verification**

```sh
cd /mnt/g/suite/apps/sokrat-mobile-main
npx jest --runInBand --forceExit --testTimeout=30000
npx tsc --noEmit
cd /mnt/g/suite/apps/sokrat-push-gateway-master
npm test -- --runInBand
```

Expected: PASS. Device verification: one outgoing and one incoming call on demo/102, plus a second extension, with network handover and gateway failure/fallback.

## Final Device Verification

- [ ] Install the new build on the Honor DNY-NX9.
- [ ] Confirm demo/102 registration and two-way audio on Wi-Fi.
- [ ] Confirm demo/102 registration and two-way audio on LTE.
- [ ] Switch Wi-Fi → LTE during an active call; record audio interruption and recovery.
- [ ] Stop the gateway data plane; confirm only the explicitly enabled demo fallback is used; prod PBX is never used.
- [ ] Confirm multi-extension: 102, 111, and 302 remain independent on demo.
- [ ] Confirm no raw ticket/claim/TURN secret appears in logs.

## Self-Review

- **Spec coverage:** Tasks 1–7 cover forced relay, ICE delay, claim/ticket overhead, control-plane failure, guarded direct fallback, wake consolidation, and audio measurement.
- **Multi-tenant:** Every task has an explicit key or assignment constraint; direct fallback is per-PBX opt-in only.
- **Multi-extension:** Cache/session/ticket/ICE tests include multiple extensions on one PBX.
- **Step scan:** Each task starts with a failing test and has a focused verification command.
- **Deferred:** Full process split and global bypass remain explicitly out of scope.
