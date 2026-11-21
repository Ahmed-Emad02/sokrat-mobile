# Gateway Failure UX Implementation Plan

> **For agentic workers:** Execute task by task. Write or update the test before the change (`skill://test-driven`), and cite fresh evidence before claiming a task done (`skill://verification-before-completion`). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every gateway-side failure reaches the user as the truth: waiting for approval, wrong route, blocked network, or a device that needs revoking — never the blanket "Gateway detected but unreachable. Direct PBX fallback is disabled."

**Architecture:** `GatewayError.kind` already drives copy and retry policy. The defect is that eight unrelated conditions collapse into `fail_closed`. Split them into kinds with distinct copy, make "approval pending" a state rather than an error, and stop local storage faults from being reported as network faults. Fail-closed routing behaviour (never bypass the gateway) is unchanged.

**Tech Stack:** React Native + TypeScript, existing `src/gateway` module, jest with the fixtures in `__tests__/gateway.test.ts`, Gradle release build signed by `/mnt/g/suite/keystores/sokrat-mobile-release.jks`.

**Spec:** Reports from a real device: extension switch showed the blanket message although `/api/gateway/capabilities` answered 200 and the gateway returned an old approved assignment for another extension. Server side already fixed (probe has its own nginx zone, limiting answers 429). Remaining work is the app's failure taxonomy.

## Global Constraints

- Never weaken fail-closed media routing: a host that is a gateway must never fall back to direct PBX.
- Keep `fail_closed` for genuine "gateway present, bypass refused" cases only.
- No new network calls, no new permissions, no change to enrollment, SIP or media behaviour.
- Copy stays in `errors.ts`; screens must not inline new English strings.
- Phone 1.2.24 → 1.2.25 shipped the probe retry and stale-assignment realign; this plan builds on that code.
- Live diagnostics: temporary `access_log` lines added to `/etc/nginx/conf.d/sokrat-public-tls.conf` inside the gateway container must be removed after this work.

## Status (2026-11-15, 1.2.26 / 86)

Implemented in this pass: the kind split (`storage`, `route`, `blocked`, `conflict`, `enrollment`), truthful copy, `pending` as a waiting state in `sessionFromRecord` and the claim recheck, 409 conflict mapping by body code, storage faults no longer reported as transport faults, and the shared `APPROVAL_PENDING_MESSAGE`. Type-check (`tsc --noEmit` over the five modules) is clean.

Not yet verified: the jest suite (this container OOMs; must run elsewhere), the phone acceptance matrix, and removing the temporary nginx access-log lines.

## Review Focus

- Pending approval shows as waiting on login, restore, incoming push and SIP reconnect.
- A stale local approval re-enrolls (already) and still fails closed after two attempts.
- Storage faults and wrong routes never read as "unreachable".
- 409 conflicts are actionable, not an endless "PBX disabled" wait.
- No path reaches the user with the old blanket sentence except a real bypass refusal.

---

### Task 1: Split `fail_closed` into truthful kinds

**Files:** `src/gateway/errors.ts`, `src/gateway/client.ts`, `src/gateway/session.ts`, `src/gateway/enrollment.ts`, `src/gateway/storage.ts`.

**Interfaces:** extend `GatewayErrorKind` with `'storage' | 'route' | 'blocked' | 'conflict'` (`'pending'` already exists and is currently unused by these paths); `describeEnrollmentError` gains one case each plus a `'pending'` case; `failClosed` keeps its meaning.

- [ ] Storage faults (Task 4) map to `storage`; 404/`deviceApproval:false` on a remembered gateway map to `route`; 403 from an intermediary maps to `blocked`; enroll 409 conflicts map to `conflict`; pending records map to `pending`.
- [ ] Keep each message actionable in one line, e.g. route: "The server answered, but not as a PBX gateway. Check the Server field."; blocked: "This network blocked the gateway request."; conflict: "Revoke the old device in the gateway dashboard, then sign in again."
- [ ] Tests assert the kind and the copy for each cause, and that the blanket sentence appears only for a genuine bypass refusal.

### Task 2: Approval pending is a state, not a failure

