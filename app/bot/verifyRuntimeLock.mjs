import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolvePackage(lock, parent, dependency) {
  let prefix = parent;
  while (true) {
    const candidate = `${prefix ? prefix + '/' : ''}node_modules/${dependency}`;
    if (lock.packages[candidate]) return candidate;
    if (!prefix) return null;
    const index = prefix.lastIndexOf('/node_modules/');
    prefix = index < 0 ? '' : prefix.slice(0, index);
  }
}

export function verifyRuntimeLock(base, next) {
  assert.deepEqual(base.packages[''].dependencies, next.packages[''].dependencies, 'Runtime dependency specs changed');
  assert.deepEqual(base.packages[''].engines, next.packages[''].engines, 'Runtime engine changed');
  const queue = Object.keys(base.packages[''].dependencies).map(name => ['', name, false]);
  const visited = new Set();
  while (queue.length) {
    const [parent, name, optional] = queue.pop();
    const original = resolvePackage(base, parent, name);
    if (!original && optional) continue; // npm prune can omit optional/development-only lock entries.
    assert.ok(original, `Base runtime is missing ${name}`);
    const updated = resolvePackage(next, parent, name);
    assert.equal(updated, original, `Runtime dependency resolution changed: ${name}`);
    if (visited.has(original)) continue;
    visited.add(original);
    const fields = ['version', 'resolved', 'integrity', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];
    for (const field of fields) assert.deepEqual(base.packages[original][field], next.packages[updated][field], `Runtime lock changed: ${original}.${field}`);
    const node = base.packages[original];
    const optionalNames = new Set(Object.keys(node.optionalDependencies || {}));
    for (const dependency of Object.keys(node.dependencies || {})) queue.push([original, dependency, optionalNames.has(dependency)]);
    for (const dependency of optionalNames) queue.push([original, dependency, true]);
    for (const dependency of Object.keys(node.peerDependencies || {})) {
      queue.push([original, dependency, !!node.peerDependenciesMeta?.[dependency]?.optional]);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyRuntimeLock(JSON.parse(fs.readFileSync(process.argv[2])), JSON.parse(fs.readFileSync(process.argv[3])));
  console.log('Runtime dependency versions, integrity and resolution verified');
}
