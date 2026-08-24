import type { MarkedEventResult } from '@rocket.chat/apps-engine/definition/eventResult';

import type { ProxiedApp } from '../ProxiedApp';
import type { EventResultMeta } from './EventResultMeta';
import type { HostEventResult } from './HostEventResult';
import { getAppTranslationNamespace, getAppTranslationsForKey } from '../misc/appTranslations';

/**
 * Everything the engine knows about the app, including what it takes to resolve the one key the
 * result named. `i18nNamespace` follows from the app's id alone, so it is reported on every
 * result; `translations` is keyed to a result that named a key.
 */
function makeEventResultMeta(app: ProxiedApp, i18nKey?: string): EventResultMeta {
	const translations = i18nKey === undefined ? undefined : getAppTranslationsForKey(app, i18nKey);

	return {
		app: {
			id: app.getID(),
			name: app.getName(),
			i18nNamespace: getAppTranslationNamespace(app.getID()),
			...(translations && { translations }),
		},
	};
}

/**
 * Turns what an app returned into what the apps platform reports to the host: the app's own
 * payload, plus everything about the app that only the engine can supply.
 *
 * The engine holds the `ProxiedApp` and the host does not, so the engine answers here rather
 * than leaving each host to look the app up a second time - and `docs/apps-engine-migration.md`
 * is in the process of turning any such lookup into a NATS call. A host reads a
 * `HostEventResult` and never a `MarkedEventResult`.
 *
 * Everything the engine adds is built from the `ProxiedApp` alone and never merged with what the
 * app returned: `isEventResult` only recognizes the marker, so an app can put anything -
 * including a `meta` - under it.
 */
export function makeHostEventResult<T>(app: ProxiedApp, result: MarkedEventResult<T>): HostEventResult<T> {
	if (result.type === 'prevent') {
		const i18n = 'i18n' in result && result.i18n ? result.i18n : undefined;

		return {
			type: 'prevent',
			meta: makeEventResultMeta(app, i18n?.key),
			...('reason' in result && { reason: result.reason }),
			...(i18n && { i18n }),
		};
	}

	if (result.type === 'patch') {
		return { type: 'patch', patch: result.patch, meta: makeEventResultMeta(app) };
	}

	// `pass`, and any `type` an app sent that the types never got to check. The type travels
	// as it arrived, so the caller can still report an unsupported one by name.
	return { type: result.type, meta: makeEventResultMeta(app) };
}
