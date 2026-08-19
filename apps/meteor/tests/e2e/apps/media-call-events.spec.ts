import type { Page } from '@playwright/test';

import { appMediaCallEventsTest } from '../../data/apps/app-packages';
import { IS_EE } from '../config/constants';
import { createAuxContext } from '../fixtures/createAuxContext';
import { Users } from '../fixtures/userStates';
import { HomeChannel } from '../page-objects';
import { getSettingValueById, setSettingValueById } from '../utils';
import {
	findAppLogItem,
	getAppLogValue,
	getAppLogs,
	getNewestAppLog,
	installLocalTestPackage,
	uninstallApp,
	waitForNewAppLog,
} from '../utils/apps';
import type { BaseTest } from '../utils/test';
import { expect, test } from '../utils/test';

/** Matches the modes the fixture app understands - see tests/data/apps/app-packages/README.md. */
type Mode = 'pass' | 'prevent' | 'drop-screen-share';

/** `entries[].args[1]` for a label, within a single already-located log group. */
const entryValue = (log: { entries: { args: string[] }[] } | undefined, label: string): string | undefined =>
	log?.entries.find((entry) => entry.args[0] === label)?.args[1];

/**
 * Split into two serial groups on purpose: within a group the tests share one pair of calls'
 * worth of state and have to run in order, but a failure in one group must not skip the other.
 */
