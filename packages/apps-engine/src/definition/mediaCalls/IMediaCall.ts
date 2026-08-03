/** A media-call capability, e.g. `'audio'`, `'video'`, `'screen-share'`. */
export type MediaCallFeature = string;

/** Media calls happen between workspace users and/or external SIP endpoints. */
export type MediaCallActorType = 'user' | 'sip';

/** The states a call may be persisted in. */
export type MediaCallState = 'none' | 'ringing' | 'accepted' | 'active' | 'hangup';

/**
 * Whoever acted on a call. `'server'` covers the transitions that have no human
 * actor behind them — expiration, internal errors and forced hangups.
 */
export interface IMediaCallActor {
	type: MediaCallActorType | 'server';
	id: string;
}

/**
 * One of the two sides of a call. Either side may be an external SIP endpoint
 * instead of a workspace user, so always check `type` before treating `id` as a
 * user id.
 *
 * The per-session signing token of the contact is deliberately absent: it is a
 * credential, and it never crosses into an app.
 */
export interface IMediaCallContact {
	type: MediaCallActorType;
	id: string;
	username?: string;
	displayName?: string;
	sipExtension?: string;
}

/**
 * A media call — the 1:1 direct audio/video calls between two contacts, as
 * opposed to a video conference. Read-only snapshot of the call as it was when
 * the event was emitted.
 */
export interface IMediaCall {
	id: string;
	service: 'webrtc';
	kind: 'direct';
	state: MediaCallState;

	/** Who requested the call — the caller, except on transfers. */
	createdBy: IMediaCallContact;
	createdAt: Date;

	caller: IMediaCallContact;
	callee: IMediaCallContact;

	/** The features this call may use. Values are final once the call is accepted. */
	features: MediaCallFeature[];

	/** Ids of the workspace users on the call; external SIP endpoints are not listed here. */
	uids: string[];

	ended: boolean;
	endedAt?: Date;
	endedBy?: IMediaCallActor;
	/** Free-form reason recorded by whoever ended the call, e.g. `'not-answered'`, `'expired'`, `'transfer'`. */
	hangupReason?: string;

	/** When the callee accepted the call. */
	acceptedAt?: Date;
	/** When either side first reported media flowing. */
	activatedAt?: Date;

	/** Set when this call replaced another one through a transfer. */
	parentCallId?: string;
}
