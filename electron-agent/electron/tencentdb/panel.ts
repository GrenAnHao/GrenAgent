import { createHash } from 'node:crypto';

export interface PanelConnection {
  mode: 'local' | 'remote';
  serviceId: string;
  userId: string;
  gatewayEndpoint: string;
  knowledgeEndpoint: string;
  gatewayApiKey: string;
  userKey: string;
}

export function panelUrl(endpoint: string, token: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('TencentDB Panel endpoint is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('TencentDB Panel endpoint must be an exact loopback HTTP endpoint');
  }
  if (!token.trim()) throw new Error('TencentDB Panel bootstrap token must not be empty');
  url.pathname = '/__grenagent/bootstrap';
  url.hash = `tdai-bootstrap=${token}`;
  return url.toString();
}

export function panelConnectionFingerprint(connection: PanelConnection): string {
  const hash = createHash('sha256');
  for (const value of [
    connection.mode,
    connection.serviceId,
    connection.userId,
    connection.gatewayEndpoint,
    connection.knowledgeEndpoint,
    connection.gatewayApiKey,
    connection.userKey,
  ]) {
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}
