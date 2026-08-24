import type { I18nMessage } from '@rocket.chat/apps-engine/definition/eventResult';

import type { EventResultMeta } from './EventResultMeta';

/**
 * A `prevent` result as the host reads it. Named on its own because every executor that
 * returns an outcome of its own reports a prevention with these three fields.
 */
export type PreventedEventResult = {
	/** What the engine knows about the app that produced the result. */
	meta: EventResultMeta;
	reason?: string;
	i18n?: I18nMessage;
};

/**
 * What an app returned, completed by the engine - the only form of an `EventResult` a host
 * ever reads.
 *
 * A `MarkedEventResult` is what crosses the JSON-RPC boundary, and it names the app nowhere.
 * The engine holds the `ProxiedApp` and the host does not, so the engine stamps everything
 * the host needs onto the result, once, at the moment it has it.
 *
 * Everything the engine adds goes under `meta`. What the app sent travels beside it,
 * untouched: a developer who prints a result reads back exactly the object their app
 * returned, and nothing the host writes can collide with it.
 */
export type HostEventResult<T = unknown> =
	| { type: 'pass'; meta: EventResultMeta }
	| { type: 'patch'; patch: Partial<T>; meta: EventResultMeta }
	| ({ type: 'prevent' } & PreventedEventResult);
