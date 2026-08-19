import { EVENT_RESULT_KIND } from './EventResult';
import type { MarkedEventResult } from './EventResult';

/**
 * Runtime guard for the `EventResult` marker. Must run *before* any legacy
 * `typeof result === 'object'` / truthiness branch at a consumption site
 */
export function isEventResult(value: unknown): value is MarkedEventResult {
	return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['@kind'] === EVENT_RESULT_KIND;
}