test.describe('Apps > Media call events', () => {
	test.skip(!IS_EE, 'Enterprise Edition Only');

	let appId: string;
	let sessions: { page: Page; poHomeChannel: HomeChannel }[];
	let screenSharingWasEnabled: unknown;

	/**
	 * Tells the fixture app how to answer the next `executePreMediaCallCreated`.
	 *
	 * The outcome is driven by this rather than by the callee's username because a call that fails
	 * because the callee was unreachable looks identical in the UI to one an app blocked - so the
	 * same user pair has to be able to run through both a passing and a prevented call.
	 */
	const setMode = async (api: BaseTest['api'], mode: Mode): Promise<void> => {
		const response = await api.post(`/apps/public/${appId}/mode`, { mode }, '/api');

		await expect(response).toBeOK();
	};

	/** Places a call from user1 to user2 and has user2 answer it. */
	const placeAndAnswerCall = async (): Promise<void> => {
		const [user1, user2] = sessions;

		await user1.poHomeChannel.navbar.openChat('user2');
		await expect(user1.poHomeChannel.composer.inputMessage).toBeVisible();

		await user1.poHomeChannel.content.btnVoiceCall.click();
		await user1.poHomeChannel.voiceCalls.widget.initiateCall();
		await user2.poHomeChannel.voiceCalls.widget.acceptCall();
	};

	test.beforeAll(async ({ api }) => {
		// Set rather than assumed: `screen-share` only reaches the app's feature list while this is
		// on, and other specs turn it off for the length of their own run. The value it had is put
		// back in `afterAll`, so this spec leaves the workspace as it found it.
		screenSharingWasEnabled = await getSettingValueById(api, 'VoIP_TeamCollab_Screen_Sharing_Enabled');
		await setSettingValueById(api, 'VoIP_TeamCollab_Screen_Sharing_Enabled', true);

		const result = await installLocalTestPackage(appMediaCallEventsTest);
		appId = result.app.id;

		await Promise.all([
			api.post('/users.setStatus', { status: 'online', username: 'user1' }),
			api.post('/users.setStatus', { status: 'online', username: 'user2' }),
		]);
	});

	test.beforeAll(async ({ browser }) => {
		sessions = await Promise.all([
			createAuxContext(browser, Users.user1).then(({ page }) => ({ page, poHomeChannel: new HomeChannel(page) })),
			createAuxContext(browser, Users.user2).then(({ page }) => ({ page, poHomeChannel: new HomeChannel(page) })),
		]);
	});

	/**
	 * A test that fails partway through can leave a call up, and a user already in a call cannot
	 * place another one - which would fail every test that follows it for an unrelated reason.
	 * The groups no longer skip each other on failure, so the state has to be cleaned up for real.
	 */
	test.afterEach(async () => {
		for (const { poHomeChannel } of sessions) {
			const { widget } = poHomeChannel.voiceCalls;
			const { controls } = widget;

			for (const button of [controls.hangup, controls.cancel, controls.reject]) {
				if (await button.isVisible()) {
					// The opposite side's widget may be closing at this very moment; cleanup must not
					// turn a passing test into a failing one
					await button.click({ timeout: 5000 }).catch(() => undefined);
					break;
				}
			}

			// A refused call leaves the widget up on the dialer it was opened with, and the next test
			// cannot open a fresh one over it
			if (await widget.content.isVisible()) {
				await widget.btnClose.click({ timeout: 5000 }).catch(() => undefined);
			}
		}
	});

	test.afterAll(async ({ api }) => {
		await Promise.all(sessions.map(({ page }) => page.close()));
		await uninstallApp(appId);
		await setSettingValueById(api, 'VoIP_TeamCollab_Screen_Sharing_Enabled', screenSharingWasEnabled);
	});

	test.describe.serial('pre-create decisions', () => {
		test('should prevent a call when the app returns prevent', async ({ api }) => {
			const [user1, user2] = sessions;

			await setMode(api, 'prevent');

			await user1.poHomeChannel.navbar.openChat('user2');
			await expect(user1.poHomeChannel.composer.inputMessage).toBeVisible();

			await user1.poHomeChannel.content.btnVoiceCall.click();
			await expect(user1.poHomeChannel.voiceCalls.widget.content).toBeVisible();

			// Deliberately not `widget.initiateCall()`: that helper asserts the call starts ringing,
			// which is exactly what must not happen here.
			await user1.poHomeChannel.voiceCalls.widget.controls.call.click();

			await test.step('the caller is told why, in the words of the app that blocked the call', async () => {
				await user1.poHomeChannel.toastMessage.waitForDisplay({ type: 'error', message: 'blocked by media-call-events-test' });
			});

			await test.step('the call never starts and the callee is never rung', async () => {
				// The widget stays up on the dialer it was opened with, so the state to read is the
				// controls: a call that started would offer `Cancel` instead of `Call`.
				await expect(user1.poHomeChannel.voiceCalls.widget.controls.cancel).not.toBeVisible();
				await expect(user1.poHomeChannel.voiceCalls.widget.controls.call).toBeVisible();
				await expect(user2.poHomeChannel.voiceCalls.widget.content).not.toBeVisible();
			});

			await test.step('the callee is told nothing', async () => {
				await expect(user2.poHomeChannel.toastMessage.toast('error')).not.toBeVisible();
			});

			await test.step('the app ran and saw the call it blocked', async () => {
				const { logs } = await getAppLogs(api, appId);

				const preCreated = findAppLogItem(logs, 'executePreMediaCallCreated', ['pre_created_mode', 'prevent']);
				expect(preCreated, 'executePreMediaCallCreated did not run in prevent mode').toBeTruthy();

				expect(entryValue(preCreated, 'pre_created_caller')).toBe('user1');
				expect(entryValue(preCreated, 'pre_created_callee')).toBe('user2');
				expect(entryValue(preCreated, 'pre_created_created_by')).toBe('user1');
				// Two workspace users and no PBX in this workspace, so the call never leaves it
				expect(entryValue(preCreated, 'pre_created_origin')).toBe('internal');
			});

			await test.step('the contact handed to the app carries no session credential', async () => {
				const { logs } = await getAppLogs(api, appId);
				const keys = getAppLogValue(logs, 'executePreMediaCallCreated', 'pre_created_caller_keys')?.split(',');

				expect(keys, 'the app did not report the keys of the contact it received').toBeTruthy();
				// `contractId` is the per-session signing token; the host strips it on the way in.
				expect(keys).not.toContain('contractId');
				expect(keys).toContain('username');
			});
		});

		test('should drop screen-share when the app patches the requested features', async ({ api }) => {
			const [user1, user2] = sessions;

			await setMode(api, 'drop-screen-share');

			const previousStarted = await getNewestAppLog(api, appId, 'executePostMediaCallStarted');

			await placeAndAnswerCall();

			await test.step('the app was offered screen-share before patching it out', async () => {
				const { logs } = await getAppLogs(api, appId);
				const preCreated = findAppLogItem(logs, 'executePreMediaCallCreated', ['pre_created_mode', 'drop-screen-share']);

				expect(preCreated, 'executePreMediaCallCreated did not run in drop-screen-share mode').toBeTruthy();
				expect(entryValue(preCreated, 'pre_created_features')).toContain('screen-share');
			});

			await test.step('neither side can share their screen', async () => {
				await expect(user2.poHomeChannel.voiceCalls.widget.controls.shareScreen).not.toBeVisible();
				await expect(user1.poHomeChannel.voiceCalls.widget.controls.shareScreen).not.toBeVisible();
			});

			await test.step('the caller gets the widget rather than the screen-capable room view', async () => {
				// The view router only routes a peer DM to the room section when the call supports
				// screen-share, so the patch is observable in which view the caller lands on.
				await expect(user1.poHomeChannel.voiceCalls.widget.content).toBeVisible();
				await expect(user1.poHomeChannel.voiceCalls.roomSection.content).not.toBeVisible();
			});

			await test.step('the call the app saw kept the patched feature list', async () => {
				const started = await waitForNewAppLog(api, appId, 'executePostMediaCallStarted', previousStarted?._id);

				expect(entryValue(started, 'post_started_features')).not.toContain('screen-share');
			});

			await user2.poHomeChannel.voiceCalls.widget.hangup();
		});
	});

	test.describe.serial('post events', () => {
		test('should notify the app when a call is answered and when media starts flowing', async ({ api }) => {
			const [, user2] = sessions;

			await setMode(api, 'pass');

			const previousJoined = await getNewestAppLog(api, appId, 'executePostMediaCallParticipantJoined');
			const previousStarted = await getNewestAppLog(api, appId, 'executePostMediaCallStarted');

			await placeAndAnswerCall();

			await test.step('executePostMediaCallParticipantJoined receives the callee', async () => {
				const joined = await waitForNewAppLog(api, appId, 'executePostMediaCallParticipantJoined', previousJoined?._id);

				expect(entryValue(joined, 'post_joined_participant')).toBe('user2');
				expect(entryValue(joined, 'post_joined_accepted_at')).toBeTruthy();
				expect(entryValue(joined, 'post_joined_call')).toBeTruthy();
				expect(entryValue(joined, 'post_joined_participant_keys')?.split(',')).not.toContain('contractId');
			});

			await test.step('executePostMediaCallStarted receives an active call', async () => {
				const started = await waitForNewAppLog(api, appId, 'executePostMediaCallStarted', previousStarted?._id);

				expect(entryValue(started, 'post_started_call')).toBeTruthy();
				expect(entryValue(started, 'post_started_state')).toBe('active');
				expect(entryValue(started, 'post_started_activated_at')).toBeTruthy();
				// The pre context reported the same origin for this pair of users
				expect(entryValue(started, 'post_started_origin')).toBe('internal');
				expect(entryValue(started, 'post_started_features')).toContain('screen-share');
			});

			await user2.poHomeChannel.voiceCalls.widget.hangup();
		});

		test('should notify the app when a call ends, with who ended it and how long it ran', async ({ api }) => {
			const [, user2] = sessions;

			await setMode(api, 'pass');

			const previousEnded = await getNewestAppLog(api, appId, 'executePostMediaCallEnded');
			const previousStarted = await getNewestAppLog(api, appId, 'executePostMediaCallStarted');

			await placeAndAnswerCall();

			// Wait for the call to be active and to have run for a measurable amount of time, so the
			// reported duration is deterministically greater than zero.
			await waitForNewAppLog(api, appId, 'executePostMediaCallStarted', previousStarted?._id);
			await expect.poll(() => user2.poHomeChannel.voiceCalls.widget.getTimerContentInSeconds()).toBeGreaterThanOrEqual(1);

			await user2.poHomeChannel.voiceCalls.widget.hangup();

			const ended = await waitForNewAppLog(api, appId, 'executePostMediaCallEnded', previousEnded?._id);

			expect(entryValue(ended, 'post_ended_call')).toBeTruthy();
			expect(entryValue(ended, 'post_ended_ended')).toBe('true');
			expect(entryValue(ended, 'post_ended_at')).toBeTruthy();
			expect(entryValue(ended, 'post_ended_by_type')).toBe('user');
			expect(Number(entryValue(ended, 'post_ended_duration_ms'))).toBeGreaterThan(0);

			await test.step('the app reads the call as answered', async () => {
				expect(entryValue(ended, 'post_ended_outcome')).toBe('answered');
				// Logged only inside the `isAnsweredCall` branch, so its presence is the guard firing.
				expect(entryValue(ended, 'post_ended_accepted_at')).toBeTruthy();
			});
		});
	});

	/**
	 * There is no event for a call nobody answered - an app has to read the outcome off the
	 * end event. These drive the three outcomes through the real UI, because the thing worth
	 * proving is that a declined call and an unanswered one do not look alike to an app.
	 */
	test.describe.serial('missed and rejected calls', () => {
		test('should read a call the callee declined as rejected, not as missed', async ({ api }) => {
			const [user1, user2] = sessions;

			await setMode(api, 'pass');

			const previousEnded = await getNewestAppLog(api, appId, 'executePostMediaCallEnded');

			await user1.poHomeChannel.navbar.openChat('user2');
			await expect(user1.poHomeChannel.composer.inputMessage).toBeVisible();

			await user1.poHomeChannel.content.btnVoiceCall.click();
			await user1.poHomeChannel.voiceCalls.widget.initiateCall();

			// While ringing, the callee's button reads `Reject` rather than `End call`.
			await expect(user2.poHomeChannel.voiceCalls.widget.controls.reject).toBeVisible();
			await user2.poHomeChannel.voiceCalls.widget.reject();

			const ended = await waitForNewAppLog(api, appId, 'executePostMediaCallEnded', previousEnded?._id);

			expect(entryValue(ended, 'post_ended_outcome')).toBe('rejected');
			expect(entryValue(ended, 'post_ended_reason')).toBe('rejected');
			expect(entryValue(ended, 'post_ended_duration_ms')).toBe('0');
			// The answered branch never ran, so the guard did not narrow the wrong way.
			expect(entryValue(ended, 'post_ended_accepted_at')).toBeUndefined();
		});

		test('should read a call nobody answered as missed', async ({ api }) => {
			const [user1, user2] = sessions;

			await setMode(api, 'pass');

			const previousEnded = await getNewestAppLog(api, appId, 'executePostMediaCallEnded');

			await user1.poHomeChannel.navbar.openChat('user2');
			await expect(user1.poHomeChannel.composer.inputMessage).toBeVisible();

			await user1.poHomeChannel.content.btnVoiceCall.click();
			await user1.poHomeChannel.voiceCalls.widget.initiateCall();

			// The caller gives up while it is still ringing. Waiting out the real ring timeout
			// would take longer than a test should, and the callee misses the call either way.
			await expect(user2.poHomeChannel.voiceCalls.widget.content).toBeVisible();
			await user1.poHomeChannel.voiceCalls.widget.controls.cancel.click();

			const ended = await waitForNewAppLog(api, appId, 'executePostMediaCallEnded', previousEnded?._id);

			expect(entryValue(ended, 'post_ended_outcome')).toBe('missed');
			expect(entryValue(ended, 'post_ended_reason')).not.toBe('rejected');
			expect(entryValue(ended, 'post_ended_duration_ms')).toBe('0');
			expect(entryValue(ended, 'post_ended_accepted_at')).toBeUndefined();
		});

		test('should name every reason it reports, and place every call in one outcome', async ({ api }) => {
			const { logs } = await getAppLogs(api, appId);
			const ended = logs.filter((log) => log.method.includes('executePostMediaCallEnded'));

			expect(ended.length, 'no call ended during this run').toBeGreaterThan(0);

			for (const log of ended) {
				// `unreachable` means the three guards failed to partition an ended call.
				expect(entryValue(log, 'post_ended_outcome')).not.toBe('unreachable');

				// A reason the SDK cannot name means MediaCallHangupReason has drifted from the
				// server. Calls that recorded no reason at all have nothing to check.
				if (entryValue(log, 'post_ended_reason') !== 'none') {
					expect(entryValue(log, 'post_ended_reason_known'), `unnamed reason: ${entryValue(log, 'post_ended_reason')}`).toBe('true');
				}
			}
		});
	});
});
