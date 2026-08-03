import type { IMediaCall } from './IMediaCall';

/**
 * Context of `executePostMediaCallStarted` — media has been confirmed flowing by
 * at least one of the two sides of the call.
 */
export interface IMediaCallStartedContext {
	call: IMediaCall;
	startedAt: Date;
}
