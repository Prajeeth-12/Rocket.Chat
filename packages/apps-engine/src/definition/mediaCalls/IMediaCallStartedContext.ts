import type { MediaCallFeature } from './IMediaCallCreateContext';
import type { IRoom } from '../rooms';
import type { IUser } from '../users';

/** Context passed to the post-media-call-started handler, once a call has started. */
export interface IMediaCallStartedContext {
	callId: string;
	room: IRoom;
	caller: IUser;
	callee: IUser;
	features: MediaCallFeature[];
	startedAt: Date;
}
