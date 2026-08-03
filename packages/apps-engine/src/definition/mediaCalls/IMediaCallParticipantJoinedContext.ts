import type { IMediaCall, IMediaCallContact } from './IMediaCall';

/**
 * Context of `executePostMediaCallParticipantJoined`, emitted when the callee
 * accepts the call.
 *
 * Media calls are strictly two-party (`kind: 'direct'`), so this event fires at
 * most once per call and `participant` is always the callee — there is no
 * server-side participant list to join or leave. The departure side of a call is
 * `executePostMediaCallEnded`.
 */
export interface IMediaCallParticipantJoinedContext {
	call: IMediaCall;
	participant: IMediaCallContact;
	joinedAt: Date;
}
