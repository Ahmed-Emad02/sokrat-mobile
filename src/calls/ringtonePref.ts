/**
 * Incoming-call ringtone preference.
 *
 * `device` plays the phone's own ringtone (the default), `custom` plays an
 * audio file the user picked from the phone. Kept dependency-free so storage,
 * the call layer and the UI can share it without loading native modules.
 */
export type IncomingRingtone = 'device' | 'custom';

export const DEFAULT_INCOMING_RINGTONE: IncomingRingtone = 'device';

export function normalizeIncomingRingtone(value: unknown): IncomingRingtone {
  return value === 'custom' ? 'custom' : DEFAULT_INCOMING_RINGTONE;
}
