/**
 * What the engine knows about the app that produced a result, stamped host-side.
 * Everything else on an outcome is whatever the app sent over JSON-RPC, verbatim.
 */
export type EventResultMeta = {
	app: {
		id: string;
		/** The app's name as of the moment it acted. An uninstalled app cannot be asked for it. */
		name: string;
		/**
		 * The i18n namespace the app's translations resolve in. An app names a key and nothing
		 * else, and that key resolves to nothing on its own: it lives in a namespace of the app's
		 * own. The convention is the apps platform's, so no host has to know it.
		 */
		i18nNamespace: string;
		/**
		 * The app's translations of the key this result named, one entry per language the app
		 * ships. Absent when the result named no key, and when no language ships it - the host's
		 * signal to fall back rather than put a raw key in front of a user.
		 */
		translations?: Record<string, string>;
	};
};
