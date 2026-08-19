import type { MediaCallCreatePatch } from './IPreMediaCallCreatedContext';
import type { PassEventResult, PatchEventResult, PreventEventResult } from '../eventResult';

/**
 * The `EventResult` variants the pre-media-call-create event permits — see the
 * per-event capability matrix in
 * docs/adr/0002-unified-event-result-for-pre-events.md.
 */
export type MediaCallCreateEventResult = PassEventResult | PatchEventResult<MediaCallCreatePatch> | PreventEventResult;
