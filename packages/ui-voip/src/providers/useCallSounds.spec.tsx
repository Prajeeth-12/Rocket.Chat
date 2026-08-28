import { renderHook } from '@testing-library/react';

import { useCallSounds } from './useCallSounds';

const mockPlayCallEnded = jest.fn();
const mockPlayDialer = jest.fn();
const mockPlayRinger = jest.fn();

jest.mock('@rocket.chat/ui-contexts', () => ({
	...jest.requireActual('@rocket.chat/ui-contexts'),
	useCustomSound: () => ({
		voipSounds: {
			playCallEnded: mockPlayCallEnded,
			playDialer: mockPlayDialer,
			playRinger: mockPlayRinger,
		},
	}),
}));

beforeEach(() => {
	jest.clearAllMocks();
});

describe('useCallSounds', () => {
	it('plays the end-of-call sound when the call ends, as it does after an app prevents it', () => {
		// An app prevention reaches the caller as an ordinary rejection, which ends the call and fires 'endedCall'.
		let fireCallEnded: () => void = () => undefined;
		const subscribeCallEnded = (callback: () => void) => {
			fireCallEnded = callback;
			return () => undefined;
		};

		renderHook(() => useCallSounds('none', subscribeCallEnded));
		expect(mockPlayCallEnded).not.toHaveBeenCalled();

		fireCallEnded();
		expect(mockPlayCallEnded).toHaveBeenCalledTimes(1);
	});

	it('plays the dialer while calling and the ringer while ringing', () => {
		const { rerender } = renderHook(({ state }) => useCallSounds(state, () => () => undefined), {
			initialProps: { state: 'calling' as const },
		});
		expect(mockPlayDialer).toHaveBeenCalledTimes(1);
		expect(mockPlayRinger).not.toHaveBeenCalled();

		rerender({ state: 'ringing' as const });
		expect(mockPlayRinger).toHaveBeenCalledTimes(1);
	});
});
