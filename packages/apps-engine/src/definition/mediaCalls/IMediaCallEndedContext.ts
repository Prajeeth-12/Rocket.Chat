import type { IRoom } from '../rooms';
import type { IUser } from '../users';

export type MediaCallEndReason = 'completed' | 'declined' | 'missed' | 'failed' | 'cancelled';

/** Context passed to the post-media-call-ended handler, once a call has ended. */
export interface IMediaCallEndedContext {
	callId: string;
	room: IRoom;
	caller: IUser;
	callee: IUser;
	endedAt: Date;
	reason: MediaCallEndReason;
	durationMs?: number;
}
