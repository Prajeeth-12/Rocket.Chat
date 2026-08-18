import { App } from '@rocket.chat/apps-engine/definition/App';
import type { IAppAccessors, IConfigurationExtend, ILogger, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiSecurity, ApiVisibility } from '@rocket.chat/apps-engine/definition/api';
import { EventResult } from '@rocket.chat/apps-engine/definition/eventResult';
import { isAnsweredCall, isKnownMediaCallHangupReason, isMissedCall, isRejectedCall } from '@rocket.chat/apps-engine/definition/mediaCalls';
import type {
	IMediaCallContact,
	IMediaCallEndedContext,
	IMediaCallHandler,
	IMediaCallParticipantJoinedContext,
	IMediaCallStartedContext,
	IPreMediaCallCreatedContext,
	MediaCallCreateEventResult,
} from '@rocket.chat/apps-engine/definition/mediaCalls';
import type { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { AppMethod } from '@rocket.chat/apps-engine/definition/metadata';

import { ModeEndpoint } from './endpoints/ModeEndpoint';
import { readMode } from './lib/mode';

/**
 * Exercises every method of `IMediaCallHandler` and records what it saw in the app
 * logs, which is how the e2e spec asserts the events actually arrived.
 */
export class MediaCallEventsTestApp extends App implements IMediaCallHandler {
	constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
		super(info, logger, accessors);
	}

	public async [AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED](
		context: IPreMediaCallCreatedContext,
		read: IRead,
	): Promise<MediaCallCreateEventResult> {
		const mode = await readMode(read.getPersistenceReader());

		this.getLogger().debug('pre_created_mode', mode);
		this.getLogger().debug('pre_created_caller', context.caller.username);
		this.getLogger().debug('pre_created_callee', context.callee.username);
		this.getLogger().debug('pre_created_created_by', context.createdBy.username);
		this.getLogger().debug('pre_created_features', [...context.features].sort().join(','));
		// Proves at the real serialization boundary that no credential rode along with
		// the contact - `contractId` is the per-session signing token the host strips.
		this.getLogger().debug('pre_created_caller_keys', contactKeys(context.caller));
		this.getLogger().debug('pre_created_origin', context.origin);

		if (mode === 'prevent') {
			return EventResult.prevent({ reason: 'blocked by media-call-events-test' });
		}

		if (mode === 'drop-screen-share') {
			return EventResult.patch({ features: context.features.filter((feature) => feature !== 'screen-share') });
		}

		return EventResult.pass();
	}

	public async [AppMethod.EXECUTE_POST_MEDIA_CALL_STARTED](context: IMediaCallStartedContext): Promise<void> {
		this.getLogger().debug('post_started_call', context.call.id);
		this.getLogger().debug('post_started_state', context.call.state);
		this.getLogger().debug('post_started_features', [...context.call.features].sort().join(','));
		this.getLogger().debug('post_started_has_started_at', String(Boolean(context.startedAt)));
		// Both shapes carry the origin, so the app can prove the pre context and the call agree
		this.getLogger().debug('post_started_origin', context.call.origin);
	}

	public async [AppMethod.EXECUTE_POST_MEDIA_CALL_PARTICIPANT_JOINED](context: IMediaCallParticipantJoinedContext): Promise<void> {
		this.getLogger().debug('post_joined_call', context.call.id);
		this.getLogger().debug('post_joined_participant', context.participant.username);
		this.getLogger().debug('post_joined_participant_keys', contactKeys(context.participant));
		this.getLogger().debug('post_joined_has_joined_at', String(Boolean(context.joinedAt)));
	}

	public async [AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED](context: IMediaCallEndedContext): Promise<void> {
		this.getLogger().debug('post_ended_call', context.call.id);
		this.getLogger().debug('post_ended_ended', String(context.call.ended));
		this.getLogger().debug('post_ended_by_type', context.endedBy?.type ?? 'none');
		this.getLogger().debug('post_ended_reason', context.hangupReason ?? 'none');
		this.getLogger().debug('post_ended_duration_ms', String(context.durationMs));
		this.getLogger().debug('post_ended_reason_known', String(isKnownMediaCallHangupReason(context.hangupReason)));
		this.getLogger().debug('post_ended_outcome', describeOutcome(context));

		if (isAnsweredCall(context)) {
			// The guard narrows `acceptedAt` to a required Date, so this needs no assertion.
			this.getLogger().debug('post_ended_accepted_at', context.call.acceptedAt.toISOString());
		}
	}

	protected override async extendConfiguration(configuration: IConfigurationExtend): Promise<void> {
		await configuration.api.provideApi({
			visibility: ApiVisibility.PUBLIC,
			security: ApiSecurity.UNSECURE,
			endpoints: [new ModeEndpoint(this)],
		});
	}
}

function contactKeys(contact: IMediaCallContact): string {
	return Object.keys(contact).sort().join(',');
}

/**
 * There is no event for a call nobody answered, so an app has to read the outcome
 * off the end event. `'unreachable'` can never be logged: the three guards partition
 * every ended call, and the e2e spec asserts the label never appears.
 */
function describeOutcome(context: IMediaCallEndedContext): string {
	if (isAnsweredCall(context)) {
		return 'answered';
	}

	if (isRejectedCall(context)) {
		return 'rejected';
	}

	if (isMissedCall(context)) {
		return 'missed';
	}

	return 'unreachable';
}
