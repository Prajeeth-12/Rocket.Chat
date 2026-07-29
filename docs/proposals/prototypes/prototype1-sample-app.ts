/**
 * PROTOTYPE 1 — sample app (Pattern A: per-event handler interfaces + EventResult)
 *
 * The app class implements one interface per media-call lifecycle event it cares
 * about. The engine auto-detects them via `Object.keys(AppInterface)` — there is
 * no registration call. Pre-events return a restricted `EventResult` union.
 */
import { App } from '@rocket.chat/apps-engine/definition/App';
import type { IAppAccessors, IConfigurationExtend, IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { EventResult } from '@rocket.chat/apps-engine/definition/eventResult';
import type {
	IMediaCallEndedContext,
	IMediaCallParticipantJoinedContext,
	IMediaCallStartedContext,
	IPostMediaCallEnded,
	IPostMediaCallParticipantJoined,
	IPostMediaCallStarted,
	IPreMediaCallCreated,
	IPreMediaCallCreatedContext,
	MediaCallCreateEventResult,
} from '@rocket.chat/apps-engine/definition/mediaCalls';
import type { ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import type { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';

export class CallRoutingApp
	extends App
	implements IPreMediaCallCreated, IPostMediaCallStarted, IPostMediaCallParticipantJoined, IPostMediaCallEnded
{
	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	protected async extendConfiguration(_configuration: IConfigurationExtend): Promise<void> {}

	// --- IPreCallCreatedHandler --------------------------------------------
	public async executePreMediaCallCreated(
		context: IPreMediaCallCreatedContext,
		read: IRead,
		_http: IHttp,
		_persistence: IPersistence,
	): Promise<MediaCallCreateEventResult> {
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

	// --- ICallStartedHandler -----------------------------------------------
	public async executePostMediaCallStarted(context: IMediaCallStartedContext, _read: IRead, _http: IHttp, _persis: IPersistence, _modify: IModify): Promise<void> {
		this.getLogger().info(`Call ${context.call.id} active — updating live agent dashboard`);
	}

	// --- IParticipantJoinedHandler -----------------------------------------
	public async executePostMediaCallParticipantJoined(context: IMediaCallParticipantJoinedContext): Promise<void> {
		this.getLogger().info(`Participant ${context.participant.id} joined call ${context.call.id}`);
	}

	// --- ICallEndedHandler -------------------------------------------------
	public async executePostMediaCallEnded(context: IMediaCallEndedContext, _read: IRead, _http: IHttp, persis: IPersistence): Promise<void> {
		// Persist a stateful communication log entry per call.
		await persis.createWithAssociation(
			{ callId: context.call.id, endedBy: context.endedBy?.id, reason: context.hangupReason, durationMs: context.durationMs },
			// (a MEDIA_CALL association would be added to RocketChatAssociationModel — see analysis doc §2.E)
			{ associations: [] } as never,
		);
	}
}
