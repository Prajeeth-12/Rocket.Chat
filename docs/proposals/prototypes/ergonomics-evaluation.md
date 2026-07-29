# Media-call apps-engine events — four prototypes, ergonomics evaluation

All four prototypes satisfy the same JBTD: emit typed media-call lifecycle events
(`IPreCallCreatedHandler`, `ICallStartedHandler`, `ICallEndedHandler`,
`IParticipantJoinedHandler`) natively from the Apps-Engine, and all return the
unified `EventResult` type from `apps-engine-event-result-return-type.md` for
pre-events. They differ **only in how an app subscribes** and **how the engine
dispatches**.

- **Prototype 1 — Pattern A (per-event handler interfaces).** Mirrors the
  existing message/room listener architecture. An app `implements` one interface
  per event; the engine auto-detects handlers via `Object.keys(AppInterface)` and
  dispatches through `AppListenerManager`.
- **Prototype 2 — `IMediaCallManager` (registered manager object).** A single
  object holding every media-call hook as an optional method, registered once via
  `configurationExtend.registerMediaCallManager(manager)`. Modeled on the
  VideoConfProvider registration pattern, but fans out to *all* registered
  managers.
- **Prototype 3 — `IMediaCallHandler` (single collapsed interface).** One
  interface exposing exactly two methods — `executePreMediaCall` and
  `executePostMediaCall` — with the specific event carried on the context as a
  discriminated `eventType` field. Rides Prototype 1's listener engine (and its
  free composition) but folds all per-event interfaces into two switch-dispatched
  methods.
- **Prototype 4 — `IMediaCallHandler` (single aggregate interface).** One
  interface, but with **one optional method per event** keyed by `AppMethod` —
  the exact shape of `IUIKitActionHandler` (`UIKIT_BLOCK_ACTION` /
  `UIKIT_VIEW_SUBMIT` / … as optional members of one interface). Splits the
  difference between P1 and P3: it collapses N interfaces into *one* like P3, but
  keeps each event as its *own* named, fully-typed method like P1 — so per-event
  return-type narrowing is preserved and there is no internal `eventType`
  `switch`. Rides Prototype 1's listener engine and its free composition.

All four share: the `EventResult` type (`definition/eventResult/`), the app-facing
context types (`definition/mediaCalls/`), and the host trigger seam
(EE `callServer` emitter + injected pre-create hook, wired in `MediaCallService`).

---

## What an app author writes

### Prototype 1

```ts
export class CallRoutingApp extends App
  implements IPreMediaCallCreated, IPostMediaCallStarted, IPostMediaCallEnded {

  async executePreMediaCallCreated(context, read): Promise<MediaCallCreateEventResult> {
    if (isBlocked(context.callee)) return EventResult.prevent({ i18n: { key: 'blocked' } });
    return EventResult.patch({ features: [...context.features, 'recording'] });
  }

  async executePostMediaCallEnded(context, read, http, persis): Promise<void> { /* log */ }
}
```

No registration call — presence of the method **is** the subscription.

### Prototype 2

```ts
export class CallRoutingApp extends App {
  protected async extendConfiguration(configuration: IConfigurationExtend) {
    await configuration.registerMediaCallManager({
      name: 'call-routing',
      preCallCreate: async (context, read) => {
        if (isBlocked(context.callee)) return EventResult.prevent({ i18n: { key: 'blocked' } });
        return EventResult.patch({ features: [...context.features, 'recording'] });
      },
      postCallEnded: async (context, read, http, persis) => { /* log */ },
    });
  }
}
```

One object, one explicit registration; unimplemented hooks are simply absent.

### Prototype 3

```ts
export class CallRoutingApp extends App implements IMediaCallHandler {
  async executePreMediaCall(context, read): Promise<MediaCallPreEventResult> {
    switch (context.eventType) {
      case 'created':
        if (isBlocked(context.callee)) return EventResult.prevent({ i18n: { key: 'blocked' } });
        return EventResult.patch({ features: [...context.features, 'recording'] });
      default:
        return EventResult.pass();
    }
  }

  async executePostMediaCall(context, read, http, persis): Promise<void> {
    switch (context.eventType) {
      case 'callEnded': /* log */ break;
    }
  }
}
```

One interface, two methods; the event rides on `context.eventType` (a
discriminated union that narrows the payload inside each `switch`). No
registration — method presence is the subscription (like Prototype 1). A new
event = one more union member, not a new interface/method.

