/**
 * PROTOTYPE 3 — sample app (single collapsed interface + EventResult)
 *
 * The app implements ONE interface (`IMediaCallHandler`) exposing exactly two
 * methods. Each method dispatches on `context.eventType`, which narrows the
 * context to the exact per-event payload. No registration call — presence of a
 * method is the subscription, same as Prototype 1.
 */
import { App } from '@rocket.chat/apps-engine/definition/App';
import type { IAppAccessors, IConfigurationExtend, IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import type { ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { EventResult } from '@rocket.chat/apps-engine/definition/eventResult';
import type {
	IMediaCallHandler,
	MediaCallPreEventResult,
	PostMediaCallContext,
	PreMediaCallContext,
} from '@rocket.chat/apps-engine/definition/mediaCallsUnified';
import type { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';

export class CallRoutingApp extends App implements IMediaCallHandler {
	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	protected async extendConfiguration(_configuration: IConfigurationExtend): Promise<void> {}

	// --- pre-events (vetoable / patchable) ---------------------------------
	public async executePreMediaCall(context: PreMediaCallContext, read: IRead, _http: IHttp, _persistence: IPersistence): Promise<MediaCallPreEventResult> {
		switch (context.eventType) {
			case 'created': {
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
			default:
				return EventResult.pass();
		}
	}

	// --- post-events (fire-and-forget) -------------------------------------
	public async executePostMediaCall(context: PostMediaCallContext, _read: IRead, _http: IHttp, persis: IPersistence, _modify: IModify): Promise<void> {
		switch (context.eventType) {
			case 'callStarted':
				this.getLogger().info(`Call ${context.call.id} active — updating live agent dashboard`);
				break;

			case 'participantJoined':
				this.getLogger().info(`Participant ${context.participant.id} joined call ${context.call.id}`);
				break;

			case 'callEnded':
				// Persist a stateful communication log entry per call.
				await persis.createWithAssociation(
					{ callId: context.call.id, endedBy: context.endedBy?.id, reason: context.hangupReason, durationMs: context.durationMs },
					{ associations: [] } as never,
				);
				break;
		}
	}
}
