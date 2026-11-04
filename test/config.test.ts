import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../hub/config.ts';

test('secret bắt buộc và trọng số đọc từ env truyền vào', () => {
  assert.throws(() => loadConfig({}), /HUB_ENROLL_KEY/);
  const config = loadConfig({ HUB_ENROLL_KEY: 'e', HUB_WEIGHT_OUTPUT: '7' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4318);
  assert.equal(config.weights.output, 7);
});
