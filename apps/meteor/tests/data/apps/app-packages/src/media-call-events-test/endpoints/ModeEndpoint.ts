import type { IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { HttpStatusCode } from '@rocket.chat/apps-engine/definition/accessors';
import type { IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { ApiEndpoint } from '@rocket.chat/apps-engine/definition/api';

import type { Mode } from '../lib/mode';
import { MODES, readMode, writeMode } from '../lib/mode';

/** `POST /api/apps/public/:appId/mode` with `{ "mode": "pass" | "prevent" | "drop-screen-share" }`. */
export class ModeEndpoint extends ApiEndpoint {
	public override path = 'mode';

	public async post(
		request: IApiRequest,
		_endpoint: IApiEndpointInfo,
		_read: IRead,
		_modify: IModify,
		_http: IHttp,
		persistence: IPersistence,
	): Promise<IApiResponse> {
		const { mode } = (request.content || {}) as { mode?: Mode };

		if (!mode || !MODES.includes(mode)) {
			return {
				status: HttpStatusCode.BAD_REQUEST,
				content: { error: `mode must be one of ${MODES.join(', ')}` },
			};
		}

		await writeMode(persistence, mode);

		return { status: HttpStatusCode.OK, content: { mode } };
	}

	public async get(_request: IApiRequest, _endpoint: IApiEndpointInfo, read: IRead): Promise<IApiResponse> {
		return { status: HttpStatusCode.OK, content: { mode: await readMode(read.getPersistenceReader()) } };
	}
}
