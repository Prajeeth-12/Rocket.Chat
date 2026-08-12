import { ClientMediaCall } from './Call';
import type { IClientMediaCallConfig } from './Call';
import type { MediaSignalTransportWrapper } from './TransportWrapper';
import type { ServerMediaSignalRejectedCallRequest } from '../definition/signals/server';

const SESSION_ID = 'session-id';

const makeTransporter = () =>
	({
		sendToServer: jest.fn(),
		hangup: jest.fn(),
		answer: jest.fn(),
		sendError: jest.fn(),
		requestRenegotiation: jest.fn(),
	}) as unknown as MediaSignalTransportWrapper;

const makeCall = (callId: string) => {
	const config: IClientMediaCallConfig = {
		userId: 'caller-id',
		sessionId: SESSION_ID,
		transporter: makeTransporter(),
		processorFactories: {},
		iceGatheringTimeout: 5000,
		iceServers: [],
		supportedFeatures: ['audio'],
	};

	return new ClientMediaCall(config, callId);
};

const rejection = (overrides: Partial<ServerMediaSignalRejectedCallRequest> = {}): ServerMediaSignalRejectedCallRequest => ({
	type: 'rejected-call-request',
	callId: 'call-id',
	toContractId: SESSION_ID,
	reason: 'forbidden',
	...overrides,
});

describe('ClientMediaCall', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('rejected-call-request', () => {
		it('reports the rejection to the session that asked for the call', async () => {
			const call = makeCall('call-id');
			await call.initializeOutboundCall({ type: 'user', id: 'callee-id' });

			const onRejected = jest.fn();
			call.emitter.on('rejected', onRejected);

			await call.processSignal(rejection({ reason: 'busy' }));

			expect(onRejected).toHaveBeenCalledTimes(1);
			expect(onRejected).toHaveBeenCalledWith({ reason: 'busy' });
		});

		it('passes along the message the rejection came with', async () => {
			const call = makeCall('call-id');
			await call.initializeOutboundCall({ type: 'user', id: 'callee-id' });

			const onRejected = jest.fn();
			call.emitter.on('rejected', onRejected);

			const message = { type: 'i18n' as const, key: 'callee_is_dnd', ns: 'app-blocking-app', args: { username: 'callee' } };
			await call.processSignal(rejection({ message }));

			expect(onRejected).toHaveBeenCalledWith({ reason: 'forbidden', message });
		});

		it('ends the call', async () => {
			const call = makeCall('call-id');
			await call.initializeOutboundCall({ type: 'user', id: 'callee-id' });

			await call.processSignal(rejection());

			expect(call.state).toBe('hangup');
			expect(call.isOver()).toBe(true);
		});

		it('stays quiet on a session that did not ask for the call', async () => {
			// A call this session knows nothing about: the same signal reaches every
			// session the user has open, and only the one that placed the call is
			// supposed to hear about it
			const call = makeCall('call-id');

			const onRejected = jest.fn();
			call.emitter.on('rejected', onRejected);

			await call.processSignal(rejection());

			expect(call.hidden).toBe(true);
			expect(onRejected).not.toHaveBeenCalled();
			expect(call.state).toBe('hangup');
		});

		it('stays quiet on a session whose contract was not the one addressed', async () => {
			const call = makeCall('call-id');
			await call.initializeOutboundCall({ type: 'user', id: 'callee-id' });
			call.setContractState('ignored');

			const onRejected = jest.fn();
			call.emitter.on('rejected', onRejected);

			await call.processSignal(rejection({ toContractId: 'some-other-session' }));

			expect(onRejected).not.toHaveBeenCalled();
			expect(call.state).toBe('hangup');
		});
	});
});
