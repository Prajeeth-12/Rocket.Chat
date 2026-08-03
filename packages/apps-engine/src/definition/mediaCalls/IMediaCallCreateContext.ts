import type { IRoom } from '../rooms';
import type { IUser } from '../users';

/** A requested media-call capability, e.g. `'audio'`, `'video'`, `'recording'`, `'screen-share'`. */
export type MediaCallFeature = string;

/** Context passed to the pre-media-call-create handler, before a call is created. */
export interface IMediaCallCreateContext {
	callId: string;
	room: IRoom;
	caller: IUser;
	callee: IUser;
	features: MediaCallFeature[];
}
