import type { IRoom } from '../rooms';
import type { IUser } from '../users';

/** Context passed to the post-media-call-participant-joined handler. */
export interface IMediaCallParticipantJoinedContext {
	callId: string;
	room: IRoom;
	participant: IUser;
	joinedAt: Date;
}
