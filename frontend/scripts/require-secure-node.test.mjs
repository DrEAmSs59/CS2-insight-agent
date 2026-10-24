import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSecureNode } from './require-secure-node.mjs';

test('blocks affected Node releases at build and publish entry points', () => {
  for (const version of ['22.22.1', '22.22.2', '22.23.3', '24.22.0', '26.12.0', '20.20.0']) {
    assert.throws(() => requireSecureNode(version), /patched Node/);
  }
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '26.12.1']) {
    assert.doesNotThrow(() => requireSecureNode(version));
  }
});
