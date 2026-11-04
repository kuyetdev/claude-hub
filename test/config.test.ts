import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../hub/config.ts';

test('cấu hình mặc định và trọng số đọc từ env truyền vào', () => {
  const config = loadConfig({ HUB_WEIGHT_OUTPUT: '7' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4318);
  assert.equal(config.weights.output, 7);
  assert.equal(loadConfig({ HUB_PUBLIC_URL: 'http://claudehub.ccam.io.vn' }).publicUrl, 'http://claudehub.ccam.io.vn');
});
