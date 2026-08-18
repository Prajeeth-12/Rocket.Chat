import { AppEvents, Apps } from '@rocket.chat/apps';
import type {
	IAcceptedMediaCall as IAppsAcceptedMediaCall,
	IActiveMediaCall as IAppsActiveMediaCall,
	IEndedMediaCall as IAppsEndedMediaCall,
	IMediaCall as IAppsMediaCall,
	IMediaCallActor as IAppsMediaCallActor,
	IMediaCallContact as IAppsMediaCallContact,
	IPreMediaCallCreatedContext,
	MediaCallEvent,
	MediaCallOrigin,
	PreMediaCallCreatedOutcome,
} from '@rocket.chat/apps-engine/definition/mediaCalls';
import { AppMethod } from '@rocket.chat/apps-engine/definition/metadata';
import type { IMediaCall, MediaCallActor, MediaCallContact, ServerActor } from '@rocket.chat/core-typings';
import type { PreCallCreatedHookParams, PreCallCreatedHookResult } from '@rocket.chat/media-calls';
import { callFeatureList, type CallFeature, type CallRejectionMessage } from '@rocket.chat/media-signaling';
import { MediaCalls } from '@rocket.chat/models';

import { logger } from './logger';

/**
 * Maps media calls onto the shapes apps see and dispatches the media-call
 * lifecycle events to the Apps-Engine.
 *
 * Every event travels under the single `IMediaCallHandler` interface; the
 * `method` on the envelope is what tells the listener manager which of the
 * handler's optional methods to call.
 */

/** Contacts carry a per-session signing token, which is a credential: only these fields may reach an app. */
function toAppContact(contact: MediaCallContact): IAppsMediaCallContact {
	return {
		type: contact.type,
		id: contact.id,
		...(contact.username && { username: contact.username }),
		...(contact.displayName && { displayName: contact.displayName }),
		...(contact.sipExtension && { sipExtension: contact.sipExtension }),
	};
}

/**
 * The two contacts are the origin: a sip caller means the call arrived from the
 * PBX, a sip callee means it was placed out through it, and neither means it never
 * leaves the workspace. Both contacts are final before any event is built, so
 * apps do not have to reimplement the routing rules to tell the cases apart.
 *
 * A sip/sip pair cannot occur: an external callee requires a user caller, and an
 * inbound INVITE requires a user callee.
 */
function getCallOrigin(caller: MediaCallContact, callee: MediaCallContact): MediaCallOrigin {
	if (caller.type === 'sip') {
		return 'sip-inbound';
	}

	if (callee.type === 'sip') {
		return 'sip-outbound';
	}

	return 'internal';
}

function toAppActor(actor: MediaCallActor | ServerActor): IAppsMediaCallActor {
	return {
		type: actor.type,
		id: actor.id,
	};
}

function toAppMediaCall(call: IMediaCall): IAppsMediaCall {
	return {
		id: call._id,
		service: call.service,
		kind: call.kind,
		state: call.state,
		origin: getCallOrigin(call.caller, call.callee),
		createdBy: toAppContact(call.createdBy),
		createdAt: call.createdAt,
		caller: toAppContact(call.caller),
		callee: toAppContact(call.callee),
		features: call.features,
		uids: call.uids,
		ended: call.ended,
		...(call.endedAt && { endedAt: call.endedAt }),
		...(call.endedBy && { endedBy: toAppActor(call.endedBy) }),
		...(call.hangupReason && { hangupReason: call.hangupReason }),
		...(call.acceptedAt && { acceptedAt: call.acceptedAt }),
		...(call.activatedAt && { activatedAt: call.activatedAt }),
		...(call.parentCallId && { parentCallId: call.parentCallId }),
		...(call.divertedBy && { divertedBy: toAppContact(call.divertedBy) }),
	};
}

/**
 * Each post event promises the apps one timestamp on the call it carries. The
 * event is dispatched after the write that sets it, so the timestamp is there.
 * A call that arrives without it cannot keep the promise, and an app that acts on
 * a made-up time is worse off than an app that never hears about the call, so the
 * event is dropped instead.
 */
function getEventTimestamp(call: IMediaCall, field: 'activatedAt' | 'acceptedAt' | 'endedAt'): Date | undefined {
	if (!call[field]) {
		logger.warn({ msg: 'Skipped a media call event for a call that carries no timestamp for it', callId: call._id, field });
	}

	return call[field];
}

function toAppActiveMediaCall(call: IMediaCall): IAppsActiveMediaCall | undefined {
	const activatedAt = getEventTimestamp(call, 'activatedAt');

	return activatedAt && { ...toAppMediaCall(call), activatedAt };
}

function toAppAcceptedMediaCall(call: IMediaCall): IAppsAcceptedMediaCall | undefined {
	const acceptedAt = getEventTimestamp(call, 'acceptedAt');

	return acceptedAt && { ...toAppMediaCall(call), acceptedAt };
}

function toAppEndedMediaCall(call: IMediaCall): IAppsEndedMediaCall | undefined {
	const endedAt = getEventTimestamp(call, 'endedAt');

	return endedAt && { ...toAppMediaCall(call), ended: true, endedAt };
}