**Files:** `src/gateway/session.ts`, `src/push/pushHandler.ts`, `src/sip/JsSipService.ts`, `src/calls/callerNameResolver.ts`, `App.tsx`.

**Interfaces:** `sessionFromRecord` and `getOrLoadGatewaySession` throw `GatewayError('pending', …)`; callers translate that into `PENDING_APPROVAL_MESSAGE` and a retry, never a sign-out or an error banner.

- [ ] `sessionFromRecord`: `pending | unclaimed | expired` → `pending` kind (today `fail_closed`).
- [ ] `getOrLoadGatewaySession`: claim returning pending/busy → `pending` kind after persisting the status.
- [ ] `JsSipService.connect` reconnect path: on `pending`, keep the account mounted, show "Waiting for administrator approval…", schedule the existing backoff retry.
- [ ] `pushHandler` incoming call while pending: no unreachable banner; skip wake with the pending copy.
- [ ] `callerNameResolver`: pending → resolve nothing (no throw to UI).
- [ ] Tests: pending record on login, on restore, and on push produce the pending copy and never the blanket sentence.

### Task 3: Enroll conflicts are actionable

**Files:** `src/gateway/client.ts` + tests.

**Interfaces:** `enroll()` 409 switches on the body error code instead of assuming `pbx_disabled`.

- [ ] `pending_cap_reached` → `pbx_disabled` (keep waiting).
- [ ] `device_already_approved`, `device_uuid_conflict`, `claim_identity_mismatch` → `conflict` with the revoke instruction.
- [ ] Unknown 409 → `conflict` using the server's message.
- [ ] Test: reinstall-style enroll with an approved device yields `conflict`, not an endless wait.

### Task 4: Local storage faults are not network faults

**Files:** `src/gateway/storage.ts` + tests.

- [ ] `loadEnrollmentRecord` stops wrapping its own `failClosed('Invalid gateway enrollment record')`; catch only the AsyncStorage rejection and raise `storage`.
- [ ] Same for `findInstallationEnrollment` and `isKnownGatewayHost` (`getAllKeys` may reject).
- [ ] Copy: "The app could not read its saved gateway enrollment. Sign in again to re-enroll." — never "unreachable".
- [ ] Test: a rejecting `AsyncStorage.getItem` produces `storage`, and a malformed record produces `storage` with the invalid-record detail preserved.

### Task 5: Existing tests that encode the old behaviour

**Files:** `__tests__/gateway.test.ts`.

- [ ] Replace "an unexpected assigned extension fails closed …" with the realign expectation, and add a persistent-mismatch case that still ends in `fail_closed` after `MAX_ASSIGNMENT_REALIGNS`.
- [ ] Keep the new regression tests (busy probe retries, persistent busy stays retryable, stale approval re-enrolls) green.
- [ ] Run the suite somewhere with memory headroom (`NODE_OPTIONS=--max-old-space-size=8192 npx jest --runInBand __tests__/gateway.test.ts`); this WSL container OOMs at 2 GB and did not finish at 6 GB in ten minutes — record the result honestly against whichever machine runs it.

### Task 6: Release 1.2.26 (86) and verify on the phone

**Files:** `android/app/build.gradle` (defaults), release artefacts.

- [ ] Default (non-production) versionCode/Name → 86 / "1.2.26"; production values via `SOKRAT_ANDROID_VERSION_CODE=86`, `SOKRAT_ANDROID_VERSION_NAME="1.2.26"`.
- [ ] Build signed (`-PproductionRelease=true`, keystore from `SOKRAT_RELEASE_*` environment only, never written to a file), verify `aapt dump badging` shows 86/1.2.26 and `apksigner verify --print-certs` matches `715572a5…`.
- [ ] Install over 1.2.25 and run the acceptance matrix: extension switch → waiting; incoming call while waiting → waiting copy; gateway container restart mid-login → retry, no dead end; revoked device → revoked copy; wrong Server field (e.g. `:8089`) → route copy.
- [ ] Remove the temporary nginx access-log lines on the gateway and reload; confirm the probe still answers 200.

### Task 7: Documentation

- [ ] Add a short "gateway failure copy" table to `MOBILE-PUSH.md` or `README.md` so support can map a message to a cause without reading code.
