# Proposal: Call origin on media-call app events, and labelling the SIP loop-back leg

## TL;DR

- **Problem 1 — apps can't tell where a call comes from.** Nothing in
  `IPreMediaCallCreatedContext` or the app-facing `IMediaCall` says whether a call
  is a pure WebRTC call between two workspace users, a call going out through the
  PBX, or a call arriving from it. `service` is always `'webrtc'`
  (`ee/packages/media-calls/src/server/CallDirector.ts:196-201`), so the only
  signal today is inspecting `caller.type`/`callee.type` and knowing the routing
  rules — which is host knowledge apps should not have to reimplement.
- **Problem 2 — one call, two events.** With SIP integration enabled *for internal
  calls*, a single user-to-user call is created twice: once for the leg
  Rocket.Chat sends to the PBX, and once for the INVITE the PBX routes straight
  back in. The two runs of `executePreMediaCallCreated` are not byte-identical —
  `caller.type`, `callee.type` and `createdBy.type` swap between `user` and `sip` —
  but every value an app would key on matches (both usernames, `createdBy`'s
  username, the feature list), and the pre context carries no call id to compare.
  So an app can tell that *a* SIP leg is involved; it cannot tell that the two legs
  are one conversation, and has no reason to expect two.
- **Already in place, and not a substitute — `divertedBy`.** #40560 added SIP
  diversion (RFC 5806): the PBX names the line that forwarded the call, the host
  persists the diverting party on the call, and this branch passes it through to apps
  on both app-facing shapes. It answers why a call reached *this* callee, not where
  the call came from, and it is absent on loop-back legs — so it narrows neither
  problem above. See [Diversion](#diversion-a-neighbouring-signal-not-a-substitute).
- **Proposal A — `origin`** on the pre-create context and on the app-facing
  `IMediaCall`, derived from the contact types at dispatch time. No new persisted
  field, no migration, correct for calls already in the database.
- **Proposal B — link the loop-back leg to the call it duplicates.** When the
  INVITE arrives, correlate it against the still-live outbound leg, persist the
  verdict on the inbound call as `loopbackOf`, and surface it on that leg's events.
  Both legs keep firing their events; an app that wants one conversation drops the
  leg that has `loopbackOf` set, and one that wants both can now join them.
- **Effort:** small for A, small-medium for B (one model finder, one persisted
  field, one hook param, one mapping). No changes to the Apps-Engine dispatch
  layer.
- **Main risk:** the correlation has a narrow false-positive window (an external
  caller presenting a workspace extension as caller-ID during the exact dial
  window), which would label a genuinely external call as a loop-back of an
  unrelated outbound one. An optional INVITE header narrows it, but must never be
  the sole trigger — see
  [Trust](#trust-the-header-is-a-confirmation-not-a-trigger).

### What changes in the shapes

Two new fields on the app-facing shapes, and one new persisted field behind them:

```diff
  // packages/apps-engine/src/definition/mediaCalls/IMediaCall.ts
+ /** How this call reaches the outside world, and which side opened it. */
+ export type MediaCallOrigin = 'webrtc' | 'sip-outbound' | 'sip-inbound';

  export interface IMediaCall {
  	id: string;
  	service: 'webrtc';
  	kind: 'direct';
  	state: MediaCallState;
+ 	origin: MediaCallOrigin;
  	// …unchanged, `divertedBy` included
+ 	/**
+ 	 * Set when this call is the PBX routing one of our own outbound legs back in:
+ 	 * the id of that outbound call. Both legs are the same conversation.
+ 	 */
+ 	loopbackOf?: string;
  }
```

```diff
  // packages/apps-engine/src/definition/mediaCalls/IPreMediaCallCreatedContext.ts
  export interface IPreMediaCallCreatedContext {
  	caller: IMediaCallContact;
  	callee: IMediaCallContact;
  	createdBy: IMediaCallContact;
  	features: MediaCallFeature[];
  	parentCallId?: string;
  	divertedBy?: IMediaCallContact;
+ 	/** Derived from the contact types; not patchable. */
+ 	origin: MediaCallOrigin;
+ 	/** The outbound call this leg loops back, when the host could correlate one. */
+ 	loopbackOf?: string;
  }

  // unchanged — neither new field is patchable
  export type MediaCallCreatePatch = Pick<IPreMediaCallCreatedContext, 'features'>;
```

The context still has no id of its *own* (nothing is persisted yet); it references
another call, exactly as `parentCallId` already does for transfers. Behind that,
one persisted field carries the verdict to the post events:

```diff
  // packages/core-typings/src/mediaCalls/IMediaCall.ts
  export interface IMediaCall {
  	// …unchanged
+ 	/** Set when this call is the PBX routing our own outbound leg back in. */
+ 	loopbackOf?: IMediaCall['_id'];
  }
```

### What an app receives

A plain WebRTC call between two workspace users — one event, now labelled:

```jsonc
// executePreMediaCallCreated
{
  "caller":    { "type": "user", "id": "aaa", "username": "user1" },
  "callee":    { "type": "user", "id": "bbb", "username": "user2" },
  "createdBy": { "type": "user", "id": "aaa", "username": "user1" },
  "features":  ["audio", "video"],
  "origin":    "webrtc"                      // ← new
}
```

The same user-to-user call with SIP integration enabled *for internal calls* fires
`executePreMediaCallCreated` **twice** today. The two runs are not identical — the
three contact `type`s swap — but nothing in them says the runs belong together:

```jsonc
// run #1 — the leg Rocket.Chat sends to the PBX
{ "caller": { "type": "user", "id": "aaa", "username": "user1" },
  "callee": { "type": "sip",  "id": "1002", "username": "user2", "sipExtension": "1002" },
  "createdBy": { "type": "user", "id": "aaa", "username": "user1" },
  "features": ["audio"] }

// run #2 — the INVITE the PBX routes straight back in (same conversation!)
{ "caller": { "type": "sip",  "id": "1001", "username": "user1", "sipExtension": "1001" },
  "callee": { "type": "user", "id": "bbb", "username": "user2" },
  "createdBy": { "type": "sip",  "id": "1001", "username": "user1", "sipExtension": "1001" },
  "features": ["audio"] }
```

Both usernames, `createdBy`'s username and the feature list are the same on both
runs, so an app keying on those sees one call reported twice with the `user`/`sip`
labels mirrored — which, on its own, is also what a *genuine* pair of unrelated
outbound and inbound calls between the same two people would look like.

After both proposals, both runs still fire, each labelled, and run #2 names the
call it duplicates:

```jsonc
// run #1
{ "caller": { "type": "user", "id": "aaa", "username": "user1" },
  "callee": { "type": "sip",  "id": "1002", "username": "user2", "sipExtension": "1002" },
  "createdBy": { "type": "user", "id": "aaa", "username": "user1" },
  "features": ["audio"],
  "origin": "sip-outbound" }                 // ← new

// run #2
{ "caller": { "type": "sip",  "id": "1001", "username": "user1", "sipExtension": "1001" },
  "callee": { "type": "user", "id": "bbb", "username": "user2" },
  "createdBy": { "type": "sip",  "id": "1001", "username": "user1", "sipExtension": "1001" },
  "features": ["audio"],
  "origin": "sip-inbound",                   // ← new
  "loopbackOf": "6QZ…outboundCallId" }       // ← new: this is run #1's call
```

A genuinely inbound call from outside the workspace is labelled the same way, but
with no `loopbackOf` — nothing correlates with it:

```jsonc
{ "caller": { "type": "sip",  "id": "+5511999999999", "sipExtension": "+5511999999999" },
  "callee": { "type": "user", "id": "bbb", "username": "user2" },
  "createdBy": { "type": "sip", "id": "+5511999999999", "sipExtension": "+5511999999999" },
  "features": ["audio"],
  "origin": "sip-inbound" }                  // ← new
```

So `loopbackOf` present *is* the "these two are one conversation" signal, and its
absence on an inbound call means the host found no outbound leg to attribute it to.
The post events (`postMediaCallStarted`, `…ParticipantJoined`, `…Ended`) carry both
fields inside `context.call` on the same rules.

### Diversion: a neighbouring signal, not a substitute

`divertedBy` landed after this proposal was written (#40560, the RFC 5806
`Diversion` header) and now reaches apps on both shapes:

- `IncomingSipCall.getDiversionContactFromInvite` parses the header and resolves the
  extension to a contact (`.../sip/providers/IncomingSipCall.ts:469-497`).
- `CallDirector.createCall` hands it to the pre-create hook and persists it on the
  call (`.../server/CallDirector.ts:218,254`).
- `toAppMediaCall` maps it into `context.call` for the post events
  (`appEvents.ts:64`).

It answers a different question from `origin`. `origin` says how a call reaches the
outside world; `divertedBy` says why it arrived at *this* callee instead of the one
that was dialled. The two compose rather than compete: a diverted call is always
`sip-inbound`, and `divertedBy` cannot appear on a `webrtc` or `sip-outbound` call,
because only an inbound INVITE carries the header. So `origin` needs no diverted
variant — see [open question 1](#open-questions).

It does not narrow Problem 2 either. A loop-back leg carries no `Diversion` header —
the PBX routes our own leg back, it does not forward a line — so `divertedBy` is
absent on exactly the calls the correlation has to recognise.

One asymmetry to keep in mind when reading a diverted call.
`getNewCallTransferredBy` returns `divertedBy` ahead of the transfer check
(`.../server/signals/getNewCallTransferredBy.ts:5-9`), so clients label a diverted
call as *transferred by* the diverting party. Apps get the same fact under its own
name, and with no `parentCallId`, because no earlier call was replaced. An app that
reconciles its own view with what the user is shown must read `divertedBy` as the
client's `transferredBy`.

## Status

Draft — pending review.

Depends on the media-call app events being in place
(`packages/apps-engine/src/definition/mediaCalls/`, triggered from
`apps/meteor/server/services/media-call/appEvents.ts`); see §3 Phase 1 of
[apps-media-call-analysis.md](./apps-media-call-analysis.md).

## Context: how one call becomes two

`executePreMediaCallCreated` has exactly one trigger point —
`MediaCallDirector.createCall` (`ee/packages/media-calls/src/server/CallDirector.ts:217`,
via `runPreCallCreatedHook` → `runPreMediaCallCreatedAppHook`). So a double
execution means `createCall` ran twice. With
`VoIP_TeamCollab_SIP_Integration_Enabled` **and**
`VoIP_TeamCollab_SIP_Integration_For_Internal_Calls` on
(`apps/meteor/server/services/media-call/service.ts:431-439` →
`routeExternally: 'always'`), it does:

1. `user1` presses call → `request-call` →
   `apps/meteor/server/modules/notifications/notifications.module.ts:295` →
   `GlobalSignalProcessor.processRequestCallSignal`
   (`ee/packages/media-calls/src/internal/SignalProcessor.ts:194`) →
   `MediaCallServer.requestCall` (`ee/packages/media-calls/src/server/MediaCallServer.ts:91`).
2. `parseCallContacts` routes the callee through `getCalleeContactOptions`
   (`.../MediaCallServer.ts:283-306`). With internal calls routed externally the
   option is `{ requiredType: 'sip' }`, so `user2` resolves to the **sip contact
   for their extension** (`.../server/CastDirector.ts:160-167`).
3. `MediaCallServer.createCall:124` sees `callee.type === 'sip'` →
   `OutgoingSipCall.createCall` (`.../sip/providers/OutgoingSipCall.ts:46-77`) →
   `mediaCallDirector.createCall` → **event run #1**.
4. `OutgoingSipCall.createDialog:136` INVITEs `sip:<user2 ext>@<SIP_Server_Host>`
   (`.../sip/Session.ts:102`).
5. The PBX dialplan resolves that extension back to Rocket.Chat, so drachtio hands
   the same workspace an inbound INVITE: `srf.invite` (`.../sip/Session.ts:140`) →
   `processInvite:166` → `IncomingSipCall.processInvite`
   (`.../sip/providers/IncomingSipCall.ts:47`), where `getCalleeFromInvite:431`
   maps the called number to `user2` and `getCallerContactFromInvite:461` rebuilds
   `user1`'s identity → `mediaCallDirector.createCall:96` → **event run #2**.

Two `IMediaCall` documents result, each holding one real participant: the outbound
leg has `uids: [user1]` (a sip callee contributes no uid,
`CallDirector.ts:244-248`), the inbound leg `uids: [user2]`.

### Why the duplicate is unrecognisable to apps

`IPreMediaCallCreatedContext` deliberately carries no call id (nothing is
persisted yet), so the only material an app has is the contacts and the features:

| context field | outbound leg | inbound leg | same? |
| --- | --- | --- | --- |
| `caller.username` | `user1` | `user1` (from `X-RocketChat-Caller-Username`, or resolved from the extension) | yes |
| `callee.username` | `user2` (sip contact built from the user record) | `user2` | yes |
| `createdBy.username` | `user1` (the requester) | `user1` (`createdBy = requestedBy \|\| caller`, `CallDirector.ts:214`) | yes |
| `features` | client list filtered to `SIP_CALL_FEATURES` (`OutgoingSipCall.ts:70`) | `SIP_CALL_FEATURES` verbatim (`IncomingSipCall.ts:102`) | yes, unless the client asked for fewer |
| contact key set | `type,id,username,displayName,sipExtension` | same | yes |
| `caller.type` / `callee.type` | `user` / `sip` | `sip` / `user` | **no** — mirrored |
| `createdBy.type` / `.id` | `user` / uid of `user1` | `sip` / `user1`'s extension | **no** — `createdBy` *is* the caller contact on the inbound leg, since `IncomingSipCall` passes no `requestedBy` (`IncomingSipCall.ts:97-102`) |
| `caller.id` / `callee.id` | uid / extension | extension / uid | **no** — mirrored |

The two contexts are therefore distinguishable, just not *linkable*: every
difference is the `user`/`sip` mirroring, which is precisely what an unrelated pair
of real calls between the same two people would also show. An app logging usernames
and features — including the e2e fixture app
(`apps/meteor/tests/data/apps/app-packages/src/media-call-events-test/MediaCallEventsTestApp.ts:35-42`)
— sees two entries that differ only by log timestamp; an app inspecting `type`s sees
an outbound call and an inbound call, with no way to conclude they are one
conversation. That is the gap Proposal B closes, and it is why the fix has to be a
correlation performed by the host rather than a field an app can derive.

The same doubling occurs with only `..._SIP_Integration_Enabled` on whenever the
PBX happens to route an outbound leg back into the workspace (e.g. a DID mapped to
a workspace extension); user-to-user calls then stay internal
(`routeExternally: 'never'` → `{ preferredType: 'user' }`) and fire once.

## Proposal A — `origin` on every media-call event

### The information already exists at dispatch time

Both contacts are final before either event is built, and their types *are* the
origin:

| `caller.type` | `callee.type` | origin |
| --- | --- | --- |
| `user` | `user` | never leaves the workspace |
| `user` | `sip` | placed out through the PBX |
| `sip` | `user` | arrived from the PBX |

`sip`/`sip` cannot occur: `parseCallContacts` rejects a non-user caller for an
external callee (`MediaCallServer.ts:234-237`) and `getCalleeFromInvite` requires
a user callee (`IncomingSipCall.ts:431`).

### Shape

```ts
/** How this call reaches the outside world, and which side opened it. */
export type MediaCallOrigin = 'webrtc' | 'sip-outbound' | 'sip-inbound';
```

Added to `IPreMediaCallCreatedContext`
(`packages/apps-engine/src/definition/mediaCalls/IPreMediaCallCreatedContext.ts`)
and to the app-facing `IMediaCall`
(`packages/apps-engine/src/definition/mediaCalls/IMediaCall.ts`), so pre and post
events agree. It is **not** patchable: `MediaCallCreatePatch` stays
`Pick<..., 'features'>`, and `AppListenerManager.getMediaCallCreatePatch`
(`packages/apps/src/server/managers/AppListenerManager.ts:1353-1361`) already
drops anything that is not `features`.

`packages/apps-engine/definition/` is build output (gitignored), so only
`src/definition/` is edited.

### Where it is computed

One helper in `apps/meteor/server/services/media-call/appEvents.ts`, used by both
sides:

```ts
function getCallOrigin(caller: MediaCallContact, callee: MediaCallContact): MediaCallOrigin {
	if (caller.type === 'sip') return 'sip-inbound';
	if (callee.type === 'sip') return 'sip-outbound';
	return 'webrtc';
}
```

- pre: `runPreMediaCallCreatedAppHook` already receives both contacts in
  `PreCallCreatedHookParams` (`appEvents.ts:147-158`).
- post: `toAppMediaCall` already has `call.caller`/`call.callee`
  (`appEvents.ts:45-65`).

Consequences worth stating: **nothing changes in `ee/packages/media-calls`** for
Proposal A — no new hook param, no new persisted field — and calls already in the
database report the correct origin, because it is derived from data they already
carry.

### Known gap this leaves

An internal call routed over SIP reports `sip-outbound`, which is true about the
transport but says nothing about the call being between two workspace users. On the
inbound leg, Proposal B's `loopbackOf` answers it. On the **outbound** leg it cannot
be answered at all at pre time: whether the PBX will route the INVITE back into this
workspace is only known once it does. An `internal: boolean` on the pre-create
context would therefore have to lie on exactly the case that motivates it — which is
why the signal is modelled as a link discovered later on the inbound leg, not as a
flag on the outbound one.

## Proposal B — recognise the loop-back leg and name the call it duplicates

### What is known when the INVITE arrives

`IncomingSipCall.processInvite` already resolves everything the correlation needs:

- `getCalleeFromInvite` (`IncomingSipCall.ts:431`) → the workspace user B being
  called (`requiredType: 'user'`, so an internal target is guaranteed).
- `getRocketChatCallerFromInvite` (`:444`) → whether `req.callingNumber` belongs to
  a workspace user A.

### The rule

> This INVITE is a loop-back if `req.callingNumber` belongs to workspace user A and
> a **not-ended** call exists whose caller is `{type: 'user', id: A}` and whose
> callee is the sip contact for `req.calledNumber`.

```ts
const originLeg =
	callerUser &&
	(await MediaCalls.findOneNotEndedByCallerAndSipCallee(callerUser.id, req.calledNumber));
```

Proposed finder on `IMediaCallsModel`
(`packages/model-typings/src/models/IMediaCallsModel.ts`, implemented in
`packages/models/src/models/MediaCalls.ts`):

```ts
findOneNotEndedByCallerAndSipCallee(
	callerUid: IUser['_id'],
	sipExtension: string,
	options?: FindOptions<IMediaCall>,
): Promise<IMediaCall | null>;
```

Leading the query with `{ ended: false, uids: callerUid, expiresAt: { $gt: now } }`
reuses the existing `{ ended: 1, uids: 1, expiresAt: 1 }` index
(`packages/models/src/models/MediaCalls.ts:33`) — the outbound leg carries the
caller's uid — with `'caller.type'`/`'caller.id'`/`'callee.type'`/`'callee.id'` as
the residual filter. No new index.

### Why the ordering is safe

The outbound document is inserted (`CallDirector.ts:259`) and then flipped to
`ringing` (`OutgoingSipCall.ts:125`) *before* `createSipDialog` emits the INVITE
(`:136`). The record is therefore always present and not-ended when the loop-back
arrives — there is no race window.

Transfers routed externally produce the same outbound-then-loop-back pair
(`UserActorAgent.onCallTransferred:146` → `requestCall`), so the match must **not**
be conditioned on `parentCallId` being absent.

### Optional deterministic marker

`OutgoingSipCall.createDialog` already sets custom headers on the outbound INVITE
for transfers (`Referred-By`, `OutgoingSipCall.ts:142-146`); adding
`X-RocketChat-Origin-Call-Id: <call._id>` there gives `processInvite` an exact
correlation key when the PBX passes it through. Header survival depends on the
dialplan copying custom headers across the bridge (FreeSWITCH needs
`sip_copy_custom_headers` / an exported `sip_h_X-…`) — the same assumption the
existing `X-RocketChat-Caller-*` reads already make (`IncomingSipCall.ts:465-466`),
so treat it as an optimisation, not a requirement.

#### Trust: the header is a confirmation, not a trigger

A header alone must never establish the link: an external caller could then present
an arbitrary call id and have their call reported to apps as an internal loop-back —
turning a spoofable header into a claim about who is calling. Use it only to
*select* among correlated candidates, and always require the referenced call to
exist, be not-ended, and match the caller/callee pair — which reduces to the rule
above.

### Propagating the verdict

The pre-event and the post-events need the decision in different places:

- **Pre.** The hook runs inside `createCall` before the insert
  (`CallDirector.ts:217` vs `:259`), and `processInvite` already knows the verdict,
  so an optional `loopbackOf?: string` on `InternalCallParams`
  (`ee/packages/media-calls/src/definition/common.ts:11-19`) is enough: `createCall`
  forwards it into `runPreCallCreatedHook`'s params and writes it onto the document.
- **Post.** `notifyAppsOfMediaCallStarted`/`ParticipantJoined`/`Ended` receive only
  a callId and re-load the call, possibly on another instance
  (`appEvents.ts:106-139`), so the verdict **must be persisted**: a new optional
  `loopbackOf?: IMediaCall['_id']` on `IMediaCall`
  (`packages/core-typings/src/mediaCalls/IMediaCall.ts`), mapped into the app shape
  by `toAppMediaCall` (`appEvents.ts:45-65`) like `parentCallId` already is.

Storing the origin call's id rather than a boolean is what makes the link usable:
an app that already tracked the outbound call by id can attach the inbound leg to
it, which a flag would not allow.

### What apps see afterwards

Both legs are reported, and the inbound one points at the outbound one. What each
leg is worth knowing about:

- **The outbound leg** is the one whose timestamps track the PBX dialog
  (`OutgoingSipCall.createDialog:266`, `sipDialog.on('destroy'):207`), so it spans
  the actual conversation and its duration and hangup reason are meaningful. Its
  `callee` is `user2`'s identity typed as `sip`, with `id` = extension but
  `username`/`displayName` present (the contact is built from the user record,
  `CastDirector.ts:118-142`), and `uids` lists only `user1`.
- **The inbound leg** carries `user2` in `uids` and reports `user2`'s own accept, so
  it is the leg that says the callee actually answered.

An app that wants a single conversation per call ignores every call with
`loopbackOf` set and reads the outbound leg only. An app that wants per-user
visibility reads both and joins them on `loopbackOf`. Neither has to reimplement
the routing rules, which is the point.

Two consequences to accept deliberately: apps still see `callee.type === 'sip'` for
a call between two workspace users, and an app returning `prevent` on the inbound
leg rejects only that leg — the outbound leg is already ringing by then, so the
result is a call the PBX cannot complete rather than a cleanly refused one. An app
that means to block a call must act on the outbound leg, i.e. on the event where
`loopbackOf` is absent.

## Implementation sketch

| # | Change | Where |
| --- | --- | --- |
| 1 | `MediaCallOrigin` + `origin`, and `loopbackOf?`, on the pre-create context and app-facing `IMediaCall` | `packages/apps-engine/src/definition/mediaCalls/{IPreMediaCallCreatedContext,IMediaCall}.ts` |
| 2 | `getCallOrigin` helper, used in the pre context and in `toAppMediaCall`; map `loopbackOf` in both | `apps/meteor/server/services/media-call/appEvents.ts` |
| 3 | `loopbackOf?: string` on `IMediaCall` | `packages/core-typings/src/mediaCalls/IMediaCall.ts` |
| 4 | `findOneNotEndedByCallerAndSipCallee` | `packages/model-typings/src/models/IMediaCallsModel.ts`, `packages/models/src/models/MediaCalls.ts` |
| 5 | `loopbackOf?: string` on `InternalCallParams` and on `PreCallCreatedHookParams`; `createCall` forwards it to the hook and persists it | `ee/packages/media-calls/src/definition/common.ts`, `.../server/CallDirector.ts:217,230-255` |
| 6 | Correlate the INVITE and pass `loopbackOf` into `createCall` | `.../sip/providers/IncomingSipCall.ts:47-112` |
| 7 | *(optional)* set `X-RocketChat-Origin-Call-Id` on the outbound INVITE | `.../sip/providers/OutgoingSipCall.ts:136-147` |
| 8 | Changeset | `.changeset/` |

Impact analysis must run on `MediaCallDirector.createCall` before step 5 — it is
the choke point every call creation path goes through (`CLAUDE.md`).

## Test plan

- **Unit, host events** (`apps/meteor/tests/unit/server/services/media-call/appEvents.spec.ts`):
  `origin` for each of the three contact-type combinations, on the pre context and
  on `toAppMediaCall`; `loopbackOf` reaching the pre context when passed to the hook
  and `context.call` when persisted on the loaded call; `loopbackOf` absent (not
  `undefined`-valued) when the call has none, matching how `parentCallId` is mapped.
  The `divertedBy` cases already in that spec are the template for the last two: they
  cover the mapping on both shapes, the absent case, and that no `contractId` rides
  along.
- **Unit, correlation**: a new spec around the `processInvite` correlation with a
  stubbed model — matches the live outbound leg; ignores an ended one; ignores one
  to a different extension; still matches when the outbound leg has a
  `parentCallId`; does not match on the header alone.
- **Unit, model**: the finder's query shape.
- **E2E**: the existing suite
  (`apps/meteor/tests/e2e/apps/media-call-events.spec.ts`) covers WebRTC calls and
  should assert `origin === 'webrtc'` reaches the app, with no `loopbackOf`.
  Loop-back coverage needs a PBX in CI, which the suite does not have today —
  leaving the SIP paths on unit coverage is a deliberate gap to record, not an
  oversight to hide.

## Open questions

1. `origin` as a flat union, or `{ service, direction }`? Flat reads better; the
   split is easier to extend if a non-SIP provider ever lands (see §"provider
   registration" in [apps-media-call-analysis.md](./apps-media-call-analysis.md)).
   Either way the union stays three-valued: `divertedBy` already carries diversion,
   and it only ever accompanies `sip-inbound`.
2. Should `loopbackOf` also be set on the **outbound** leg once the loop-back is
   recognised, pointing back at the inbound one? It would make the pair navigable
   from either end, but it is a second write to an already-ringing call and arrives
   after that leg's pre event, so an app would see the field appear only on the post
   events.
3. Is `loopbackOf` the right name for an app-facing field, given it describes a PBX
   routing artefact? `duplicateOf` or `sameConversationAs` say more about what an
   app should do with it and less about why it exists.
