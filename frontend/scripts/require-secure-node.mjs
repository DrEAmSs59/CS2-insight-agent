import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These releases block the compromised eMudhra chains, including cross-signs.
export function requireSecureNode(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  const minimum = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
  if (!minimum || minor < minimum[0] || (minor === minimum[0] && patch < minimum[1])) {
    throw new Error('Use patched Node.js 22.23.4+, 24.22.1+ or 26.12.1+ before building or publishing.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`[desktop] Node.js ${process.versions.node}: ${process.execPath}`);
  requireSecureNode();
}
