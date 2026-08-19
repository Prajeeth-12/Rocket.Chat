# ADR 0003 — Media-call lifecycle events for apps

## TL;DR

- Apps implement a single `IMediaCallHandler` interface with one optional method per event.
- Four Phase 1 lifecycle events dispatch: post-started, post-participant-joined, post-ended, and
  pre-created (preventable and patchable).
- Every event context carries `origin`, derived from contact types; apps classify calls without
  knowing the routing rules.
- Two unlinked events fire for internal calls routed over SIP; a correlation from PBX signals would
  be unreliable.

## Status

**Accepted — Phase 1 implemented.** What this ADR decides is the Phase 1 surface in
[Decision](#decision); that part is built and shipped. Phases 2 to 4 (act, intervene, provide) are
**surveyed, not decided** — see the note at the head of
[Follow-ups](#follow-ups--the-remaining-phases). One part is rejected: linking the SIP loop-back leg
to the call it duplicates. See
[Rejected — link the loop-back leg](#rejected--link-the-loop-back-leg-to-the-call-it-duplicates).

- **Date:** 2026-08
- **Scope:** `packages/apps-engine` (definitions), `packages/apps` (listener manager),
  `apps/meteor/app/apps/server/bridges` and `apps/meteor/server/services/media-call` (host),
  `ee/packages/media-calls` (hook bus)
- **Depends on:** [ADR 0002](./0002-unified-event-result-for-pre-events.md) — the media-call
  pre-create event is `EventResult`'s first consumer
- **Supersedes:** the `apps-media-call-analysis` and `apps-media-call-origin-and-sip-loopback`
  proposals

The feature in scope is the Rocket.Chat **media call** — the 1:1 WebRTC/SIP direct-call system in
`ee/packages/media-calls` plus `packages/media-signaling`, surfaced through the `media-call`
core-service. It is a **distinct feature from Video Conferences**; video conf appears here only as
the architectural precedent for how apps-engine exposes a call-like domain.

## Decision

1. **One app-facing interface, one optional method per event.** `IMediaCallHandler`
   (`packages/apps-engine/src/definition/mediaCalls/`) has one optional method per event, keyed by
   `AppMethod` — the shape `IUIKitActionHandler` already established here. Per-event return-type
   narrowing and per-event opt-out survive, and an app never writes an internal `eventType` `switch`
   (the dispatch-side router of decision 2 is the engine's, not the app's).
2. **One `AppInterface` member and one envelope, not one per event.** Because the interface *is* the
   subscription, all four events travel under `AppInterface.IMediaCallHandler`: the host sends a
   `MediaCallEvent` envelope, the `ListenerBridge` has a single case for it, and
   `AppListenerManager.executeMediaCallEvent` (`:1303-1310`) routes on the envelope's `method`. This
   is the one place media calls depart from the message and room events, which spend one
   `AppInterface` member, one bridge case and one executor per event. Under the router there are two
   executors, one per event *kind* — the serial pre loop `executePreMediaCallCreated`
   (`:1312-1362`) and the post fan-out `executePostMediaCallEvent` (`:1375-1398`) — so prevent
   short-circuiting and patch chaining still live in an ordinary listener loop rather than in a
   reimplementation. Per-event return-type narrowing and per-event opt-out come from the handler
   interface, not from the dispatch, so collapsing the members costs neither.
3. **Four events in Phase 1.**
   - `executePostMediaCallStarted` — from `callActivated`
   - `executePostMediaCallParticipantJoined` — from a new `callAccepted` emitter event
   - `executePostMediaCallEnded` — from `callEnded`
   - `executePreMediaCallCreated` — preventable and patchable
4. **The pre event needs a hook bus in the EE engine, not an emitter subscription.** A veto has to
   be awaited, and the emitter is fire-and-forget. `IMediaCallServer.setHooks` /
   `runPreCallCreatedHook` is consulted synchronously inside `MediaCallDirector.createCall`.
   Prevention reuses the existing `CallRejectedError('forbidden')` contract. What an app patches is
   clamped on the way out: the features of a call with a `sip` contact are filtered to
   `SIP_CALL_FEATURES` again (`CallDirector.ts:34-47`), because the transport decides what it can
   carry and a patch must not put `screen-share` back on a PBX leg.
5. **Each post-event context carries the call snapshot and nothing the snapshot already holds.** The
   moment, the participant that joined and the way the call ended are all already on the call
   (`activatedAt` / `acceptedAt` / `endedAt`, `callee`, `endedBy` / `hangupReason`); a flat copy
   beside `call` would only be a second place to read the same value. Each context narrows its
   snapshot so the timestamp it is named after is a required `Date` (`IActiveMediaCall`,
   `IAcceptedMediaCall`, `IEndedMediaCall`). The one field that stays outside is
   `IMediaCallEndedContext.durationMs`: the call carries the two timestamps it is computed from, not
   the result.
6. **The transition hands the call over, and one call's events reach an app in order.** The three
   guarded state changes are `findOneAndUpdate`s that return the call the transition produced
   (`MediaCalls.ts:90-155`), and `callAccepted` / `callActivated` / `callEnded` carry that document
   (`IMediaCallServer.ts:16-29`, emitted at `CallDirector.ts:74,100,436`). Nothing reads the call
   again on the way to an app, so the snapshot is the call **as of the transition**: an event
   describes the call it is about, even when the call moves on while the notification waits, and a
   post event costs no query of its own. Losing that read is also what puts the events of one call
   in order: `MediaCallService.notifyApps` defers each one with `setImmediate`, which runs them in
   the order they were queued, and a notification now awaits nothing between there and the JSON-RPC
   request the app receives (`triggerEvent` → `handleEvent` → `executeListener` →
   `executePostMediaCallEvent` → `ProxiedApp.call` → `sendRequest`, all synchronous up to the write
   to the subprocess). An app is told a call started before it is told the call ended. What a
   context still only guarantees is the timestamp it is named after, so `getEventTimestamp`
   (`appEvents.ts:100-106`) drops the event and logs rather than emit one without it.
7. **The prevention reason reaches the caller as a toast.** A `CallRejectionMessage`
   (`packages/media-signaling/src/definition/call/common.ts`) carries plain text or an `i18n` key
   with its `args`, threaded through `PreCallCreatedHookResult.message` →
   `CallRejectedError.rejectionMessage` → the `rejected-call-request` signal → the client's
   `rejected` call event and `rejectedCall` session event → `useCallRejectionToast`
   (`packages/ui-voip/src/providers/`). App keys resolve against the `app-${appId}` namespace the
   client registers translations under, and fall back to a workspace message. The same path carries
   the rejections the server already sent on its own (`Call_rejected_*` in `packages/i18n`); the
   protocol-level ones stay silent on purpose.
8. **Every event carries an `origin`, derived at dispatch time from the two contacts.** It is not
   persisted and not patchable. Without it, an app's only signal for where a call comes from is
   `caller.type` / `callee.type` plus knowledge of the routing rules — host knowledge apps should
   not have to reimplement. See [`origin`](#origin--where-a-call-comes-from).
9. **Nothing links the two legs of a SIP-routed internal call.** The correlation cannot be made
   reliable from what the PBX tells us, and a wrong link is worse than no link. Both legs fire their
   own events, each labelled with its own `origin`.

### What an app receives today

The three payloads the nine decisions above add up to, as an app sees them.

A plain WebRTC call between two workspace users:

```jsonc
// executePreMediaCallCreated
{
  "caller":    { "type": "user", "id": "aaa", "username": "user1" },
  "callee":    { "type": "user", "id": "bbb", "username": "user2" },
  "createdBy": { "type": "user", "id": "aaa", "username": "user1" },
  "features":  ["audio", "video"],
  "origin":    "internal"
}
```

The same user-to-user call with SIP integration enabled for internal calls fires
`executePreMediaCallCreated` **twice** (decision 9), and each run is labelled but unlinked:

```jsonc
// run #1 — the leg Rocket.Chat sends to the PBX
{ "caller": { "type": "user", "id": "aaa", "username": "user1" },
  "callee": { "type": "sip",  "id": "1002", "username": "user2", "sipExtension": "1002" },
  "createdBy": { "type": "user", "id": "aaa", "username": "user1" },
  "features": ["audio"],
  "origin": "sip-outbound" }

// run #2 — the INVITE the PBX routes straight back in (same conversation)
{ "caller": { "type": "sip",  "id": "1001", "username": "user1", "sipExtension": "1001" },
  "callee": { "type": "user", "id": "bbb", "username": "user2" },
  "createdBy": { "type": "sip",  "id": "1001", "username": "user1", "sipExtension": "1001" },
  "features": ["audio"],
  "origin": "sip-inbound" }
```

A genuinely inbound call from outside the workspace looks like run #2. That is the ambiguity
decision 9 leaves open — why the two runs cannot be linked is
[The open problem](#the-open-problem--one-call-two-events); how they are produced is
[How one call becomes two](#how-one-call-becomes-two).

## Consequences

- Apps get one cohesive interface to implement, with per-event opt-out and per-event return-type
  narrowing, and they inherit prevent/patch composition from the listener loop.
- Apps can classify every media call as `internal`, `sip-outbound` or `sip-inbound` without knowing
  the routing rules. Calls already in the database report the correct origin; no migration, no
  persisted field.
- A new media-call event is cheaper than a new event elsewhere in the engine, because the envelope
  dispatch of decision 2 is already wired for the whole family: a post event needs no listener-manager
  change at all, and none of the four events needs an `AppInterface` member or a bridge case of its
  own. The cost moves rather than disappearing — the family shares one `IListenerExecutor` `result`
  union, so a pre event with a new return shape widens it for every member. See
  [the wiring recipe](#adding-an-event--the-wiring-recipe).
- **Apps still see one internal SIP-routed conversation as two unlinked calls**, and still see
  `callee.type === 'sip'` for a call between two workspace users. An app that needs one record per
  conversation has no host-provided way to deduplicate.
- An app returning `prevent` on the inbound leg rejects only that leg — the outbound leg is already
  ringing by then, so the result is a call the PBX cannot complete rather than a cleanly refused
  one. **An app that means to block a call must act on the outbound leg**, that is, on the event
  where `origin` is `sip-outbound` or `internal`.
- The two legs are not equivalent, which matters for any app that picks one. The **outbound** leg's
  timestamps track the PBX dialog (`OutgoingSipCall.createDialog:113`, the accept at `:266`,
  `sipDialog.on('destroy'):207`), so it spans the actual conversation and its duration and hangup
  reason are meaningful; its `uids` lists only `user1`. The **inbound** leg carries `user2` in
  `uids` and reports `user2`'s own accept, so it is the leg that says the callee actually answered.

## Deliberate gaps in Phase 1

Recorded so they are not mistaken for oversights.

- **No `IMediaCallRead`.** Apps see only the calls they are handed by an event. There is no accessor
  for reading a call by id, so no way to answer "is this user on a call right now?".
- **No `MEDIA_CALL` association.** Nothing lets an app declare that it handles media calls, so the
  events dispatch to every app implementing `IMediaCallHandler` with no way to narrow the
  subscription.
- **The loop-back legs stay unlinked**, as decided above.
- **The pre event fails open when the app's request times out.** `executePreMediaCallCreated`
  rethrows the errors it sees, so an app that throws blocks the call — a policy handler that could
  not decide must not read as `pass`. A *timed-out* request never reaches that branch:
  `ProxiedApp.call` (`packages/apps/src/server/ProxiedApp.ts:64-86`) rethrows only
  `AppsEngineException` and `JSONRPC_METHOD_NOT_FOUND`, and a timeout rejects with a plain `Error`
  whose `code` is `undefined`, so both range checks are false and the method returns `undefined`
  with nothing logged. The listener loop reads that as "no result" and the call is created.
  This is not specific to media calls — every pre-event in the engine fails open the same way
  (`executePreMessageSentPrevent` and the rest) — and closing it means either a call path that does
  not swallow, or a sentinel that separates method-not-found from a swallowed failure. Left as is
  in Phase 1 deliberately: fail-closed here means a slow app subprocess stops users from placing
  calls, and that trade is the engine's to make once, not this event's to make alone.
- **The event order of decision 6 holds inside one instance, and rests on a synchronous dispatch
  path.** Both the emitter and `Apps.self.triggerEvent` are in-process, so an instance tells its own
  apps about the transitions it performed itself; a call whose transitions land on two instances is
  reported by each of them, in no particular order between the two. An `await` added anywhere
  between `notifyApps` and `ProxiedApp.call` would also reorder the events of a single call, and
  nothing in the engine enforces that it stays out.
- **`ee/packages/media-calls` has no test harness at all** — no `test` script in its `package.json`
  and no spec files. `CallDirector`'s pre-hook branch and the `IncomingSipCall` rejection mapping are
  therefore covered by the Playwright suite only. Standing up mocha (or `node:test`) for that
  package is a prerequisite for unit-testing anything further in Phase 2 or 3.

## Context

### The three layers of apps-engine in this monorepo

The historical standalone apps-engine is split across three locations. Any media-call extension
touches all three.

| Layer | Location | Contents |
|---|---|---|
| **SDK / definitions** (published `@rocket.chat/apps-engine`) | `packages/apps-engine/src/definition/` | `AppInterface`, `AppMethod`, handler interfaces, accessor interfaces, context/permission/association types. `package.json` ships only `definition/**` (`packages/apps-engine/package.json:37-39`). |
| **Engine runtime** (published `@rocket.chat/apps`) | `packages/apps/src/` + `packages/apps/base-runtime/src/` | `src/server/managers/` (`AppListenerManager`, `AppVideoConfProviderManager`), abstract `src/server/bridges/`, `src/server/{AppManager,ProxiedApp}.ts`, `src/converters/`. The **concrete accessors are not here** — they live in `base-runtime/src/lib/accessors/` (`read/`, `modify/`, builders, extenders) and are assembled in `accessors/mod.ts`; there is no `AppAccessorManager` — see [ADR 0001](./0001-app-accessor-logic-in-base-runtime.md). |
| **Host (real Rocket.Chat)** | `apps/meteor/app/apps/server/` + `apps/meteor/ee/server/apps/` | Concrete bridge subclasses, converters, orchestrator (`ee/server/apps/orchestrator.ts`). |

The host imports the engine from `@rocket.chat/apps/dist/...`, so **the `packages/apps` build must
be regenerated** for host changes to see new engine code
(`apps/meteor/app/apps/server/bridges/bridges.js:1`).

### The media call domain object

Persisted record — `IMediaCall` (`packages/core-typings/src/mediaCalls/IMediaCall.ts:35-74`):

- `service: 'webrtc'`, `kind: 'direct'` — only 1:1 direct WebRTC/SIP calls exist today (`:36-37`).
- `state: 'none' | 'ringing' | 'accepted' | 'active' | 'hangup'` (`:33,39`). The stored enum is
  deliberately smaller than the client state machine, which also has `renegotiating`.
- Actors: `caller: MediaCallSignedContact`, `callee: MediaCallContact`, `createdBy: MediaCallContact`
  (`:41,44-45`). `MediaCallActorType = 'user' | 'sip'` (`:5`); `contractId` is the per-session
  signing token (`:7-15`).
- Lifecycle timestamps `acceptedAt`, `activatedAt`, `expiresAt` (`:52-57`); end fields `ended`,
  `endedBy`, `endedAt`, `hangupReason` (`:47-50`); transfer fields `transferredBy/To/At`,
  `parentCallId` (`:60,63-65`); `divertedBy` for a call the PBX forwarded (`:68`, RFC 5806
  `Diversion`) — a diversion is not a transfer and carries no `parentCallId`.
- `uids: string[]` (`:70`), `features: string[]` (`:73`) — the negotiated capability set, finalized
  on accept.

Negotiation record — `IMediaCallNegotiation`: one document per SDP (re)negotiation round. **SDP
offer/answer payloads are persisted there.**

State transitions are enforced as **race-safe guarded updates** on the model — this is where the
persisted state machine actually lives: `startRingingById` (`MediaCalls.ts:80-88`), `acceptCallById`
(`:90-117`), `activateCallById` (`:119-134`), `hangupCallById` (`:136-155`), `transferCallById`
(`:169-188`). The three that a post event reports are `findOneAndUpdate`s and return the call they
produced; the others return an `UpdateResult`, because nothing needs the document.

### The lifecycle engine and its event emitter

`callServer = new MediaCallServer()` (`ee/packages/media-calls/src/server/configuration.ts:6`) is the
singleton gateway. `MediaCallDirector` (`ee/packages/media-calls/src/server/CallDirector.ts`) is the
**state-machine authority — every DB transition converges there**, which makes it the natural
interception choke point.

Before this work the only outward event channel was a typed `Emitter`, `MediaCallServerEvents`
(`ee/packages/media-calls/src/definition/IMediaCallServer.ts:16-24`): `callUpdated`,
`callActivated`, `callEnded`, `signalRequest`, `historyUpdate`, `pushNotificationRequest`.
`callAccepted` is the one member this work added, and every payload carries ids only — see
decision 6.

### The integration seam

`MediaCallService` (`apps/meteor/server/services/media-call/service.ts`) is the thin Meteor adapter
over the EE `callServer` engine. Its constructor (`service.ts:40-63`) wires the emitter into the rest
of Rocket.Chat — `signalRequest`, `callUpdated`, `callActivated` (sets Presence BUSY), `callEnded`
(clears Presence), `historyUpdate` (`saveCallToHistory`), `pushNotificationRequest` — and is exactly
where the apps-engine dispatch subscribes, mirroring how it already forwards these events onto the
microservice bus. The service also owns the permission and feature callbacks injected into the engine
(`getMediaServerSettings` `:430-456`, `userHasMediaCallPermission` `:470-478`,
`userHasFeaturePermission` `:458-468`) — an existing, function-shaped extension seam.

### How apps-engine extension mechanisms work

**Pattern A — events / listeners (host → app: notify, veto, enrich).** An `AppInterface` member names
a hookable event; an `AppMethod` names the method(s) the engine calls. Host code fires
`Apps.self?.triggerEvent(AppEvents.X, …)` → `AppServerOrchestrator.triggerEvent` →
`getListenerBridge().handleEvent()` → `AppListenerManager.executeListener()` →
`app.call(AppMethod.…)`. Handler kinds are distinguished by the accessors they receive: Pre-Prevent
returns `boolean` and any `true` short-circuits; Pre-Extend gets an additive extender; Pre-Modify
gets a full builder; Post gets the full accessor set, returns `void`, fire-and-forget.

**Pattern B — provider registration (an app *backs* a capability; the host calls into it on demand).**
Used by video conf: an app registers a provider during `extendConfiguration`, the engine tracks it in
`AppVideoConfProviderManager`, and the host RPCs into it when needed.

**Data accessors (app → host read/modify).** `IRead` is a facade of sub-readers; `IModify` splits into
creator/updater/extender/deleter. Each accessor is a thin per-app wrapper delegating to a `do*`
bridge method that performs the **permission check** then calls a `protected abstract` method the
host implements. The canonical minimal precedent is `IVideoConferenceRead` → `VideoConferenceRead` →
`VideoConferenceBridge` → host `AppVideoConferenceBridge` → converter → core-service.

## `origin` — where a call comes from

Nothing in `IPreMediaCallCreatedContext` or the app-facing `IMediaCall` used to say whether a call is
a pure WebRTC call between two workspace users, a call going out through the PBX, or a call arriving
from it. `service` is always `'webrtc'` (`CallDirector.ts:197-202`), so it does not answer the
question.

### The information already exists at dispatch time

Both contacts are final before either event is built, and their types *are* the origin:

| `caller.type` | `callee.type` | origin |
| --- | --- | --- |
| `user` | `user` | never leaves the workspace |
| `user` | `sip` | placed out through the PBX |
| `sip` | `user` | arrived from the PBX |

`sip`/`sip` cannot occur: `parseCallContacts` rejects a non-user caller for an external callee
(`MediaCallServer.ts:238-241`), and `getCalleeFromInvite` requires a user callee
(`IncomingSipCall.ts:435`).

### Shape

```ts
/** How this call reaches the outside world, and which side opened it. */
export type MediaCallOrigin = 'internal' | 'sip-outbound' | 'sip-inbound';
```

`'internal'`, not `'webrtc'`: WebRTC carries the media of a SIP leg as well, so the transport does
not tell an app where a call came from — which is the whole point of the field. `service` keeps
reporting `'webrtc'`, and it keeps meaning the transport.

`origin` is added to `IPreMediaCallCreatedContext` and to the app-facing `IMediaCall`, so pre and
post events agree. It is **not patchable**: `MediaCallCreatePatch` stays `Pick<..., 'features'>`, and
`AppListenerManager.getMediaCallCreatePatch` (`:1371-1385`) drops anything that is not `features` —
along with a patch that is not an object at all, since `isEventResult` checks the marker and not the
payload under it.

### Where it is computed

One helper in `apps/meteor/server/services/media-call/appEvents.ts`, used by both sides — pre, where
`runPreMediaCallCreatedAppHook` already receives both contacts in `PreCallCreatedHookParams`, and
post, where `toAppMediaCall` already has `call.caller` / `call.callee`:

```ts
function getCallOrigin(caller: MediaCallContact, callee: MediaCallContact): MediaCallOrigin {
	if (caller.type === 'sip') return 'sip-inbound';
	if (callee.type === 'sip') return 'sip-outbound';
	return 'internal';
}
```

Two consequences worth stating: **nothing changes in `ee/packages/media-calls`** for `origin` — no
new hook param, no new persisted field — and calls already in the database report the correct origin,
because it is derived from data they already carry.

### `divertedBy` is a neighbouring signal, not a substitute

`divertedBy` landed with #40560 (the RFC 5806 `Diversion` header) and reaches apps on both shapes:
`IncomingSipCall.getDiversionContactFromInvite` parses the header and resolves the extension to a
contact (`IncomingSipCall.ts:469-497`); `CallDirector.createCall` hands it to the pre-create hook and
persists it (`:218,254`); `toAppMediaCall` maps it into `context.call` (`appEvents.ts:90`).

It answers a different question. `origin` says how a call reaches the outside world; `divertedBy`
says why it arrived at *this* callee instead of the one that was dialled. The two compose: a diverted
call is always `sip-inbound`, and `divertedBy` cannot appear on an `internal` or `sip-outbound` call,
because only an inbound INVITE carries the header. So `origin` needs no diverted variant.

One asymmetry: `getNewCallTransferredBy` returns `divertedBy` ahead of the transfer check
(`server/signals/getNewCallTransferredBy.ts:5-9`), so clients label a diverted call as *transferred
by* the diverting party. Apps get the same fact under its own name and with no `parentCallId`,
because no earlier call was replaced. An app reconciling its own view with what the user sees must
read `divertedBy` as the client's `transferredBy`.

### The gap `origin` leaves

An internal call routed over SIP reports `sip-outbound` — true about the transport, silent about the
call being between two workspace users. The outbound leg cannot answer this at pre time: whether the
PBX routes the INVITE back into this workspace is known only once it does. An `internal: boolean` on
the pre-create context would therefore have to lie on exactly the case that motivates it. That is the
open problem below.

## The open problem — one call, two events

With SIP integration enabled *for internal calls*, a single user-to-user call is created twice: once
for the leg Rocket.Chat sends to the PBX, and once for the INVITE the PBX routes straight back in.
An app can tell that *a* SIP leg is involved; it cannot tell that the two legs are one conversation,
and has no reason to expect two. The two payloads are side by side under
[What an app receives today](#what-an-app-receives-today).

### How one call becomes two

`executePreMediaCallCreated` has exactly one trigger point — `MediaCallDirector.createCall`
(`CallDirector.ts:218`, via `runPreCallCreatedHook` → `runPreMediaCallCreatedAppHook`). So a double
execution means `createCall` ran twice. With `VoIP_TeamCollab_SIP_Integration_Enabled` **and**
`VoIP_TeamCollab_SIP_Integration_For_Internal_Calls` on (`service.ts:431-439` →
`routeExternally: 'always'`), it does:

1. `user1` presses call → `request-call` → `notifications.module.ts:299` →
   `GlobalSignalProcessor.processRequestCallSignal` (`internal/SignalProcessor.ts:194`) →
   `MediaCallServer.requestCall` (`server/MediaCallServer.ts:92`).
2. `parseCallContacts` routes the callee through `getCalleeContactOptions`
   (`MediaCallServer.ts:287-314`). With internal calls routed externally the option is
   `{ requiredType: 'sip' }`, so `user2` resolves to the **sip contact for their extension**
   (`server/CastDirector.ts:160-167`).
3. `MediaCallServer.createCall:128` sees `callee.type === 'sip'` → `OutgoingSipCall.createCall`
   (`sip/providers/OutgoingSipCall.ts:46-77`) → `mediaCallDirector.createCall` → **event run #1**.
4. `OutgoingSipCall.createDialog:136` INVITEs `sip:<user2 ext>@<SIP_Server_Host>`
   (`sip/Session.ts:102`).
5. The PBX dialplan resolves that extension back to Rocket.Chat, so drachtio hands the same
   workspace an inbound INVITE: `srf.invite` (`sip/Session.ts:140`) → `processInvite:166` →
   `IncomingSipCall.processInvite` (`sip/providers/IncomingSipCall.ts:48`), where
   `getCalleeFromInvite:435` maps the called number to `user2` and `getCallerContactFromInvite:499`
   rebuilds `user1`'s identity → `mediaCallDirector.createCall:103` → **event run #2**.

Two `IMediaCall` documents result, each holding one real participant: the outbound leg has
`uids: [user1]` (a sip callee contributes no uid, `CallDirector.ts:245-249`), the inbound leg
`uids: [user2]`.

The same doubling occurs with only `..._SIP_Integration_Enabled` on, whenever the PBX happens to
route an outbound leg back into the workspace (for example a DID mapped to a workspace extension);
user-to-user calls then stay internal (`routeExternally: 'never'`) and fire once.

### Why the duplicate is unrecognisable to apps

`IPreMediaCallCreatedContext` deliberately carries no call id (nothing is persisted yet), so the
only material an app has is the contacts and the features:

| context field | outbound leg | inbound leg | same? |
| --- | --- | --- | --- |
| `caller.username` | `user1` | `user1` (from `X-RocketChat-Caller-Username`, or resolved from the extension) | yes |
| `callee.username` | `user2` (sip contact built from the user record) | `user2` | yes |
| `createdBy.username` | `user1` (the requester) | `user1` (`createdBy = requestedBy \|\| caller`, `CallDirector.ts:215`) | yes |
| `features` | client list filtered to `SIP_CALL_FEATURES` (`OutgoingSipCall.ts:70`) | `SIP_CALL_FEATURES` verbatim (`IncomingSipCall.ts:109`) | yes, unless the client asked for fewer |
| contact key set | `type,id,username,displayName,sipExtension` | same | yes |
| `caller.type` / `callee.type` | `user` / `sip` | `sip` / `user` | **no** — mirrored |
| `createdBy.type` / `.id` | `user` / uid of `user1` | `sip` / `user1`'s extension | **no** — `createdBy` *is* the caller contact on the inbound leg, since `IncomingSipCall` passes no `requestedBy` (`IncomingSipCall.ts:104-111`) |
| `caller.id` / `callee.id` | uid / extension | extension / uid | **no** — mirrored |

The two contexts are distinguishable, just not *linkable*: every difference is the `user`/`sip`
mirroring, which an unrelated pair of real calls between the same two people would also show. An app
logging usernames and features — including the e2e fixture app `media-call-events-test` — sees two
entries that differ only by log timestamp.

`divertedBy` does not narrow this. A loop-back leg carries no `Diversion` header — the PBX routes our
own leg back, it does not forward a line — so `divertedBy` is absent on exactly the calls a
correlation would have to recognise.

## Alternatives considered

### The app-facing shape — four prototypes

Four prototypes were built end-to-end. All four emit the same typed events and all four return
`EventResult` from pre-events; they differ **only in how an app subscribes** and **how the engine
dispatches**.

| Dimension | P1 — per-event interfaces (Pattern A) | P2 — `registerMediaCallManager` | P3 — one interface, two methods | **P4 — one interface, one method per event (chosen)** |
|---|---|---|---|---|
| **Author mental model** | "Implement the handler interface for each event." Same as every other RC app event. | "Fill in the hooks I want on one object and register it." Same as `provideVideoConfProvider`. | "Implement one interface, two methods; `switch` on `context.eventType`." | "Implement one interface; fill in the per-event methods I want." The `IUIKitActionHandler` model. |
| **Subscription** | Implicit, per event. | Explicit, one registration call. | Implicit, but per *group* — one method subscribes all pre or all post events. | Implicit, per event — every member is its own optional method. |
| **Discoverability** | Interface list is the menu. | Best single "here is everything you can hook" surface. | Weakest — the event menu hides one level down in the `eventType` union. | Strong — autocomplete lists every optional method on one interface. |
| **Return-type narrowing** | Per-interface restricted union. | Same, on the object method. | **Lost** — enforced against the whole pre-event union, not per `eventType`. | Per-method restricted union, like P1. |
| **Per-event opt-out** | Don't implement the interface. | Omit the method. | Coarse — a `switch` `default` or a missing case. | Cleanest — omit the method. |
| **Composition across apps** | Inherited from the listener loop. | **Reimplemented** in a manager-manager fan-out. | Inherited. | Inherited. |
| **Engine wiring cost** | Full recipe per event. | One-time scaffold, then just add methods. | One-time, per method group. | One-time scaffold (member, bridge case, envelope, router), then a method plus an envelope union member; a post event needs no manager change. |
| **Fit with existing architecture** | High — it *is* the events architecture. | Medium — provider registration repurposed for events. | Medium-high — a shape no other RC event surface uses. | High — the listener engine plus a shape RC already has. |

**Why P4.** Media-call events are **broadcast**: every interested app should observe, and several
may veto. VideoConfProvider selects *one* provider by name and RPCs into it, so P2 had to
re-implement the prevent-wins and patch-chaining Pattern A gives for free — the core objection to it.
P3 keeps the listener engine but trades away per-event return-type narrowing, which `EventResult`'s
restricted unions depend on ([ADR 0002](./0002-unified-event-result-for-pre-events.md), decision 5);
if two media-call pre-events ever permit different variants, P3 cannot express it. P4 keeps every
type-level guarantee P1 has, collapses N interfaces into one app-facing surface, and adds no
conceptual novelty because `IUIKitActionHandler` already has that shape. As built it also grows more
cheaply than P1, because the envelope dispatch is scaffolded once for the family (decision 2); what it
gives up in exchange is a per-event `IListenerExecutor` `result` type, since the family shares one
entry.

A hybrid remains available if both surfaces ever test well: keep P2's author-facing object but have
its registration fan into the listener manager internally, so composition is not duplicated.

### Rejected — link the loop-back leg to the call it duplicates

Recorded so the next person does not re-derive it. The proposal was: on the inbound INVITE, correlate
against the still-live outbound leg, persist the verdict on the inbound call as `loopbackOf`, and
surface it on that leg's events. Both legs keep firing; an app that wants one conversation drops the
leg with `loopbackOf` set, and one that wants both joins them on it.

**The rule.** *This INVITE is a loop-back if `req.callingNumber` belongs to workspace user A and a
not-ended call exists whose caller is `{type: 'user', id: A}` and whose callee is the sip contact for
`req.calledNumber`.* It would need one finder,
`findOneNotEndedByCallerAndSipCallee(callerUid, sipExtension, options?)`, on `IMediaCallsModel`.
Leading the query with `{ ended: false, uids: callerUid, expiresAt: { $gt: now } }` reuses the
existing `{ ended: 1, uids: 1, expiresAt: 1 }` index (`MediaCalls.ts:33`), with the caller/callee
fields as the residual filter — no new index.

**The ordering is safe.** The outbound document is inserted (`CallDirector.ts:261`) and flipped to
`ringing` (`OutgoingSipCall.ts:125`) *before* `createSipDialog` emits the INVITE (`:136`), so the
record is always present and not-ended when the loop-back arrives. Transfers routed externally
produce the same outbound-then-loop-back pair (`UserActorAgent.onCallTransferred:134` →
`requestCall`), so the match must **not** be conditioned on `parentCallId` being absent.

**Why it is rejected.** The rule's only reliable half is the caller/extension match, and it has a
false-positive window: an external caller who presents a workspace extension as caller-ID during the
dial window gets their genuinely external call reported as a loop-back of an unrelated outbound one.
Adding `X-RocketChat-Origin-Call-Id` to the outbound INVITE (`OutgoingSipCall.createDialog` already
sets `Referred-By` for transfers, `:142-146`) does not fix this. The header survives only if the
dialplan copies custom headers across the bridge (FreeSWITCH needs `sip_copy_custom_headers`), and it
is spoofable, so it may only *select* among already correlated candidates — otherwise an external
caller presents an arbitrary call id and turns a spoofable header into a claim about who is calling.
Used correctly it reduces to the caller/extension rule plus a tie-break, so it cannot rescue it.
Reporting the wrong pair of calls as one conversation is worse than reporting neither.

**What was also considered and is moot now.** Whether `loopbackOf` should also be written on the
outbound leg so the pair is navigable from either end (a second write to an already-ringing call,
arriving after that leg's pre event), and whether `duplicateOf` or `sameConversationAs` would be a
better app-facing name than a term describing a PBX routing artefact.

## Adding an event — the wiring recipe

Because of decision 2, a **fifth media-call event** is cheaper than a new event elsewhere in the
engine: `AppInterface`, the bridge and the `IListenerExecutor` map are already wired for the whole
family and are not touched again.

1. `packages/apps-engine/src/definition/metadata/AppMethod.ts` — add the `EXECUTE…` method name.
   Media-call events have **no `CHECK…` companion**: the executors call the `EXECUTE…` method
   directly and read a `JSONRPC_METHOD_NOT_FOUND` rejection as "this app did not implement it",
   which is what makes every member of `IMediaCallHandler` optional.
2. `packages/apps-engine/src/definition/mediaCalls/` — add the context type and the method on
   `IMediaCallHandler`; add the member to the `MediaCallEvent` envelope union in `IMediaCallEvent.ts`.
3. `packages/apps-engine/src/definition/mediaCalls/index.ts` — export them.
4. `packages/apps/src/server/managers/AppListenerManager.ts` — **for a post event, nothing**:
   `executePostMediaCallEvent` dispatches any envelope member it is handed. For a pre event, add a
   branch to `executeMediaCallEvent` and its own serial executor loop, and widen the
   `IListenerExecutor` entry's `result` union.
5. Host trigger site — `apps/meteor/server/services/media-call/appEvents.ts`, plus the emitter or
   hook subscription in `service.ts`.
6. Rebuild `@rocket.chat/apps`.

`apps/meteor/app/apps/server/bridges/listeners.ts` needs no edit — its single
`AppInterface.IMediaCallHandler` case already carries the envelope, and payloads arrive app-shaped
from `appEvents.ts` rather than through a converter. `AppImplements` detection is automatic via
`Object.keys(AppInterface)`.

Adding an event under a **new** `AppInterface` member — the recipe every other event family uses —
additionally costs the enum member, an `IListenerExecutor` entry, a `case` in `executeListener`, the
`HandleEvent` union and `case` in `listeners.ts`, and a `packages/apps/src/converters/` entry plus
its host converter if the payload needs shape mapping.

Nothing in the recipe hands the handler an accessor. `app.call(method, context)` passes the context
alone; the `IRead` / `IHttp` / `IPersistence` / `IModify` parameters on `IMediaCallHandler`'s methods
are supplied by the app runtime. A media-call event that needed a builder or an extender — as the
message Modify and Extend events get one — would be new work, not a step here.

## Follow-ups — the remaining phases

> **Nothing below this heading is decided.** This section is a survey, not a plan: the phases, the
> interface names, the proposed accessor surfaces and the "worked recipes" are sketches recorded so
> the next person starts from the reconnaissance rather than repeating it. Treat every shape here as
> a suggestion open to redesign, and every insertion point as a *candidate* that still has to be
> re-checked against the code when the work is actually picked up. No phase is scheduled and none is
> a commitment of this ADR.
>
> Two things here are firmer than the rest, and are flagged where they appear: the constraint that
> nothing may write `IMediaCall` fields around the guarded model layer, and
> [Adjacent surfaces](#adjacent-surfaces--already-generic-usable-today), which documents capabilities
> that already exist today rather than proposing new ones.

### Phase 2 — Act

`IMediaCallModify` action methods plus the remaining post events (created, ringing, accepted,
transferred, DTMF). This needs the EE hook bus scaffolding generalized beyond the single pre-create
hook.

Remaining post-event insertion points:

| Event | Insertion point | Payload available |
|---|---|---|
| `IPostMediaCallCreated` | `runOnCallCreatedForAgent` / `agent.onCallCreated` (`CallDirector.ts:376-395`); SIP `IncomingSipCall.ts:138`, `OutgoingSipCall.ts:84` | Full `IMediaCall`, role, contacts |
| `IPostMediaCallRinging` | after `MediaCalls.startRingingById` (`CallSignalProcessor.ts:283-286`) | callId, callee reachability |
| `IPostMediaCallTransferred` | `CallDirector.transferCall` success (`:288-295`) | transferredBy/To, parentCallId |
| `IPostMediaCallNegotiated` | `saveWebrtcSession` success (`CallDirector.ts:179-185`) | SDP state, media state, hold — **exposes SDP, see the SDP note below** |
| `IPostMediaCallDTMF` | `BroadcastAgent.onDTMF` (`ee/packages/media-calls/src/server/BroadcastAgent.ts:42-44`) | tone, duration |

**`IMediaCallModify`, in rough order of safety:**

- **Action methods (recommended):** `hangup(callId, reason)`, `transfer(callId, to)`,
  `sendDTMF(callId, tone)` — wrappers over `MediaCallDirector.hangup` / `transferCall`. They mirror
  real user actions and reuse every existing guard instead of mutating the record. Expose via bridge
  `doHangup` / `doTransfer`, gated by `mediaCall.write`.
- **`IModifyCreator.startMediaCall()`:** let an app *place* a call, committing via the existing
  `ModifyCreator.finish()` switch on `RocketChatAssociationModel` (`ModifyCreator.ts:122`). Requires
  a `MEDIA_CALL` association member and routes to `callServer.requestCall`.
- **`IModifyExtender.extendMediaCall(id)`:** additive metadata only, analogous to
  `extendVideoConference`.

**Never expose raw `IMediaCall` field writes** — the persisted state machine is guarded at the model
layer for race safety (`MediaCalls.ts:80-185`), and bypassing it would corrupt live calls.

### Phase 2b — `IMediaCallRead`

Precedent is `IVideoConferenceRead` (a single `getById`); a richer surface is warranted given the
query helpers already on the model (`MediaCalls.ts:41-70,187-227`). Proposed surface:
`getById(callId)`, `getActiveCallsByUser(uid)` (backing `MediaCalls.findAllNotOverByUid`
`:199-210`), `getCallHistory(uid, opts)`, `getNegotiations(callId)`.

The worked recipe, from the VideoConference precedent:

- **Definitions:** create `packages/apps-engine/src/definition/accessors/IMediaCallRead.ts` (mirror
  `IVideoConferenceRead.ts:7-15`); export it from `accessors/index.ts`; add
  `getMediaCallReader(): IMediaCallRead` to `IRead.ts` (mirror `:49`).
- **Engine:** create `packages/apps/base-runtime/src/lib/accessors/read/MediaCallRead.ts` (mirror
  `read/VideoConferenceRead.ts:7-13`); create abstract
  `packages/apps/src/server/bridges/MediaCallBridge.ts` with a permission-gated `doGetById` (mirror
  `VideoConferenceBridge.ts:10-95`); export from `bridges/index.ts`; add
  `abstract getMediaCallBridge()` to `AppBridges.ts:100` and to the `Bridge` union (`:30-55`); pass a
  `MediaCallRead` into the `Reader` constructed in `accessors/mod.ts:289-305`; add the getter to
  `read/Reader.ts` (`:79-81`).
- **Host:** create `apps/meteor/app/apps/server/bridges/mediaCalls.ts` (mirror
  `videoConferences.ts:10-76`) and `apps/meteor/app/apps/server/converters/mediaCalls.ts` (mirror
  `converters/videoConferences.ts:8-32`); register the bridge in `bridges/bridges.js` and the
  converter in `orchestrator.ts:106`.
- **Cross-cutting:** add `mediaCall: { read, write }` to `AppPermissions.ts:106-110`, plus
  `defaultPermissions` (`:162-164`) if legacy apps should inherit it.

Call chain: `IRead.getMediaCallReader()` → `MediaCallRead.getById` → `MediaCallBridge.doGetById`
(permission check) → `AppMediaCallBridge.getById` → converter → `MediaCalls` model.

### Phase 3 — Intervene

The remaining pre-hooks, wired into `MediaCallDirector` / `MediaCallServer` and reusing the
`CallRejectedError` rejection contract.

| Event | Insertion point | What an app could do | Notes |
|---|---|---|---|
| `IPreMediaCallRequested` | `MediaCallServer.requestCall` / `parseCallContacts` (`MediaCallServer.ts:92-123`, impl `:186-262`) | Block a call, reroute (change callee), annotate before the call exists | Permission checks already run here (`:201,225,229,233,243`). This is also the high-leverage place to let apps participate in the injected `permissionCheck` / `isFeatureAvailableForUser` policy callbacks (`IMediaCallServer.ts:79-80`), rather than adding a full accessor. |
| `IPreMediaCallAccepted` | `MediaCallDirector.acceptCall` before `MediaCalls.acceptCallById` (`CallDirector.ts:76`), or `clientHasAccepted` (`CallSignalProcessor.ts:316-322`) | Enforce policy on who may accept | |
| `IPreMediaCallTransferred` | `MediaCallDirector.transferCall` before `MediaCalls.transferCallById` (`CallDirector.ts:288`) | Veto or redirect the transfer target | |
| `IPreMediaCallHangup` | `MediaCallDirector.hangup` before `MediaCalls.hangupCallById` (`CallDirector.ts:409`) | Rare | A veto must tolerate server, error and expiry-driven reasons (`:308-332`, `hangupByServer` `:45-47`). |
| `IPreMediaCallDTMF` | `processDTMF` (`CallSignalProcessor.ts:274-278`) | Intercept DTMF for IVR-style apps | |

### Phase 4 — Provide (optional, large)

Pattern B: let an app *back* media calls — an alternate SIP/telephony provider, or supplied
routing/URLs. Today the SIP-vs-internal fork is hard-coded in `MediaCallServer.createCall`
(`:125-134`) on `callee.type`. An `IMediaCallProvider` (mirroring `IVideoConfProvider.ts:11-70`)
with `onCallRequested` / `onCallEnded` / `generateRoute` would require a provider definition, an
`IMediaCallProvidersExtend` accessor, an `AppMediaCallProviderManager`, a bridge, a host registry,
and host call sites in `parseCallContacts` (`:186-262`). This is a significant refactor of the
routing layer and should be a separate initiative.

### Persistence and associations

Apps already get private storage via `IPersistence` / `IPersistenceRead`. To let them key records to
a call, add `MEDIA_CALL` to `RocketChatAssociationModel`
(`packages/apps-engine/src/definition/metadata/RocketChatAssociations.ts:1-10`). An app handling the
ended event could then persist per-call analytics with
`createWithAssociation(data, new RocketChatAssociationRecord(RocketChatAssociationModel.MEDIA_CALL, callId))`.
Low cost, high value for CDR, analytics and compliance apps; no engine routing changes.

### Adjacent surfaces — already generic, usable today

These need **no** media-call-specific work, and are listed so extension design does not duplicate
them: `INotifier` for ephemeral UI, `ISlashCommandsExtend` (a `/call <user>` command),
UIKit/contextual bar/action buttons (a call-ended handler could open a survey),
`ISchedulerExtend`/`ISchedulerModify` for reminders and callbacks, and the message hooks — call
outcomes are written as system messages via `saveCallToHistory` / `sendHistoryMessage`
(`service.ts:167-315`), which flow through `sendMessage` and therefore through the existing
`IPreMessageSent*` / `IPostMessageSent` hooks **today**.

## Cross-cutting concerns for implementers

- **SDP and sensitive data.** Signal payloads and negotiations carry SDP; the engine already strips
  it for logs (`ee/packages/media-calls/src/server/stripSensitiveData.ts:3-24`, applied
  `MediaCallServer.ts:66`). Any hook or accessor exposing signals or negotiations to apps must apply
  the same stripping and sit behind a distinct permission.
- **SIP and internal calls are uniform at the director.** Both providers funnel every state change
  through the *same* `MediaCallDirector` methods, so hooks placed there fire uniformly regardless of
  provider (the fork is only at `MediaCallServer.createCall:125-134`). Place post-hooks in the
  director, not in the agents, to avoid provider-specific gaps.
- **Non-user-driven transitions.** Expiry (`CallDirector.ts:308-332`), errors and `hangupByServer`
  (`:45-47`) end calls with no user actor. Hook payloads must tolerate `ServerActor`
  (`IMediaCall.ts:17-20`) and a non-user `endedBy`.
- **No multi-party participant model.** Calls are strictly `kind:'direct'` two-actor
  (`IMediaCall.ts:37,44-45`). "Join/leave" maps to reachable/ringing → accept → active → hangup;
  the client-side participant abstractions in `media-signaling` are not persisted. Multi-party would
  be a much larger schema change.
- **Multi-instance and performance.** Events fan out across instances via the microservice bus and
  the `BroadcastActorAgent` mechanism. Post-hooks stay fire-and-forget, as the existing listener
  contract is, to avoid adding latency to real-time call signaling.
- **EE gating.** Media calls are enterprise plus module `teams-voip`
  (`apps/meteor/ee/server/settings/voip.ts:7-8`). Host trigger sites must be safe when the feature
  or module is disabled.
- **Build coupling.** The host imports the engine from `@rocket.chat/apps/dist` — rebuild
  `packages/apps` after engine edits.

## Implementation record

- App-facing definitions: `packages/apps-engine/src/definition/mediaCalls/` — `IMediaCall`
  (including `MediaCallOrigin`), `IMediaCallHandler`, `IMediaCallEvent`, the four context types,
  `MediaCallCreateEventResult`, `MediaCallHangupReason` and the `isMissedCall` / `isRejectedCall` /
  `isAnsweredCall` helpers.
- Enums: `packages/apps-engine/src/definition/metadata/{AppInterface,AppMethod}.ts`.
- Dispatch: `packages/apps/src/server/managers/AppListenerManager.ts`, covered by
  `packages/apps/tests/server/managers/AppListenerManager.mediaCalls.test.ts`. The post events are
  the one executor in that manager that does *not* await each app in turn: nothing reads their
  result, so `executePostMediaCallEvent` starts every handler and then awaits the set. Awaiting
  inside the loop would let one app that stalls until its runtime timeout delay the notification of
  every app behind it. The pre event stays serial, because `prevent` has to short-circuit and
  `patch` has to chain.
- Host bridge: `apps/meteor/app/apps/server/bridges/listeners.ts`.
- Host trigger, mappers and `getCallOrigin`: `apps/meteor/server/services/media-call/appEvents.ts`,
  wired in `service.ts`; covered by
  `apps/meteor/tests/unit/server/services/media-call/appEvents.spec.ts` — `origin` for each of the
  three contact-type combinations, on the pre context and on `toAppMediaCall`.
- EE hook bus: `IMediaCallServer.setHooks` / `runPreCallCreatedHook`, consulted in
  `MediaCallDirector.createCall` (`ee/packages/media-calls/src/`).
- Rejection feedback path: `packages/media-signaling/src/definition/call/common.ts`,
  `.../signals/server/rejected-call-request.ts`,
  `packages/ui-voip/src/providers/useCallRejectionToast.ts`.
- E2E: `apps/meteor/tests/e2e/apps/media-call-events.spec.ts`, against the `media-call-events-test`
  fixture app (`apps/meteor/tests/data/apps/app-packages/`). It covers WebRTC calls reaching the app
  with `origin === 'internal'`. The SIP paths need a PBX in CI, which the suite does not have — a
  deliberate gap, recorded rather than hidden.
- `packages/apps-engine/definition/` is build output and gitignored; only `src/definition/` is
  edited.

## Reference index

### Media call feature

- Persisted model: `packages/core-typings/src/mediaCalls/IMediaCall.ts`, `IMediaCallNegotiation.ts`
- Model methods (the guarded state machine): `packages/models/src/models/MediaCalls.ts`,
  `MediaCallNegotiations.ts`; typings `packages/model-typings/src/models/IMediaCallsModel.ts`
- EE engine: `ee/packages/media-calls/src/server/{MediaCallServer,CallDirector,CastDirector,BroadcastAgent,configuration,injection,stripSensitiveData}.ts`;
  `internal/{InternalCallProvider,SignalProcessor}.ts`;
  `internal/agents/{UserActorAgent,CallSignalProcessor}.ts`; `sip/providers/*`; `server/signals/*`
- EE engine definitions: `ee/packages/media-calls/src/definition/{IMediaCallServer,IMediaCallAgent,IMediaCallCastDirector,common}.ts`
- Signaling protocol and client model: `packages/media-signaling/src/definition/{call/*,signals/*,client.ts}`;
  client runtime `packages/media-signaling/src/lib/{Session,Call,TransportWrapper}.ts`
- **Integration seam:** `apps/meteor/server/services/media-call/service.ts` (emitter wiring `:42-54`)
- Core-service contract: `packages/core-services/src/types/IMediaCallService.ts`; proxy
  `packages/core-services/src/index.ts:194`; event `packages/core-services/src/events/Events.ts:307`
- Transport: `apps/meteor/server/modules/notifications/notifications.module.ts:294-301`;
  `apps/meteor/server/modules/listeners/listeners.module.ts:148-150`; client
  `packages/ui-voip/src/providers/useMediaSessionInstance.ts:287-308`
- REST: `apps/meteor/server/api/v1/media-calls.ts`
- Settings and gating: `apps/meteor/ee/server/settings/voip.ts`; permissions in `service.ts:470-478`
- UI: `packages/ui-voip/src/**`

### apps-engine

- Event enums: `packages/apps-engine/src/definition/metadata/{AppInterface,AppMethod}.ts`
- Handler interface templates: `packages/apps-engine/src/definition/messages/{IPostMessageSent,IPreMessageSentPrevent,IPreMessageSentExtend,IPreMessageSentModify}.ts`
- Listener manager: `packages/apps/src/server/managers/AppListenerManager.ts`
- Accessor interfaces: `packages/apps-engine/src/definition/accessors/{IRead,IModify,IVideoConferenceRead,IModifyCreator,IModifyUpdater,IModifyExtender,IModifyDeleter,IPersistence,IPersistenceRead,INotifier}.ts`
- Accessor impls: `packages/apps/base-runtime/src/lib/accessors/read/{Reader,VideoConferenceRead,RoomRead}.ts`,
  `.../accessors/modify/{ModifyCreator,ModifyUpdater}.ts`, `.../accessors/{Persistence,notifier}.ts`;
  assembly `packages/apps/base-runtime/src/lib/accessors/mod.ts`
- Bridges (abstract): `packages/apps/src/server/bridges/{AppBridges,BaseBridge,VideoConferenceBridge,RoomBridge,MessageBridge,ListenerBridge}.ts`
- Provider pattern (precedent): `packages/apps-engine/src/definition/videoConfProviders/IVideoConfProvider.ts`;
  `packages/apps/src/server/managers/AppVideoConfProviderManager.ts`;
  `packages/apps-engine/src/definition/accessors/IVideoConfProvidersExtend.ts`, implemented inline in
  `packages/apps/base-runtime/src/lib/accessors/mod.ts`
- Associations and permissions: `packages/apps-engine/src/definition/metadata/{RocketChatAssociations,AppPermissions}.ts`
- Host bridges, converters, orchestrator: `apps/meteor/app/apps/server/bridges/{bridges.js,listeners.ts,videoConferences.ts,messages.ts,rooms.ts}`;
  `apps/meteor/app/apps/server/converters/*`; `apps/meteor/ee/server/apps/orchestrator.ts`
- Trigger idiom reference: `apps/meteor/server/lib/messages/sendMessage.ts:241,247-257,287-291`
