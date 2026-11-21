/**
 * Embedded WireGuard transport for the direct-PBX media path.
 *
 * Profiles are delivered by the device-authenticated gateway and never contain
 * the device private key.
 */
import { NativeModules, Platform } from 'react-native';

export type VpnProfile = {
  name: string;
  endpoint: string;
  serverPublicKey: string;
  address: string;
  allowedIPs: string[];
  privateSipUrl: string;
  sipDomain: string;
  mtu: number;
  keepaliveSeconds: number;
};

type VpnNative = {
  prepare(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  start(profileJson: string): Promise<boolean>;
  stop(): Promise<boolean>;
  status(): Promise<'UP' | 'DOWN'>;
};

function native(): VpnNative | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.SokratVpn as VpnNative | undefined) ?? null;
}

let started = false;
let activeProfile: VpnProfile | null = null;

export async function getVpnPublicKey(): Promise<string | null> {
  try {
    return (await native()?.getPublicKey()) ?? null;
  } catch {
    return null;
  }
}

export async function stopVpn(): Promise<void> {
  started = false;
  activeProfile = null;
  try {
    await native()?.stop();
  } catch {}
}

export async function ensureVpn(profile: VpnProfile): Promise<boolean> {
  const vpn = native();
  if (!vpn) return false;
  try {
    if (started && activeProfile?.endpoint === profile.endpoint) {
      const state = await vpn.status().catch(() => 'DOWN');
      if (state === 'UP') return true;
    }
    const publicKey = await vpn.getPublicKey();
    if (!publicKey) return false;
    await vpn.prepare();
    await vpn.start(JSON.stringify(profile));
    started = true;
    activeProfile = profile;
    return true;
  } catch {
    started = false;
    activeProfile = null;
    return false;
  }
}

export function activeVpnProfile(): VpnProfile | null {
  return activeProfile;
}
