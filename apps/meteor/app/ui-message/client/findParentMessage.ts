import type { IMessage } from '@rocket.chat/core-typings';

import { mapMessageFromApi } from '../../../client/lib/utils/mapMessageFromApi';
import { Messages } from '../../../client/stores';
import { withDebouncing } from '../../../lib/utils/highOrderFunctions';
import { sdk } from '../../utils/client/lib/SDKClient';

export const findParentMessage = (() => {
	const waiting: string[] = [];
	let resolve: (resolved: IMessage[] | PromiseLike<IMessage[]>) => void;
	let pending = new Promise<IMessage[]>((r) => {
		resolve = r;
	});

	const getMessages = withDebouncing({ wait: 500 })(async () => {
		const messageIds = [...waiting];
		waiting.length = 0;

		resolve(
			messageIds.length
				? sdk.rest.post('/v1/chat.getMessages', { messageIds }).then(({ messages }) => messages.map((msg) => mapMessageFromApi(msg)))
				: [],
		);

		pending = new Promise<IMessage[]>((r) => {
			resolve = r;
		});
	});

	const get = async (tmid: IMessage['_id']) => {
		void getMessages();
		const messages = await pending;
		return messages.find(({ _id }) => _id === tmid);
	};

	return async (tmid: IMessage['_id']) => {
		const message = Messages.state.get(tmid);

		if (message) {
			return message;
		}

		if (waiting.indexOf(tmid) === -1) {
			waiting.push(tmid);
		}
		return get(tmid);
	};
})();
