import type { IHttp, IModify, IPersistence, IRead } from '../accessors';
import { AppMethod } from '../metadata';
import type {
	IMediaCallCreateContext,
	IMediaCallEndedContext,
	IMediaCallParticipantJoinedContext,
	IMediaCallStartedContext,
	MediaCallCreateEventResult,
} from '../mediaCalls';

/**
 * Aggregate handler for the media-call lifecycle events — Prototype 4 of
 * docs/proposals/prototypes/ergonomics-evaluation.md. One optional method per
 * event, keyed by `AppMethod`, on a single interface — the same shape as
 * `IUIKitActionHandler`. A method's presence is its subscription; there is no
 * `context.eventType` discriminant (unlike Prototype 3), so each method keeps
 * its own restricted `EventResult` return type.
 *
 * Scaffolding only: this is the app-facing type. Engine dispatch (the
 * `AppListenerManager` executor per method, the `ListenerBridge` case, the host
 * trigger site) is Prototype 1's and is not wired up here.
 */
export interface IMediaCallHandler {
	/**
	 * Enables the handler to signal to the Apps framework whether this handler
	 * should actually run for the media call about to be created.
	 */
	[AppMethod.CHECK_PRE_MEDIA_CALL_CREATED]?(context: IMediaCallCreateContext, read: IRead, http: IHttp): Promise<boolean>;

	/**
	 * Called before a media call is created. May `pass`, `patch` the call's
	 * requested features, or `prevent` the call from being created.
	 */
	[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]?(
		context: IMediaCallCreateContext,
		read: IRead,
		http: IHttp,
		persistence: IPersistence,
		modify: IModify,
	): Promise<MediaCallCreateEventResult>;

	/** Called once a media call has started. Fire-and-forget. */
	[AppMethod.EXECUTE_POST_MEDIA_CALL_STARTED]?(context: IMediaCallStartedContext, read: IRead, http: IHttp, persistence: IPersistence): Promise<void>;

	/** Called when a participant joins an ongoing media call. Fire-and-forget. */
	[AppMethod.EXECUTE_POST_MEDIA_CALL_PARTICIPANT_JOINED]?(
		context: IMediaCallParticipantJoinedContext,
		read: IRead,
		http: IHttp,
		persistence: IPersistence,
	): Promise<void>;

	/** Called once a media call has ended. Fire-and-forget. */
	[AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED]?(context: IMediaCallEndedContext, read: IRead, http: IHttp, persistence: IPersistence): Promise<void>;
}