> **Limitation — return type does not narrow per `eventType`.** Because
> `executePreMediaCall` has a *single* signature returning the whole
> `MediaCallPreEventResult` union, TypeScript cannot tie the allowed
> `EventResult` variants to the `context.eventType` branch the author is in. The
> branded `EventResult.*` factories still enforce the union as a whole at the
> `return`, but a future pre-event with a *different* permitted result set (say,
> one that may `prompt` while `created` may not) could not be expressed without
> per-`eventType` method overloads. Prototypes 1 and 2 get this narrowing for
> free — each event is its own method with its own restricted return type. Today
> `created` is the only pre-event, so the gap is latent, not active.

### Prototype 4

```ts
export class CallRoutingApp extends App implements IMediaCallHandler {
  async executePreMediaCallCreated(context, read): Promise<MediaCallCreateEventResult> {
    if (isBlocked(context.callee)) return EventResult.prevent({ i18n: { key: 'blocked' } });
    return EventResult.patch({ features: [...context.features, 'recording'] });
  }

  async executePostMediaCallEnded(context, read, http, persis): Promise<void> { /* log */ }
}
```

Identical author code to Prototype 1 — **each event is its own named method with
its own restricted return type** — but the methods live on **one** interface
instead of N (`implements IMediaCallHandler`, not `implements IPre…, IPost…, …`).
No registration and no `eventType` `switch`: like P1/P3 the presence of a method
is the subscription. Every method is optional (`?`), so implementing only the
events you want still satisfies the interface. This is the `IUIKitActionHandler`
model applied to media calls, and it recovers the per-event return narrowing that
Prototype 3 trades away.

---

## Comparison

| Dimension | Prototype 1 (Pattern A) | Prototype 2 (`IMediaCallManager`) | Prototype 3 (`IMediaCallHandler`, collapsed) | Prototype 4 (`IMediaCallHandler`, aggregate) |
|---|---|---|---|---|
| **Author mental model** | "Implement the handler interface for each event." Same as every other RC app event today. | "Fill in the hooks I want on one object and register it." Same as `provideVideoConfProvider`. | "Implement one interface, two methods; `switch` on `context.eventType`." Familiar interface model, but events fold into a discriminant rather than method names. | "Implement one interface; fill in the per-event methods I want." The `IUIKitActionHandler` model — one interface, one optional method per event, no `switch`. |
| **Subscription** | Implicit — a method's presence subscribes it. | Explicit — one `registerMediaCallManager` call. | Implicit — presence of `executePre…`/`executePost…` subscribes the whole pre or post group at once. | Implicit — a method's presence subscribes it (per event, since every member is its own optional method). |
| **Discoverability** | `implements IPre…` + editor autocomplete on unimplemented members; the interface list is the menu. | The `IMediaCallManager` object literal shows every hook (all optional) in one place with inline autocomplete. Arguably the best "here's everything you can hook" surface. | Two methods are trivially discoverable; the *event menu* hides one level down in the `context.eventType` union — visible via `switch`/autocomplete on the discriminant, not in the method list. Weakest per-event menu. | Strong — `implements IMediaCallHandler` + autocomplete lists every optional method (all events) on one interface. Flat per-event menu like P1, colocated in one surface like P2's object. |
| **Cohesion** | Handlers scattered as top-level class methods, interleaved with unrelated app methods. | All media-call hooks colocated in one object. | Tightest — the entire surface is two methods; all pre logic in one, all post logic in the other. | The *type* surface is one cohesive interface; the *implementations* are still separate class methods (like P1), interleaved with unrelated app methods. |
| **Per-event method signatures** | Each interface fixes exact params (and an optional `check…`). | Each object method fixes exact params; no `check…` pre-filter. | One shared signature per group (`check…` optional). All pre-events share one param set, all post-events another; an event cannot tailor its own accessor set. | Each method fixes exact params (and an optional `check…`), like P1 — every event tailors its own accessor set. |
| **Return-type narrowing (EventResult)** | Per-interface restricted union (`MediaCallCreateEventResult`) enforced at the `return`. | Same restricted unions, on the object method's return type. Identical DX. | Enforced against the *whole* `MediaCallPreEventResult` union, **not** narrowed per `eventType` (single signature, no overloads). See the limitation note above. | Per-method restricted union enforced at each `return`, like P1 — full per-event narrowing (recovers what P3 trades away). |
| **Selective opt-out** | Don't implement the interface. | Omit the method (no empty stub, no interface to satisfy). Slightly cleaner. | Coarse — opt out of a whole group by omitting the method, or of one event via a `switch` `default`/missing case. No per-event opt-out at the type level. | Cleanest — every member is optional, so omit the method to opt out of exactly that event. Per-event opt-out at the type level, no interface to drop. |
| **Multiple hooks of same event per app** | One class = one handler per event. | One manager per app (keyed by `name`); still one hook per event per app. Parity. | One class, one pre + one post method; still one hook per event per app. Parity. | One class, one method per event; still one hook per event per app. Parity. |
| **Runtime dispatch** | `AppListenerManager` per-event executor + host `ListenerBridge` case. | `AppMediaCallManagerManager` fan-out + per-app `AppMediaCallManager` RPC wrapper. | Listener model like P1, but **two** executors (pre/post) that pass `eventType` in context and switch internally — fewer executors, one extra dispatch hop inside the app. | Identical to P1 — per-event `AppListenerManager` executor + host `ListenerBridge` case, keyed by `AppMethod`. The aggregate interface is only the app-facing shape; the engine still dispatches per method. |
| **Composition across apps** | Native to the listener model: prevent short-circuits, patch chains. Reuses the existing loop shape. | Reimplemented in the manager-manager (fan-out loop with the same precedence). Works, but duplicates listener semantics. | Inherited from the listener model, same as P1 — prevent short-circuits and patch chains for free, not rebuilt. | Inherited from the listener model, same as P1 — prevent short-circuits and patch chains for free, not rebuilt. |
| **Alignment with existing arch** | High — it *is* the existing events architecture, extended. | Medium — it's the provider-registration architecture repurposed for events (providers normally *back* one capability, selected by name; here we fan out, which is listener-shaped). | Medium-high — rides the listener engine (like P1), but collapsing N event interfaces into 2 methods with an internal discriminant is a shape no other RC event surface uses. | High — it *is* the listener engine (like P1), and the single-interface/many-optional-methods shape is already established in RC by `IUIKitActionHandler`. |

