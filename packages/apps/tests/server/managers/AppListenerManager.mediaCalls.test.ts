import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { EventResult } from '@rocket.chat/apps-engine/definition/eventResult';
import type {
	IMediaCallEndedContext,
	IPreMediaCallCreatedContext,
	PreMediaCallCreatedOutcome,
} from '@rocket.chat/apps-engine/definition/mediaCalls';
import { AppInterface, AppMethod } from '@rocket.chat/apps-engine/definition/metadata';

import type { AppManager } from '../../../src/server/AppManager';
import type { ProxiedApp } from '../../../src/server/ProxiedApp';
import { AppListenerManager } from '../../../src/server/managers';
import { JSONRPC_METHOD_NOT_FOUND } from '../../../src/server/runtime/base/BaseRuntimeSubprocessController';

type AppMethodHandlers = Record<string, (...args: any[]) => unknown>;

/**
 * Every method of `IMediaCallHandler` is optional, and an app that doesn't
 * implement one answers the way the runtime does: a method-not-found error.
 */
function mockApp(id: string, handlers: AppMethodHandlers): ProxiedApp {
	return {
		getID() {
			return id;
		},
		getImplementationList() {
			return { [AppInterface.IMediaCallHandler]: true } as { [inte: string]: boolean };
		},
		async call(method: string, ...args: unknown[]) {
			if (!(method in handlers)) {
				throw Object.assign(new Error(`Method not found: ${method}`), { code: JSONRPC_METHOD_NOT_FOUND });
			}

			return handlers[method](...args);
		},
	} as unknown as ProxiedApp;
}

function managerFor(apps: ProxiedApp[]): AppManager {
	return {
		getOneById(appId: string) {
			return apps.find((app) => app.getID() === appId);
		},
	} as AppManager;
}

function listenerManagerFor(apps: ProxiedApp[]): AppListenerManager {
	const listenerManager = new AppListenerManager(managerFor(apps));

	apps.forEach((app) => listenerManager.registerListeners(app));

	return listenerManager;
}

const context: IPreMediaCallCreatedContext = {
	caller: { type: 'user', id: 'caller-id', username: 'caller' },
	callee: { type: 'user', id: 'callee-id', username: 'callee' },
	createdBy: { type: 'user', id: 'caller-id', username: 'caller' },
	features: ['audio'],
};

async function runPreCallCreated(apps: ProxiedApp[]): Promise<PreMediaCallCreatedOutcome> {
	const outcome = await listenerManagerFor(apps).executeListener(AppInterface.IMediaCallHandler, {
		method: AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED,
		context,
	});

	return outcome as PreMediaCallCreatedOutcome;
}

