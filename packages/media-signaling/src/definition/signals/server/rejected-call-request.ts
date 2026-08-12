import type { CallRejectedReason, CallRejectionMessage } from '../../call';

export type ServerMediaSignalRejectedCallRequest = {
	callId: string;
	type: 'rejected-call-request';
	toContractId: string;
	reason: CallRejectedReason;
	/**
	 * Present when the rejection came with an explanation meant for the user -
	 * today, from an app that blocked the call. Clients that can't display it
	 * still have `reason` to act on.
	 */
	message?: CallRejectionMessage;
};