---

## Engine / wiring cost (maintainer ergonomics)

### Prototype 1 — touches the events machinery (per event)
- `AppInterface` + `AppMethod` enum members (4 events).
- One handler-interface file + context types per event; barrel export.
- `AppListenerManager`: `IListenerExecutor` entry, `executeListener` case, private executor per event.
- Host `ListenerBridge`: `HandleEvent` union entry, `handleEvent` case, group handler.
- Host trigger site (`triggerEvent`).

This is a **wide but shallow, well-trodden** path — every new event repeats a
known 7-step recipe. Adding a 5th event later is boilerplate, not design.

### Prototype 2 — touches the registration machinery (once), then just adds methods
- New definition: `IMediaCallManager` + accessor `IMediaCallManagersExtend`.
- `IConfigurationExtend.registerMediaCallManager` + `ConfigurationExtend` impl.
- `AppAccessorManager` wiring; `AppMediaCallManagerManager` + `AppMediaCallManager`
  wrapper; `AppManager` instantiate/getter/register/unregister; `AppMethod`
  `_MEDIACALL_*` members.
- Host: dispatch bridge that pulls the manager-manager.

Higher **one-time** setup, but adding a **new event later is cheap**: one optional
method on `IMediaCallManager` + one `_MEDIACALL_*` enum + one `run…` wrapper +
one fan-out method. No new `AppInterface`/executor/`HandleEvent`/bridge-case
churn. It scales better to a *large, growing* event catalog.

### Prototype 3 — touches the events machinery (once, per method-group)
- `AppInterface` + `AppMethod` enum members: **two** (`executePreMediaCall`,
  `executePostMediaCall`), not one-per-event.
- One interface file + the `Pre…`/`Post…MediaCallContext` discriminated unions;
  barrel export.
- `AppListenerManager`: two `IListenerExecutor` entries + two `executeListener`
  cases; each executor builds the `eventType`-tagged context and runs the same
  compose loop.
- Host `ListenerBridge`: two `HandleEvent` union entries + two `handleEvent`
  cases; the host tags each emission with its `eventType`.
