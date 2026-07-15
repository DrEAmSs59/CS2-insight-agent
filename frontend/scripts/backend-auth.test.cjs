const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { attachBackendOutput } = require('../backend-auth.cjs');


test('captures a chunked auth token without logging it', async () => {
  const stdout = new PassThrough();
  const tokens = [];
  const lines = [];
  const reader = attachBackendOutput(stdout, {
    onToken: (token) => tokens.push(token),
    onLog: (line) => lines.push(line),
  });

  stdout.write('CS2_INSIGHT_AUTH_');
  stdout.write('TOKEN=abc_123-xyz\nBackend ready');
  stdout.end('\n');
  await new Promise((resolve) => reader.once('close', resolve));

  assert.deepEqual(tokens, ['abc_123-xyz']);
  assert.deepEqual(lines, ['Backend ready']);
});
