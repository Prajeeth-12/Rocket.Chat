/**
 * PROTOTYPE 2 — sample app (IMediaCallManager registered via configurationExtend)
 *
 * The app implements ONE object holding every media-call hook it wants, and
 * registers it once in extendConfiguration. Unimplemented hooks are simply
 * absent from the object. Pre-hooks return the unified `EventResult`.
 */
import { App } from '@rocket.chat/apps-engine/definition/App';
import type { IAppAccessors, IConfigurationExtend, IHttp, IModify, IPersistence, IRead, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { EventResult } from '@rocket.chat/apps-engine/definition/eventResult';
import type { IMediaCallManager } from '@rocket.chat/apps-engine/definition/mediaCallManagers';
import type { IPreMediaCallCreatedContext, IMediaCallEndedContext, IMediaCallStartedContext } from '@rocket.chat/apps-engine/definition/mediaCalls';
import type { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';

export class CallRoutingApp extends App {
	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	protected async extendConfiguration(configuration: IConfigurationExtend): Promise<void> {
		const manager: IMediaCallManager = {
			name: 'call-routing',

			// IPreCallCreatedHandler
			preCallCreate: async (context: IPreMediaCallCreatedContext, read: IRead): Promise<ReturnType<NonNullable<IMediaCallManager['preCallCreate']>>> => {
				const dndList = (await read.getEnvironmentReader().getSettings().getValueById('dnd_user_ids')) as string;
				if (context.callee.type === 'user' && dndList?.split(',').includes(context.callee.id)) {
					return EventResult.prevent({ i18n: { key: 'callee_is_dnd', args: { user: context.callee.username ?? context.callee.id } } });
				}
				if (!context.features.includes('recording')) {
					return EventResult.patch({ features: [...context.features, 'recording'] });
				}
				return EventResult.pass();
			},

			// ICallStartedHandler
			postCallStarted: async (context: IMediaCallStartedContext): Promise<void> => {
				this.getLogger().info(`Call ${context.call.id} active — updating live agent dashboard`);
			},

			// ICallEndedHandler
			postCallEnded: async (context: IMediaCallEndedContext, _read: IRead, _http: IHttp, persis: IPersistence): Promise<void> => {
				await persis.createWithAssociation(
					{ callId: context.call.id, endedBy: context.endedBy?.id, reason: context.hangupReason, durationMs: context.durationMs },
					{ associations: [] } as never,
				);
			},

			// IParticipantJoinedHandler intentionally omitted — this app doesn't need it,
			// so the method is simply absent (no empty stub, no interface to satisfy).
		};

		await configuration.registerMediaCallManager(manager);
	}
}

// (IModify imported to mirror the accessor set available to hooks; unused here.)
void (undefined as unknown as IModify);
