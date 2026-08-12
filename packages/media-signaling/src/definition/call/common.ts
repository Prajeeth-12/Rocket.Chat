export type CallActorType = 'user' | 'sip';

export type CallContact = {
	type?: CallActorType;
	id?: string;
	contractId?: string;

	displayName?: string;
	username?: string;
	sipExtension?: string;
};

export type CallRole = 'caller' | 'callee';

/**
 * A human-readable explanation of why a call was rejected, meant to be shown to
 * the user who requested it. It travels alongside the machine-readable
 * `CallRejectedReason`, which is what the client acts on - this is only ever
 * displayed.
 *
 * `i18n` messages name a key the client is expected to resolve; `ns` selects the
 * i18n namespace it lives in, so that whoever produced the message can point at
 * their own translations instead of the workspace's. A client that can't resolve
 * the key must fall back to a message of its own rather than render the key.
 */
export type CallRejectionMessage =
	| { type: 'text'; text: string }
	| { type: 'i18n'; key: string; args?: Record<string, string | number>; ns?: string };