- Host trigger site (`triggerEvent`), passing the discriminant.

The one-time cost sits between P1 and P2: like P1 it stays on the listener
engine (composition inherited, not rebuilt), but it pays that wiring **twice**
(pre + post) instead of per-event. Adding a **new event later is cheap** — one
context union member + one `case` in the executor and the host tagger; **no** new
`AppInterface`/`AppMethod`/executor/`HandleEvent`/bridge-case. It scales to a
growing catalog nearly as well as P2, without P2's duplicated composition — at
the cost of the return-narrowing gap noted above.

### Prototype 4 — same events machinery as P1 (per event), one app-facing interface
- `AppInterface` + `AppMethod` enum members (4 events) — **shared with P1**; the
  aggregate interface reuses the exact same `AppMethod` keys, so no new enum
  members beyond P1's.
- **One** interface file (`IMediaCallHandler`) carrying all events as optional
  keyed methods, reusing P1's per-event context types; barrel export. (P1's
  per-event *interface* files collapse into this one; the context types are
  shared.)
- `AppListenerManager`: `IListenerExecutor` entry, `executeListener` case, private
  executor per event — **identical to P1** (dispatch is still per method key).
- Host `ListenerBridge`: `HandleEvent` union entry, `handleEvent` case, group
  handler — **identical to P1**.
- Host trigger site (`triggerEvent`) — **identical to P1**.

The engine/host wiring is **exactly P1's** — same executors, same bridge cases,
same per-event recipe — because the aggregate interface changes only the
*app-facing* grouping (one interface instead of N), not how the engine detects or
dispatches methods. The only maintainer saving over P1 is on the definition side:
one interface file to touch instead of one per event. Adding a 5th event is the
same 7-step recipe as P1, plus one method on the aggregate interface. It gets P1's
per-event narrowing and composition for free while presenting a single cohesive
interface — but unlike P2/P3 it does **not** make the per-event engine wiring any
cheaper.

---

## Notable semantic detail — provider vs. listener

VideoConfProvider selects **one** provider by name and RPCs into it. Media-call
events are **broadcast** (every interested app should observe; multiple may veto).
So Prototype 2 deliberately deviates from its own template: `runPreCall*` composes
`EventResult` across **all** registered managers (prevent-wins, patch-chains),
and `runPost*` fans out to all. That composition logic is exactly what Pattern A
already gives for free — which is the core tension:

- Prototype 1 reuses the listener engine's composition; Prototype 2 re-implements it.
- Prototype 3 also reuses the listener engine's composition (like P1) — the
  `prevent`-wins / `patch`-chain semantics come for free; only the per-app
  dispatch changes (one executor per group that switches on `eventType`).
- Prototype 4 reuses the listener engine's composition identically to P1 — same
  per-event executors and precedence; only the app-facing grouping differs (one
  interface instead of N).
- Prototype 2 gives a nicer author surface (one cohesive object, one registration,
  a single discoverable menu of hooks); Prototype 1 gives a nicer *maintainer*
  fit with everything else that is an event in RC; Prototype 3 gives the most
  cohesive author surface *without* leaving the listener engine, trading away
  per-event return-type narrowing and the flat per-event discoverability the
  other two keep.

---

## Recommendation

- If media-call events are meant to be **"just more app events"** and stay a small,
  stable set → **Prototype 1**. Zero conceptual novelty for authors or maintainers,
  and `EventResult` composition is inherited, not rebuilt.
- If the media-call surface is expected to **grow into a broad, cohesive domain API**
  (many hooks, read/modify accessors, later a provider) and you value the flatter
  `registerMediaCallManager` DX and single-object discoverability → **Prototype 2**,
  accepting the larger one-time scaffold and the duplicated composition logic.
- If you want P2's **single cohesive surface and cheap event-catalog growth** but
  refuse to **re-implement composition** — and can accept that events fold into a
  `context.eventType` discriminant (weaker per-event discoverability) and that the
  pre-event return type won't narrow per event → **Prototype 3**. It stays on the
  listener engine (composition inherited) while collapsing the surface to two
  methods; the standing risk is the return-narrowing gap if pre-events ever
  diverge in their permitted `EventResult` variants.
