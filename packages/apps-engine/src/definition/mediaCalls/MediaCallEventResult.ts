import type { MediaCallCreatePatch } from './IPreMediaCallCreatedContext';
import type { PassEventResult, PatchEventResult, PreventEventResult } from '../eventResult';

/**
 * Restricted `EventResult` union for the pre-media-call-create event.
 * `prompt` is not yet permitted here — see the per-event capability matrix in
 * docs/proposals/apps-engine-event-result-return-type.md.
 */
export type MediaCallCreateEventResult = PassEventResult | PatchEventResult<MediaCallCreatePatch> | PreventEventResult;
