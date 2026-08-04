import type { IPersistence, IPersistenceRead } from '@rocket.chat/apps-engine/definition/accessors';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';

/**
 * How the app should answer the next `executePreMediaCallCreated`. Tests set this
 * over the `mode` endpoint before driving a call, so a single user pair can be run
 * through every outcome instead of encoding the outcome in the callee's username.
 */
export type Mode = 'pass' | 'prevent' | 'drop-screen-share';

export const MODES: Mode[] = ['pass', 'prevent', 'drop-screen-share'];

const association = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, 'media-call-events-test-mode');

export async function writeMode(persistence: IPersistence, mode: Mode): Promise<void> {
	await persistence.updateByAssociation(association, { mode }, true);
}

export async function readMode(persistenceRead: IPersistenceRead): Promise<Mode> {
	const [record] = (await persistenceRead.readByAssociation(association)) as { mode?: Mode }[];

	return record?.mode ?? 'pass';
}
