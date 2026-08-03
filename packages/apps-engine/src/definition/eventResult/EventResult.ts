import type { Block, TextObject } from '@rocket.chat/ui-kit';

/**
 * Reserved discriminator stamped by the `EventResult.*` factories below.
 * App authors never write this by hand — see
 * docs/proposals/apps-engine-event-result-return-type.md §"The discriminator".
 */
export const EVENT_RESULT_KIND = 'EventResult';

interface IMarker {
	'@kind': typeof EVENT_RESULT_KIND;
}

export type I18nMessage = {
	key: string;
	args?: { [key: string]: string | number };
};

type PromptPayload =
	| { message: string }
	| { i18n: I18nMessage }
	| {
			title?: TextObject;
			text?: TextObject;
			blocks?: Block[];
			confirmLabel?: string;
			cancelLabel?: string;
	  };

/**
 * Author-facing, marker-free union — the type app authors annotate a handler's
 * return type against (directly, or via a per-event restricted alias).
 */
export type EventResult<T = unknown> =
	| { type: 'pass' }
	| { type: 'patch'; patch: Partial<T> }
	| ({ type: 'prevent' } & ({ reason: string } | { i18n: I18nMessage }))
	| ({ type: 'prompt' } & PromptPayload);

/** Branded variant returned by `EventResult.pass()`. */
export type PassEventResult = IMarker & { type: 'pass' };

/** Branded variant returned by `EventResult.patch()`. */
export type PatchEventResult<T> = IMarker & { type: 'patch'; patch: Partial<T> };

/** Branded variant returned by `EventResult.prevent()`. */
export type PreventEventResult = IMarker & { type: 'prevent' } & ({ reason: string } | { i18n: I18nMessage });

/** Branded variant returned by `EventResult.prompt()`. */
export type PromptEventResult = IMarker & { type: 'prompt' } & PromptPayload;

/**
 * The shape that actually crosses the JSON-RPC boundary and that
 * `isEventResult()` recognizes — `EventResult` widened with the `@kind` marker.
 */
export type MarkedEventResult<T = unknown> = PassEventResult | PatchEventResult<T> | PreventEventResult | PromptEventResult;

/**
 * Companion-object factories. `EventResult` is simultaneously the marker-free
 * union *type* above and this factory *value* namespace (same name, separate
 * type/value namespaces — no declaration-merging trick needed). Each factory
 * stamps `@kind` and returns a branded per-variant type so that a handler whose
 * return type is a restricted union (e.g. `pass | patch`) fails to typecheck if
 * an author returns a disallowed variant (e.g. `prompt`).
 */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the union type and the factory namespace share a name on purpose
export const EventResult = {
	pass(): PassEventResult {
		return { '@kind': EVENT_RESULT_KIND, 'type': 'pass' };
	},

	patch<T>(patch: Partial<T>): PatchEventResult<T> {
		return { '@kind': EVENT_RESULT_KIND, 'type': 'patch', patch };
	},

	prevent(input: { reason: string } | { i18n: I18nMessage }): PreventEventResult {
		return { '@kind': EVENT_RESULT_KIND, 'type': 'prevent', ...input };
	},

	prompt(input: PromptPayload): PromptEventResult {
		return { '@kind': EVENT_RESULT_KIND, 'type': 'prompt', ...input };
	},
};