/** `0` for a call that never became active, and never negative. */
function getCallDurationInMs(activatedAt: Date | undefined, endedAt: Date): number {
	if (!activatedAt) {
		return 0;
	}

	return Math.max(0, endedAt.valueOf() - activatedAt.valueOf());
}

function isCallFeature(feature: string): feature is CallFeature {
	return (callFeatureList as readonly string[]).includes(feature);
}

async function triggerMediaCallEvent(event: MediaCallEvent): Promise<unknown> {
	return Apps.self?.triggerEvent(AppEvents.IMediaCallHandler, event);
}

/**
 * Loads a call and dispatches one of the post events for it. Post events are
 * observational, so a call that can no longer be loaded, or that cannot carry the
 * event, is not an error worth disrupting anything over.
 */
async function triggerPostMediaCallEvent(
	callId: IMediaCall['_id'],
	getEvent: (call: IMediaCall) => Exclude<MediaCallEvent, { method: AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED }> | undefined,
): Promise<void> {
	if (!Apps.self) {
		return;
	}

	const call = await MediaCalls.findOneById(callId);
	if (!call) {
		logger.warn({ msg: 'Unable to notify apps about a call that no longer exists', callId });
		return;
	}

	const event = getEvent(call);
	if (!event) {
		// `getEventTimestamp` already logged what the call is missing
		return;
	}

	await triggerMediaCallEvent(event);
}

export async function notifyAppsOfMediaCallStarted(callId: IMediaCall['_id']): Promise<void> {
	return triggerPostMediaCallEvent(callId, (call) => {
		const activeCall = toAppActiveMediaCall(call);

		return activeCall && { method: AppMethod.EXECUTE_POST_MEDIA_CALL_STARTED, context: { call: activeCall } };
	});
}

export async function notifyAppsOfMediaCallParticipantJoined(callId: IMediaCall['_id']): Promise<void> {
	// Calls are strictly two-party, so the side that joins is always `call.callee`
	return triggerPostMediaCallEvent(callId, (call) => {
		const acceptedCall = toAppAcceptedMediaCall(call);

		return acceptedCall && { method: AppMethod.EXECUTE_POST_MEDIA_CALL_PARTICIPANT_JOINED, context: { call: acceptedCall } };
	});
}

export async function notifyAppsOfMediaCallEnded(callId: IMediaCall['_id']): Promise<void> {
	return triggerPostMediaCallEvent(callId, (call) => {
		const endedCall = toAppEndedMediaCall(call);

		return (
			endedCall && {
				method: AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED,
				context: {
					call: endedCall,
					durationMs: getCallDurationInMs(call.activatedAt, endedCall.endedAt),
				},
			}
		);
	});
}

/** An app's explanation is shown in a toast, so it can't be allowed to be arbitrarily long. */
const MAX_REJECTION_TEXT_LENGTH = 200;

/**
 * Turns what an app said about a call it blocked into something the caller can
 * be shown. An app's translations are registered on the client under a namespace
 * of its own, so an `i18n` key is only resolvable together with the id of the app
 * that produced it.
 */
function toRejectionMessage(outcome: PreMediaCallCreatedOutcome & { prevented: true }): CallRejectionMessage | undefined {
	if (outcome.i18n) {
		return {
			type: 'i18n',
			key: outcome.i18n.key,
			ns: `app-${outcome.appId}`,
			...(outcome.i18n.args && { args: outcome.i18n.args }),
		};
	}

	if (outcome.reason) {
		return { type: 'text', text: outcome.reason.slice(0, MAX_REJECTION_TEXT_LENGTH) };
	}

	return undefined;
}

/**
 * Runs the pre-media-call-created event and translates its outcome back into
 * something the media call server understands. Apps may block the call or change
 * the features it was requested with; anything else they try to patch is dropped
 * by the listener manager.
 */
export async function runPreMediaCallCreatedAppHook(params: PreCallCreatedHookParams): Promise<PreCallCreatedHookResult> {
	if (!Apps.self) {
		return { prevented: false };
	}

	const context: IPreMediaCallCreatedContext = {
		caller: toAppContact(params.caller),
		callee: toAppContact(params.callee),
		createdBy: toAppContact(params.createdBy),
		features: [...params.features],
		origin: getCallOrigin(params.caller, params.callee),
		...(params.parentCallId && { parentCallId: params.parentCallId }),
		...(params.divertedBy && { divertedBy: toAppContact(params.divertedBy) }),
	};

	const outcome = (await triggerMediaCallEvent({
		method: AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED,
		context,
	})) as PreMediaCallCreatedOutcome | undefined;

	if (!outcome) {
		return { prevented: false };
	}

	if (outcome.prevented) {
		logger.info({
			msg: 'An app prevented a media call from being created',
			appId: outcome.appId,
			reason: outcome.reason || outcome.i18n?.key,
		});

		return {
			prevented: true,
			reason: outcome.reason || outcome.i18n?.key,
			message: toRejectionMessage(outcome),
		};
	}

	// Apps are free to ask for features that don't exist; only the known ones move on
	const features = outcome.context.features.filter(isCallFeature);

	return { prevented: false, features };
}
