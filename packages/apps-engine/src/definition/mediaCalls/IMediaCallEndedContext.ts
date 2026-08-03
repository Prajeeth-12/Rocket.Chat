import type { IMediaCall, IMediaCallActor } from './IMediaCall';

/**
 * Context of `executePostMediaCallEnded`. Every call ends through this event,
 * including the ones no user ended — expiration, transport errors and transfers
 * report a `'server'` actor in `endedBy`.
 */
export interface IMediaCallEndedContext {
	call: IMediaCall;
	endedAt: Date;
	/** Absent when the call was ended by something that isn't an identifiable actor. */
	endedBy?: IMediaCallActor;
	/** Free-form reason recorded by whoever ended the call, e.g. `'not-answered'`, `'expired'`, `'transfer'`. */
	hangupReason?: string;
	/** How long media was flowing. `0` for calls that never became active. */
	durationMs: number;
}
