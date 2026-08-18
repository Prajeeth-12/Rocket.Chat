import type { IMediaCall, IMediaCallActor } from './IMediaCall';
import type { MediaCallHangupReason } from './MediaCallHangupReason';

/**
 * Context of `executePostMediaCallEnded`. Every call ends through this event,
 * including the ones no user ended — expiration, transport errors and transfers
 * report a `'server'` actor in `endedBy`.
 *
 * There is no separate event for a call nobody answered. Use `isMissedCall`,
 * `isRejectedCall` and `isAnsweredCall` to tell the outcomes apart.
 */
export interface IMediaCallEndedContext {
	call: IMediaCall;
	endedAt: Date;
	/** Absent when the call was ended by something that isn't an identifiable actor. */
	endedBy?: IMediaCallActor;
	/** Why the call ended. The known values are not exhaustive — see {@link MediaCallHangupReason}. */
	hangupReason?: MediaCallHangupReason;
	/** How long media was flowing. `0` for calls that never became active. */
	durationMs: number;
}
