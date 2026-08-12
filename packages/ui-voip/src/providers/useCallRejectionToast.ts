import type { CallRejectedReason, CallRejectionMessage, MediaSignalingSession } from '@rocket.chat/media-signaling';
import type { TranslationKey } from '@rocket.chat/ui-contexts';
import { useToastMessageDispatch } from '@rocket.chat/ui-contexts';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The reasons worth interrupting the caller about, and what to tell them.
 *
 * The ones left out - `invalid-call-id`, `invalid-contract-id`,
 * `existing-call-id` and `already-requested` - are the server turning down a
 * request a client should not have made in the first place. Nothing the user did
 * caused them and nothing they can do fixes them, so they stay silent unless the
 * rejection came with a message of its own.
 */
const rejectionMessageKeys: Partial<Record<CallRejectedReason, TranslationKey>> = {
	'forbidden': 'Call_rejected_forbidden',
	'busy': 'Call_rejected_busy',
	'unavailable': 'Call_rejected_unavailable',
	'unsupported': 'Call_rejected_unsupported',
	'invalid-call-params': 'Call_rejected_invalid_call_params',
};

/**
 * Tells the caller why the call they just placed is not happening.
 *
 * Without this the only feedback is the widget appearing and vanishing again,
 * which reads as a glitch rather than as an answer - especially when an app
 * blocked the call on purpose and has something to say about it.
 */
export const useCallRejectionToast = (instance?: MediaSignalingSession) => {
	const { t, i18n } = useTranslation();
	const dispatchToastMessage = useToastMessageDispatch();

	useEffect(() => {
		if (!instance) {
			return;
		}

		/**
		 * An explicit message wins over the reason code, but only once we know we can
		 * actually render it: an app naming a key it never shipped a translation for
		 * would otherwise put the raw key in front of the user.
		 */
		const resolveMessage = (reason: CallRejectedReason, message?: CallRejectionMessage): string | undefined => {
			if (message?.type === 'text' && message.text) {
				return message.text;
			}

			if (message?.type === 'i18n' && i18n.exists(message.key, { ns: message.ns })) {
				return i18n.t(message.key, { ns: message.ns, ...message.args });
			}

			const reasonKey = rejectionMessageKeys[reason];

			// A rejection that carries a message is always worth reporting, even if we
			// ended up with nothing better than the generic text to report it with
			if (!reasonKey) {
				return message ? t('Call_rejected') : undefined;
			}

			return t(reasonKey);
		};

		return instance.on('rejectedCall', ({ reason, message }) => {
			const text = resolveMessage(reason, message);

			if (!text) {
				return;
			}

			dispatchToastMessage({ type: 'error', message: text });
		});
	}, [instance, dispatchToastMessage, t, i18n]);
};
