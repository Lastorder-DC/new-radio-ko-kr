import { describe, expect, it } from 'vitest';
import { verifyRuntimeLock } from './verifyRuntimeLock.mjs';

const lock = () => ({ packages: {
  '': { dependencies: { a: '^1' }, engines: { node: '24.x' } },
  'node_modules/a': { version: '1.0.0', integrity: 'a-hash', dependencies: { b: '^1' } },
  'node_modules/b': { version: '1.0.0', integrity: 'b-hash' },
} });
describe('runtime reuse lock verification', () => {
  it('allows development-only and unreachable entries removed by npm prune', () => {
    const next = lock();
    next.packages['node_modules/dev-tool'] = { version: '2.0.0', dev: true };
    next.packages['node_modules/unreachable'] = { version: '3.0.0' };
    expect(() => verifyRuntimeLock(lock(), next)).not.toThrow();
  });
  it('rejects changes to runtime dependency versions or integrity', () => {
    const next = lock();
    next.packages['node_modules/b'].integrity = 'changed';
    expect(() => verifyRuntimeLock(lock(), next)).toThrow('Runtime lock changed');
  });
  it('rejects a newly shadowed transitive dependency', () => {
    const next = lock();
    next.packages['node_modules/a/node_modules/b'] = { version: '1.1.0' };
    expect(() => verifyRuntimeLock(lock(), next)).toThrow('Runtime dependency resolution changed');
  });
  it('rejects a new direct runtime dependency', () => {
    const next = lock();
    next.packages[''].dependencies.c = '^1';
    expect(() => verifyRuntimeLock(lock(), next)).toThrow('Runtime dependency specs changed');
  });
});