- If you want P1's per-event ergonomics — flat event menu, per-event return-type
  narrowing, per-event opt-out, composition inherited — but prefer a **single
  cohesive interface** to `implements` instead of one interface per event, and are
  fine that the engine wiring stays exactly P1's (no cheaper event-catalog growth)
  → **Prototype 4**. It's the `IUIKitActionHandler` shape (already established in
  RC), so it adds no conceptual novelty; it buys author-surface cohesion over P1
  without giving up any of P1's type-level guarantees, and without P3's
  return-narrowing gap. The trade vs. P3/P2 is that it does not reduce the
  per-event maintainer wiring — every new event is still P1's full recipe.

A pragmatic hybrid also exists: keep the **author-facing** `IMediaCallManager`
object (Prototype 2's ergonomics) but have its registration **fan into the
listener manager** internally (Prototype 1's engine), so composition isn't
duplicated. Not built here — noted as the natural follow-up if both surfaces test
well.

---

## Files (what was built)

**Shared**
- `packages/apps-engine/src/definition/eventResult/` — `EventResult` type, factories, `isEventResult` guard.
- `packages/apps-engine/src/definition/mediaCalls/` — app-facing `IMediaCall`, context types, `MediaCallCreateEventResult`.
- `apps/meteor/server/services/media-call/mediaCallAppContext.ts` — shared host↔app mappers.
- EE seam: `MediaCallServerEvents.callAccepted` + injected `setAppHooks`/`runPreCallCreatedHook` (`ee/packages/media-calls/src/{definition/IMediaCallServer,server/MediaCallServer,server/CallDirector}.ts`).

**Prototype 1**
- `definition/mediaCalls/IPreMediaCallCreated.ts`, `IPostMediaCallStarted.ts`, `IPostMediaCallParticipantJoined.ts`, `IPostMediaCallEnded.ts`.
- `AppInterface`/`AppMethod` members; `AppListenerManager` executors; `listeners.ts` bridge (`mediaCallEvent`).
- `apps/meteor/server/services/media-call/appsBridge.ts`; wired live in `service.ts`.
- Sample app: `prototype1-sample-app.ts`.

**Prototype 2**
- `definition/mediaCallManagers/IMediaCallManager.ts`; `definition/accessors/IMediaCallManagersExtend.ts`; `IConfigurationExtend.registerMediaCallManager`.
- `ConfigurationExtend`, `MediaCallManagerExtend`, `AppMediaCallManagerManager`, `AppMediaCallManager`; `AppManager`/`AppAccessorManager` wiring; `_MEDIACALL_*` methods.
- `apps/meteor/server/services/media-call/appsManagerBridge.ts`; alternative (commented) wiring in `service.ts`.
- Sample app: `prototype2-sample-app.ts`.

**Prototype 3**
- `definition/mediaCallsUnified/IMediaCallHandler.ts` — single `IMediaCallHandler` interface (`executePreMediaCall` + `executePostMediaCall`); `PreMediaCallContext` / `PostMediaCallContext` discriminated unions keyed by `eventType`; reuses Prototype 1's per-event context + `EventResult` types.
- `definition/mediaCallsUnified/index.ts` — barrel.
- Sample app: `prototype3-sample-app.ts`.

**Prototype 4**
- `definition/mediaCallsAggregate/IMediaCallHandler.ts` — single aggregate `IMediaCallHandler` interface following the `IUIKitActionHandler` pattern: one optional method per event keyed by `AppMethod` (`CHECK_/EXECUTE_PRE_MEDIA_CALL_CREATED`, `…_POST_MEDIA_CALL_STARTED`, `…_POST_MEDIA_CALL_PARTICIPANT_JOINED`, `…_POST_MEDIA_CALL_ENDED`). Reuses Prototype 1's per-event context + `EventResult` types and `AppMethod` keys; no new enum members, no `eventType` discriminant. Engine/host wiring is P1's (unbuilt here — the interface is the app-facing surface over P1's executors).
- `definition/mediaCallsAggregate/index.ts` — barrel.
- Sample app: `prototype4-sample-app.ts`.

**Verification**: `@rocket.chat/apps-engine` typechecks clean (0 errors) and
rebuilds its `definition/` output; `@rocket.chat/apps` emits `dist/` with the new
managers and reports no errors in any touched file (only pre-existing
environment/dependency-resolution errors unrelated to this work). EE + meteor host
edits validated against the exported types; note the standing build-coupling —
`@rocket.chat/apps` must be rebuilt for the meteor host to see engine changes.
