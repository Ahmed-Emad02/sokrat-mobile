import { getPushGateway, getSipWss } from '../src/config';

describe('signalling endpoint policy', () => {
  test('uses plain ws on 8088 by default and wss on 8089 with TLS', () => {
    expect(getSipWss('pbx.example.com')).toBe('ws://pbx.example.com:8088/ws');
    expect(getSipWss('pbx.example.com', true)).toBe('wss://pbx.example.com:8089/ws');
    expect(getSipWss('100.98.185.86')).toBe('ws://100.98.185.86:8088/ws');
    expect(getSipWss('')).toBe('');
  });
});

describe('push gateway endpoint policy', () => {
  test('private / LAN / tailnet hosts reach the gateway on 8095', () => {
    expect(getPushGateway('192.168.100.5')).toBe('http://192.168.100.5:8095');
    expect(getPushGateway('10.0.0.5')).toBe('http://10.0.0.5:8095');
    expect(getPushGateway('localhost')).toBe('http://localhost:8095');
    expect(getPushGateway('100.98.185.86')).toBe('http://100.98.185.86:8095');
  });

  test('public hosts require HTTPS without changing the configured host', () => {
    expect(getPushGateway('pbx.example.com')).toBe('https://pbx.example.com');
    expect(getPushGateway('203.0.113.25')).toBe('https://203.0.113.25');
    expect(getPushGateway('http://PBX.Example.com:8443/login')).toBe('https://pbx.example.com:8443');
  });

  test('returns empty for an unset host', () => {
    expect(getPushGateway('')).toBe('');
  });
});
