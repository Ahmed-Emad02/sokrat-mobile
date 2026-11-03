/**
 * Sokrat Mobile Local Storage Service
 * Persists user account, server configuration, call history, and contacts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type CodecPreference = 'auto' | 'opus' | 'g722' | 'pcmu' | 'pcma';

export interface SavedAccount {
  extension: string;
  password: string;
  serverHost: string;
  /** Optional LAN/Local gateway origin for automatic fallback. */
  fallbackHost?: string;
  useTls: boolean;
  dnd: boolean;
  autoAnswer: boolean;
  preferredCodec?: CodecPreference;
  micVolume?: number;
  speakerVolume?: number;
}

export interface CallRecord {
  id: string;
  callId?: string;
  number: string;
  name: string;
  direction: 'inbound' | 'outbound' | 'missed';
  timestamp: number;
  duration?: number;
}

export interface Contact {
  id: string;
  name: string;
  extension: string;
  favorite?: boolean;
}

export type SpeedDialMap = Record<string, string>;

export interface WhatsAppPrefs {
  countryCode: string;
  promptEnabled: boolean;
}

export const DEFAULT_WHATSAPP_PREFS: WhatsAppPrefs = {
  countryCode: '',
  promptEnabled: true,
};

export const DEFAULT_SPEED_DIAL: SpeedDialMap = {
  '1': '*97',
};

const KEYS = {
  ACCOUNT: '@sokrat_account',
  ACCOUNT_BACKUP: '@sokrat_account_backup',
  LAST_LOGIN: '@sokrat_last_login',
  CALLS: '@sokrat_calls_history',
  CALLS_BACKUP: '@sokrat_calls_history_backup',
  CONTACTS: '@sokrat_contacts',
  SPEED_DIAL: '@sokrat_speed_dial',
  WHATSAPP: '@sokrat_whatsapp_prefs',
};
const MAX_CALL_HISTORY = 1000;

function parseCallHistory(raw: string | null): CallRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CallRecord =>
      !!item && typeof item === 'object' &&
      typeof (item as CallRecord).id === 'string' &&
      typeof (item as CallRecord).timestamp === 'number');
  } catch {
    return [];
  }
}

async function persistCallHistory(records: CallRecord[]): Promise<void> {
  const payload = JSON.stringify(records.slice(0, MAX_CALL_HISTORY));
  await Promise.all([
    AsyncStorage.setItem(KEYS.CALLS, payload),
    AsyncStorage.setItem(KEYS.CALLS_BACKUP, payload),
  ]);
}

// Serialize read-modify-write mutations. Two calls ending together otherwise
// both read the same list and the second write silently drops the first call.
let callHistoryMutation: Promise<unknown> = Promise.resolve();
function mutateCallHistory<T>(mutation: () => Promise<T>): Promise<T> {
  const run = callHistoryMutation.then(mutation, mutation);
  callHistoryMutation = run.catch(() => undefined);
  return run;
}

