import { describe, expect, it } from 'vitest';
import { panelConnectionFingerprint, panelUrl } from './panel';

describe('TencentDB Panel contract', () => {
  it('only creates bootstrap URLs for exact loopback endpoints', () => {
    expect(panelUrl('http://127.0.0.1:43123', 'token-1')).toBe(
      'http://127.0.0.1:43123/__grenagent/bootstrap#tdai-bootstrap=token-1',
    );
    expect(() => panelUrl('https://127.0.0.1:43123', 'token')).toThrow();
    expect(() => panelUrl('http://localhost:43123', 'token')).toThrow();
    expect(() => panelUrl('http://127.0.0.1:43123/path', 'token')).toThrow();
  });

  it('changes the fingerprint when connection credentials change', () => {
    const connection = {
      mode: 'remote' as const,
      serviceId: 'service-a',
      userId: 'user-a',
      gatewayEndpoint: 'https://gateway.example',
      knowledgeEndpoint: 'https://knowledge.example/v3',
      gatewayApiKey: 'gateway-secret',
      userKey: 'user-secret',
    };
    const first = panelConnectionFingerprint(connection);
    const second = panelConnectionFingerprint({ ...connection, userKey: 'changed' });
    expect(first).not.toBe(second);
  });
});
