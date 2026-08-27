// TODO: this suite cannot run on CI. `TEST_MODE` makes `shouldAddRateLimitToRoute` skip rule
// registration at boot, so no route is ever rate limited during a test run and there is no setting
// that brings it back — `API_Enable_Rate_Limiter` and `_Dev` gate enforcement, not registration.
// It therefore self-skips below, and only runs against a server started without `TEST_MODE`.
// We still need to decide how to exercise it on CI: relax that guard, narrow it (by `TEST_MODE`
// value or an opt-in), or expose a registration path meant for tests.

import type { Credentials } from '@rocket.chat/api-client';
import type { ISetting, IUser } from '@rocket.chat/core-typings';
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { api, credentials, getCredentials, request } from '../../data/api-data';
import { getSettingValueById, updateSetting } from '../../data/permissions.helper';
import type { TestUser } from '../../data/users.helper';
import { createUser, deleteUser, login } from '../../data/users.helper';

const PASSWORD = 'rate-limiter-spec';

// Enforcement is off for the whole run: the suite calls endpoints far above their allowance, and
// this is the only spec that wants the limiter awake.
let rateLimiterWasEnabled: ISetting['value'];

before(async () => {
	await new Promise<void>((resolve, reject) => getCredentials((err?: Error) => (err ? reject(err) : resolve())));
	rateLimiterWasEnabled = await getSettingValueById('API_Enable_Rate_Limiter');
	await updateSetting('API_Enable_Rate_Limiter', false);
});

after(async () => {
	await updateSetting('API_Enable_Rate_Limiter', rateLimiterWasEnabled);
});

describe('[Rate Limiter]', () => {
	let alice: TestUser<IUser>;
	let bob: TestUser<IUser>;
	let aliceCredentials: Credentials;
	let bobCredentials: Credentials;

	before(async function () {
		[alice, bob] = await Promise.all([
			createUser({ password: PASSWORD } as Partial<IUser>),
			createUser({ password: PASSWORD } as Partial<IUser>),
		]);
		[aliceCredentials, bobCredentials] = await Promise.all([login(alice.username, PASSWORD), login(bob.username, PASSWORD)]);

		await updateSetting('API_Enable_Rate_Limiter', true);

		const probe = await request.get(api('roles.list')).set(aliceCredentials);
		if (!probe.headers['x-ratelimit-limit']) {
			this.skip();
		}
	});

	after(async () => {
		await updateSetting('API_Enable_Rate_Limiter', false);
		await Promise.all([deleteUser(alice), deleteUser(bob)]);
	});

	// Both users share the runner's address, which is what makes the two suites below differ.
	describe('per user', () => {
		const send = (who: Credentials, msg: string) =>
			request
				.post(api('chat.sendMessage'))
				.set(who)
				.send({ message: { rid: 'GENERAL', msg } });

		it('should reject a user past the endpoint allowance', async () => {
			const statuses = await Promise.all([...Array(12)].map((_, i) => send(aliceCredentials, `burst ${i}`).then((res) => res.status)));

			expect(statuses).to.include(200);
			expect(statuses).to.include(429);
		});

		it('should leave another user on the same address with a full allowance', async () => {
			const res = await send(bobCredentials, 'bob');

			expect(res.status).to.equal(200);
			expect(res.headers['x-ratelimit-remaining']).to.equal('4');
		});
	});

	describe('per address', () => {
		const list = (who: Credentials) => request.get(api('roles.list')).set(who);

		it('should reject a user past the default allowance', async () => {
			const statuses = await Promise.all([...Array(12)].map(() => list(aliceCredentials).then((res) => res.status)));

			expect(statuses).to.include(200);
			expect(statuses).to.include(429);
		});

		it('should reject another user on the same address as well', async () => {
			const res = await list(bobCredentials);

			expect(res.status).to.equal(429);
		});
	});

	describe('bypass', () => {
		it('should not limit a user holding api-bypass-rate-limit', async () => {
			const statuses = await Promise.all(
				[...Array(12)].map(() =>
					request
						.get(api('roles.list'))
						.set(credentials)
						.then((res) => res.status),
				),
			);

			expect(statuses).to.deep.equal(Array(12).fill(200));
		});
	});
});
