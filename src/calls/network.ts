import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';

const CallNotificationNative = NativeModules.CallNotificationModule;

export type NetworkType =
  | 'WIFI'
  | 'CELLULAR'
  | 'ETHERNET'
  | 'BLUETOOTH'
  | 'VPN'
  | 'OTHER'
  | 'NONE'
  | 'UNKNOWN';

export interface NetworkState {
  isConnected: boolean;
  networkType: NetworkType;
}

let cachedNetworkState: NetworkState = {
  isConnected: true,
  networkType: 'UNKNOWN',
};

export async function getNetworkState(): Promise<NetworkState> {
  if (Platform.OS === 'android' && CallNotificationNative?.getNetworkState) {
    try {
      const raw = await CallNotificationNative.getNetworkState();
      if (raw && typeof raw === 'object') {
        const isConnected = 'isConnected' in raw && typeof raw.isConnected === 'boolean' ? raw.isConnected : true;
        const networkType = 'networkType' in raw && typeof raw.networkType === 'string' ? (raw.networkType as NetworkType) : 'UNKNOWN';
        cachedNetworkState = { isConnected, networkType };
      }
    } catch {}
  }
  return cachedNetworkState;
}

export function subscribeNetworkChanges(listener: (state: NetworkState) => void): () => void {
  void getNetworkState().then((s) => listener(s));

  const sub = DeviceEventEmitter.addListener('onNetworkStateChanged', (data: unknown) => {
    if (data && typeof data === 'object') {
      const isConnected = 'isConnected' in data && typeof data.isConnected === 'boolean'
        ? data.isConnected
        : false;
      const networkType = 'networkType' in data && typeof data.networkType === 'string'
        ? (data.networkType as NetworkType)
        : 'UNKNOWN';
      const nextState: NetworkState = { isConnected, networkType };
      cachedNetworkState = nextState;
      listener(nextState);
    }
  });

  return () => sub.remove();
}
