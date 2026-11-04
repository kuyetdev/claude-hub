import { once } from 'node:events';
import { createServer } from 'node:http';
import { openDatabase } from '../hub/db.ts';
import { createHandler } from '../hub/app.ts';
import type { HubConfig } from '../hub/config.ts';

export const TEST_CONFIG: HubConfig = {
  host: '127.0.0.1', port: 0, dbPath: ':memory:', timezone: 'Asia/Ho_Chi_Minh',
  weights: { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 },
};

export async function testServer(options: Parameters<typeof createHandler>[2] = {}) {
  const db = openDatabase(':memory:');
  const server = createServer(createHandler(db, TEST_CONFIG, options));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Không lấy được địa chỉ test.');
  return {
    db,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close'); db.close(); },
  };
}

export async function register(baseUrl: string, username = 'alice', machineId = '7f19d0d8-8c54-4ee3-a463-8cc45f632b14') {
  const response = await fetch(`${baseUrl}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, machineId, hostname: 'may-test' }),
  });
  return { response, body: await response.json() as { machineToken: string } };
}
