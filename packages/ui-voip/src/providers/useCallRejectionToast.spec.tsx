import { Emitter } from '@rocket.chat/emitter';
import type { MediaSignalingSession } from '@rocket.chat/media-signaling';
import { mockAppRoot } from '@rocket.chat/mock-providers';
import { act, renderHook } from '@testing-library/react';

import { useCallRejectionToast } from './useCallRejectionToast';

type RejectedCall = { callId: string; reason: string; message?: unknown };

const dispatchToastMessage = jest.fn();

const createWrapper = () =>
	mockAppRoot()
		.withTranslations('en', 'core', {
			Call_rejected: 'Your call could not be completed',
			Call_rejected_forbidden: 'You are not allowed to make this call',
			Call_rejected_busy: 'You are already on another call',
		})
		.withTranslations('en', 'app-blocking-app', {
			callee_is_dnd: '{{username}} is not taking calls right now',
		})
		.withToastMessageDispatch(dispatchToastMessage)
		.build();

const setupRejectionToast = () => {
	const emitter = new Emitter<{ rejectedCall: RejectedCall }>();
	const instance = emitter as unknown as MediaSignalingSession;

	renderHook(() => useCallRejectionToast(instance), { wrapper: createWrapper() });

	return (rejection: Omit<RejectedCall, 'callId'>) => act(() => emitter.emit('rejectedCall', { callId: 'call-id', ...rejection }));
};

describe('useCallRejectionToast', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('explains the reason the call was rejected', () => {
		const reject = setupRejectionToast();

		reject({ reason: 'forbidden' });

		expect(dispatchToastMessage).toHaveBeenCalledWith({ type: 'error', message: 'You are not allowed to make this call' });
	});

	it('prefers the message the rejection came with over the reason', () => {
		const reject = setupRejectionToast();

		reject({ reason: 'forbidden', message: { type: 'text', text: 'blocked by the on-call policy' } });

		expect(dispatchToastMessage).toHaveBeenCalledWith({ type: 'error', message: 'blocked by the on-call policy' });
	});

	it('resolves an i18n message against the namespace of the app that produced it', () => {
		const reject = setupRejectionToast();

		reject({
			reason: 'forbidden',
			message: { type: 'i18n', key: 'callee_is_dnd', ns: 'app-blocking-app', args: { username: 'callee' } },
		});

		expect(dispatchToastMessage).toHaveBeenCalledWith({ type: 'error', message: 'callee is not taking calls right now' });
	});

	it('falls back to the reason when the app never shipped the translation it named', () => {
		const reject = setupRejectionToast();

		reject({ reason: 'busy', message: { type: 'i18n', key: 'no_such_key', ns: 'app-blocking-app' } });

		// Never the raw key
		expect(dispatchToastMessage).toHaveBeenCalledWith({ type: 'error', message: 'You are already on another call' });
	});

	it('falls back to the generic message when there is no text for the reason either', () => {
		const reject = setupRejectionToast();

		reject({ reason: 'already-requested', message: { type: 'i18n', key: 'no_such_key', ns: 'app-blocking-app' } });

		expect(dispatchToastMessage).toHaveBeenCalledWith({ type: 'error', message: 'Your call could not be completed' });
	});

	it('stays silent about a rejection the user can do nothing with', () => {
		const reject = setupRejectionToast();

		reject({ reason: 'already-requested' });

		expect(dispatchToastMessage).not.toHaveBeenCalled();
	});
});
