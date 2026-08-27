import { buildRateLimiterInput, buildRateLimiterRule } from './rateLimiterKey';

const ROUTE = '/v1/chat.sendMessagepost';

const bucketOf = (rule: Record<string, unknown>) => Object.keys(rule).sort();

describe('buildRateLimiterRule', () => {
	it('should bucket by address by default', () => {
		expect(bucketOf(buildRateLimiterRule(ROUTE))).toEqual(['IPAddr', 'route']);
	});

	it("should bucket by address when per is 'ip'", () => {
		expect(bucketOf(buildRateLimiterRule(ROUTE, 'ip'))).toEqual(['IPAddr', 'route']);
	});

	it("should bucket by user when per is 'user'", () => {
		expect(bucketOf(buildRateLimiterRule(ROUTE, 'user'))).toEqual(['route', 'userId']);
	});

	it('should carry the route so each endpoint counts separately', () => {
		expect(buildRateLimiterRule(ROUTE, 'user')).toMatchObject({ route: ROUTE });
		expect(buildRateLimiterRule(ROUTE, 'ip')).toMatchObject({ route: ROUTE });
	});

	it('should match a subject by returning it, so the package treats the rule as applicable', () => {
		const rule = buildRateLimiterRule(ROUTE, 'user') as { userId: (input: string) => unknown };

		expect(rule.userId('alice')).toBe('alice');
	});
});

describe('buildRateLimiterInput', () => {
	it('should carry both subjects so either rule shape matches it', () => {
		expect(buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4', userId: 'alice' })).toEqual({
			IPAddr: '1.2.3.4',
			userId: 'alice',
			route: ROUTE,
		});
	});

	it('should fall back to the address as the user subject when unauthenticated', () => {
		expect(buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4' })).toEqual({
			IPAddr: '1.2.3.4',
			userId: 'ip:1.2.3.4',
			route: ROUTE,
		});
	});

	it('should never produce a falsy subject', () => {
		const anonymous = buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4', userId: '' });

		expect(anonymous.userId).toBe('ip:1.2.3.4');
		expect(anonymous.IPAddr).toBe('1.2.3.4');
	});

	it('should keep unauthenticated subjects apart per address', () => {
		const first = buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4' });
		const second = buildRateLimiterInput({ route: ROUTE, IPAddr: '5.6.7.8' });

		expect(first.userId).not.toBe(second.userId);
	});

	it('should keep the user subject stable across addresses', () => {
		const home = buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4', userId: 'alice' });
		const office = buildRateLimiterInput({ route: ROUTE, IPAddr: '5.6.7.8', userId: 'alice' });

		expect(home.userId).toBe(office.userId);
	});

	it('should keep users on a shared address apart', () => {
		const alice = buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4', userId: 'alice' });
		const bob = buildRateLimiterInput({ route: ROUTE, IPAddr: '1.2.3.4', userId: 'bob' });

		expect(alice.userId).not.toBe(bob.userId);
		expect(alice.IPAddr).toBe(bob.IPAddr);
	});
});