export const StorageService = {
  async getAccount(): Promise<SavedAccount | null> {
    let readError: unknown = null;
    for (const key of [KEYS.ACCOUNT, KEYS.ACCOUNT_BACKUP]) {
      try {
        const data = await AsyncStorage.getItem(key);
        if (!data) continue;
        const parsed = JSON.parse(data) as SavedAccount;
        if (parsed && parsed.serverHost) {
          // Repair the primary copy when only the backup survived.
          if (key === KEYS.ACCOUNT_BACKUP) {
            void AsyncStorage.setItem(KEYS.ACCOUNT, data);
          }
          return parsed;
        }
      } catch (error) {
        readError = error;
      }
    }
    // A missing key is a legitimate first-run state. A read/JSON failure is
    // not: surface it instead of pretending the user logged out.
    if (readError) throw readError;
    return null;
  },

  async getLastLogin(): Promise<SavedAccount | null> {
    try {
      const data = await AsyncStorage.getItem(KEYS.LAST_LOGIN);
      if (!data) return null;
      const parsed = JSON.parse(data) as SavedAccount;
      return parsed && parsed.serverHost ? parsed : null;
    } catch {
      return null;
    }
  },

  async saveLastLogin(account: SavedAccount): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.LAST_LOGIN, JSON.stringify(account));
    } catch {}
  },

  async saveAccount(account: SavedAccount): Promise<void> {
    const payload = JSON.stringify(account);
    try {
      await AsyncStorage.setItem(KEYS.ACCOUNT, payload);
      await AsyncStorage.setItem(KEYS.ACCOUNT_BACKUP, payload);
    } catch (err) {
      console.warn('[storage] saveAccount failed:', err);
    }
  },

  async clearAccount(): Promise<void> {
    try {
      await Promise.all([
        AsyncStorage.removeItem(KEYS.ACCOUNT),
        AsyncStorage.removeItem(KEYS.ACCOUNT_BACKUP),
      ]);
    } catch {}
  },

  async getCallHistory(): Promise<CallRecord[]> {
    try {
      const [primaryRaw, backupRaw] = await Promise.all([
        AsyncStorage.getItem(KEYS.CALLS),
        AsyncStorage.getItem(KEYS.CALLS_BACKUP),
      ]);
      const primary = parseCallHistory(primaryRaw);
      const backup = parseCallHistory(backupRaw);
      const merged: CallRecord[] = [];
      const seen = new Set<string>();
      for (const record of [...primary, ...backup]) {
        if (!record?.id || seen.has(record.id)) continue;
        seen.add(record.id);
        merged.push(record);
      }
      merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const bounded = merged.slice(0, MAX_CALL_HISTORY);
      // Restore the primary copy if an interrupted write or a build change
      // left only the backup behind.
      if (!primaryRaw && bounded.length) {
        await AsyncStorage.setItem(KEYS.CALLS, JSON.stringify(bounded));
      }
      return bounded;
    } catch {
      return [];
    }
  },

  async addCallRecord(record: Omit<CallRecord, 'id'>): Promise<CallRecord[]> {
    return mutateCallHistory(async () => {
      const current = await this.getCallHistory();
      // CDR reconciliation can see a call that the live SIP path already
      // recorded. The PBX uniqueid is the stable identity for that case.
      if (record.callId && current.some((item) => item.callId === record.callId)) {
        return current;
      }
      const newRecord: CallRecord = {
        ...record,
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      };
      const updated = [newRecord, ...current].slice(0, MAX_CALL_HISTORY);
      await persistCallHistory(updated);
      return updated;
    });
  },

  async updateCallRecordName(callId: string, name: string): Promise<CallRecord[]> {
    return mutateCallHistory(async () => {
      const current = await this.getCallHistory();
      let changed = false;
      const updated = current.map((record) => {
        if (record.callId !== callId || record.name === name) return record;
        changed = true;
        return { ...record, name };
      });
      if (changed) await persistCallHistory(updated);
      return updated;
    });
  },

  async clearCallHistory(): Promise<void> {
    await mutateCallHistory(async () => {
      await Promise.all([
        AsyncStorage.removeItem(KEYS.CALLS),
        AsyncStorage.removeItem(KEYS.CALLS_BACKUP),
      ]);
    });
  },

  async deleteCallRecord(id: string): Promise<CallRecord[]> {
    return mutateCallHistory(async () => {
      const current = await this.getCallHistory();
      const updated = current.filter((c) => c.id !== id);
      await persistCallHistory(updated);
      return updated;
    });
  },

  async getContacts(): Promise<Contact[]> {
    try {
      const data = await AsyncStorage.getItem(KEYS.CONTACTS);
      if (data) return JSON.parse(data);
      // Default sample contacts on fresh install
      const initial: Contact[] = [
        { id: 'c1', name: 'Support / Helpdesk', extension: '101', favorite: true },
        { id: 'c2', name: 'Sales Line', extension: '102', favorite: true },
        { id: 'c3', name: 'Echo Audio Test', extension: '*88', favorite: false },
      ];
      await AsyncStorage.setItem(KEYS.CONTACTS, JSON.stringify(initial));
      return initial;
    } catch {
      return [];
    }
  },

  async saveContacts(contacts: Contact[]): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.CONTACTS, JSON.stringify(contacts));
    } catch (err) {
      console.warn('[storage] saveContacts failed:', err);
    }
  },

  async getSpeedDial(): Promise<SpeedDialMap> {
    try {
      const data = await AsyncStorage.getItem(KEYS.SPEED_DIAL);
      return data ? { ...DEFAULT_SPEED_DIAL, ...JSON.parse(data) } : { ...DEFAULT_SPEED_DIAL };
    } catch {
      return { ...DEFAULT_SPEED_DIAL };
    }
  },

  async saveSpeedDial(speedDial: SpeedDialMap): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.SPEED_DIAL, JSON.stringify(speedDial));
    } catch (err) {
      console.warn('[storage] saveSpeedDial failed:', err);
    }
  },

  async getWhatsAppPrefs(): Promise<WhatsAppPrefs> {
    try {
      const data = await AsyncStorage.getItem(KEYS.WHATSAPP);
      if (!data) return { ...DEFAULT_WHATSAPP_PREFS };
      const parsed = JSON.parse(data) as Partial<WhatsAppPrefs>;
      return {
        countryCode: typeof parsed.countryCode === 'string' ? parsed.countryCode : '',
        promptEnabled: parsed.promptEnabled !== false,
      };
    } catch {
      return { ...DEFAULT_WHATSAPP_PREFS };
    }
  },

  async saveWhatsAppPrefs(prefs: WhatsAppPrefs): Promise<void> {
    try {
      await AsyncStorage.setItem(
        KEYS.WHATSAPP,
        JSON.stringify({
          countryCode: prefs.countryCode.trim(),
          promptEnabled: prefs.promptEnabled !== false,
        }),
      );
    } catch (err) {
      console.warn('[storage] saveWhatsAppPrefs failed:', err);
    }
  },
};
