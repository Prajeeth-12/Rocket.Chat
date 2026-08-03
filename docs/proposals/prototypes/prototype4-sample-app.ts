/**
 * PROTOTYPE 4 — sample app (single aggregate interface, one method per event)
 *
 * The app implements ONE interface (`IMediaCallHandler`) that carries every
 * lifecycle event as its OWN optional method — the `IUIKitActionHandler` shape.
 * No registration call and no `switch` on an `eventType`: each event is its own
 * named, fully-typed method, and its presence is the subscription. An app that
 * only cares about call-ended implements only `executePostMediaCallEnded`.
 */
import { App } from '@rocket.chat/apps-engine/definition/App';
import type { IAppAccessors, IConfigurationExtend, IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import type { ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { EventResult } from '@rocket.chat/apps-engine/definition/eventResult';
import type {
	IMediaCallEndedContext,
	IMediaCallHandler,
	IMediaCallParticipantJoinedContext,
	IMediaCallStartedContext,
	IPreMediaCallCreatedContext,
	MediaCallCreateEventResult,
} from '@rocket.chat/apps-engine/definition/mediaCalls';
import type { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';

export class CallRoutingApp extends App implements IMediaCallHandler {
	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	protected async extendConfiguration(_configuration: IConfigurationExtend): Promise<void> {}

	// --- pre-event (vetoable / patchable) — its own restricted return type ---
	public async executePreMediaCallCreated(context: IPreMediaCallCreatedContext, read: IRead, _http: IHttp, _persistence: IPersistence): Promise<MediaCallCreateEventResult> {
		// Block calls to users on a Do-Not-Disturb list.
		const dndList = (await read.getEnvironmentReader().getSettings().getValueById('dnd_user_ids')) as string;
		if (context.callee.type === 'user' && dndList?.split(',').includes(context.callee.id)) {
			return EventResult.prevent({ i18n: { key: 'callee_is_dnd', args: { user: context.callee.username ?? context.callee.id } } });
		}

		// Force-enable recording capability on every routed call.
		if (!context.features.includes('recording')) {
			return EventResult.patch({ features: [...context.features, 'recording'] });
		}

		return EventResult.pass();
	}

	// --- post-events (fire-and-forget) — implement only the ones you need ----
	public async executePostMediaCallStarted(context: IMediaCallStartedContext, _read: IRead, _http: IHttp, _persistence: IPersistence, _modify: IModify): Promise<void> {
		this.getLogger().info(`Call ${context.call.id} active — updating live agent dashboard`);
	}

	public async executePostMediaCallParticipantJoined(context: IMediaCallParticipantJoinedContext, _read: IRead, _http: IHttp, _persistence: IPersistence, _modify: IModify): Promise<void> {
		this.getLogger().info(`Participant ${context.participant.id} joined call ${context.call.id}`);
	}

	public async executePostMediaCallEnded(context: IMediaCallEndedContext, _read: IRead, _http: IHttp, persis: IPersistence, _modify: IModify): Promise<void> {
		// Persist a stateful communication log entry per call.
		await persis.createWithAssociation(
			{ callId: context.call.id, endedBy: context.endedBy?.id, reason: context.hangupReason, durationMs: context.durationMs },
			{ associations: [] } as never,
		);
	}

	// `executePostMediaCallStarted` above and the omitted `check…` pre-filters
	// are all optional — omitting a method simply means "not subscribed".
}
