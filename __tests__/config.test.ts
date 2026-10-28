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

  test('public hosts use HTTP port 80', () => {
    expect(getPushGateway('pbx.example.com')).toBe('http://pbx.example.com');
    expect(getPushGateway('8.8.8.8')).toBe('http://8.8.8.8');
  });

  test('returns empty for an unset host', () => {
    expect(getPushGateway('')).toBe('');
  });
});