describe('AppListenerManager media call events', () => {
	describe('pre media call created', () => {
		it('passes the context through untouched when every app passes', async () => {
			const outcome = await runPreCallCreated([
				mockApp('passing', { [AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: () => EventResult.pass() }),
			]);

			assert.deepStrictEqual(outcome, { prevented: false, context });
		});

		it('skips apps that only implement the post events', async () => {
			const outcome = await runPreCallCreated([mockApp('post-only', { [AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED]: () => undefined })]);

			assert.deepStrictEqual(outcome, { prevented: false, context });
		});

		it('reports the app that prevented the call and stops consulting the others', async () => {
			const consulted: string[] = [];
			const outcome = await runPreCallCreated([
				mockApp('preventing', {
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: () => {
						consulted.push('preventing');
						return EventResult.prevent({ reason: 'callee is on a do-not-disturb list' });
					},
				}),
				mockApp('later', {
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: () => {
						consulted.push('later');
						return EventResult.pass();
					},
				}),
			]);

			assert.deepStrictEqual(outcome, {
				prevented: true,
				appId: 'preventing',
				reason: 'callee is on a do-not-disturb list',
			});
			assert.deepStrictEqual(consulted, ['preventing']);
		});

		it('carries an i18n prevention reason', async () => {
			const outcome = await runPreCallCreated([
				mockApp('preventing', {
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: () => EventResult.prevent({ i18n: { key: 'callee_is_dnd' } }),
				}),
			]);

			assert.deepStrictEqual(outcome, { prevented: true, appId: 'preventing', i18n: { key: 'callee_is_dnd' } });
		});

		it('chains patches, handing each app what the previous one patched', async () => {
			const seen: string[][] = [];
			const outcome = await runPreCallCreated([
				mockApp('first', {
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: (ctx: IPreMediaCallCreatedContext) => {
						seen.push(ctx.features);
						return EventResult.patch({ features: [...ctx.features, 'hold'] });
					},
				}),
				mockApp('second', {
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: (ctx: IPreMediaCallCreatedContext) => {
						seen.push(ctx.features);
						return EventResult.patch({ features: [...ctx.features, 'transfer'] });
					},
				}),
			]);

			assert.deepStrictEqual(seen, [['audio'], ['audio', 'hold']]);
			assert.deepStrictEqual(outcome, {
				prevented: false,
				context: { ...context, features: ['audio', 'hold', 'transfer'] },
			});
		});

		it('drops patches to anything other than the requested features', async () => {
			const outcome = await runPreCallCreated([
				mockApp('rerouting', {
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: () =>
						EventResult.patch({ callee: { type: 'user', id: 'someone-else' }, features: ['audio', 'hold'] } as never),
				}),
			]);

			assert.deepStrictEqual(outcome, { prevented: false, context: { ...context, features: ['audio', 'hold'] } });
		});

		it('does not run the handler of an app whose check opted out', async () => {
			let executed = false;
			const outcome = await runPreCallCreated([
				mockApp('opting-out', {
					[AppMethod.CHECK_PRE_MEDIA_CALL_CREATED]: () => false,
					[AppMethod.EXECUTE_PRE_MEDIA_CALL_CREATED]: () => {
						executed = true;
						return EventResult.prevent({ reason: 'should never run' });
					},
				}),
			]);

			assert.strictEqual(executed, false);
			assert.deepStrictEqual(outcome, { prevented: false, context });
		});
	});

	describe('post media call events', () => {
		const endedContext: IMediaCallEndedContext = {
			call: {
				id: 'call-id',
				service: 'webrtc',
				kind: 'direct',
				state: 'hangup',
				createdBy: context.caller,
				createdAt: new Date(0),
				caller: context.caller,
				callee: context.callee,
				features: ['audio'],
				uids: ['caller-id', 'callee-id'],
				ended: true,
			},
			endedAt: new Date(0),
			durationMs: 0,
		};

		async function triggerCallEnded(apps: ProxiedApp[]): Promise<void> {
			await listenerManagerFor(apps).executeListener(AppInterface.IMediaCallHandler, {
				method: AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED,
				context: endedContext,
			});

			// Post events are dispatched without being awaited
			await new Promise((resolve) => setImmediate(resolve));
		}

		it('hands the context to every app that implements the event', async () => {
			const notified: string[] = [];

			await triggerCallEnded([
				mockApp('logging', {
					[AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED]: (ctx: typeof endedContext) => {
						notified.push(`logging:${ctx.call.id}`);
					},
				}),
				mockApp('billing', {
					[AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED]: (ctx: typeof endedContext) => {
						notified.push(`billing:${ctx.call.id}`);
					},
				}),
			]);

			assert.deepStrictEqual(notified, ['logging:call-id', 'billing:call-id']);
		});

		it('keeps notifying the other apps when one fails or does not implement the event', async () => {
			const notified: string[] = [];

			await triggerCallEnded([
				mockApp('failing', {
					[AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED]: () => {
						throw new Error('app blew up');
					},
				}),
				mockApp('not-subscribed', { [AppMethod.EXECUTE_POST_MEDIA_CALL_STARTED]: () => undefined }),
				mockApp('logging', {
					[AppMethod.EXECUTE_POST_MEDIA_CALL_ENDED]: () => {
						notified.push('logging');
					},
				}),
			]);

			assert.deepStrictEqual(notified, ['logging']);
		});
	});
});
