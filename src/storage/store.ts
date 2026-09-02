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
  useTls: boolean;
  dnd: boolean;
  autoAnswer: boolean;
  preferredCodec?: CodecPreference;
  micVolume?: number;
  speakerVolume?: number;
}

export interface CallRecord {
  id: string;
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

export const DEFAULT_SPEED_DIAL: SpeedDialMap = {
  '1': '*97',
};

const KEYS = {
  ACCOUNT: '@sokrat_account',
  CALLS: '@sokrat_calls_history',
  CONTACTS: '@sokrat_contacts',
  SPEED_DIAL: '@sokrat_speed_dial',
};
export const StorageService = {
  async getAccount(): Promise<SavedAccount | null> {
    try {
      const data = await AsyncStorage.getItem(KEYS.ACCOUNT);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  async saveAccount(account: SavedAccount): Promise<void> {
    try {
      await AsyncStorage.setItem(KEYS.ACCOUNT, JSON.stringify(account));
    } catch (err) {
      console.warn('[storage] saveAccount failed:', err);
    }
  },

  async clearAccount(): Promise<void> {
    try {
      await AsyncStorage.removeItem(KEYS.ACCOUNT);
    } catch {}
  },

  async getCallHistory(): Promise<CallRecord[]> {
    try {
      const data = await AsyncStorage.getItem(KEYS.CALLS);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  async addCallRecord(record: Omit<CallRecord, 'id'>): Promise<CallRecord[]> {
    try {
      const current = await this.getCallHistory();
      const newRecord: CallRecord = {
        ...record,
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      };
      const updated = [newRecord, ...current].slice(0, 100);
      await AsyncStorage.setItem(KEYS.CALLS, JSON.stringify(updated));
      return updated;
    } catch (err) {
      console.warn('[storage] addCallRecord failed:', err);
      return [];
    }
  },

  async clearCallHistory(): Promise<void> {
    try {
      await AsyncStorage.removeItem(KEYS.CALLS);
    } catch {}
  },
  async deleteCallRecord(id: string): Promise<CallRecord[]> {
    try {
      const current = await this.getCallHistory();
      const updated = current.filter((c) => c.id !== id);
      await AsyncStorage.setItem(KEYS.CALLS, JSON.stringify(updated));
      return updated;
    } catch (err) {
      console.warn('[storage] deleteCallRecord failed:', err);
      return [];
    }
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
};
