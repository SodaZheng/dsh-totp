import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBundle, checkClient } from './plugin-contract.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')), plugin = JSON.parse(read('dsh.plugin.json'));
const lock = JSON.parse(read('package-lock.json'));
assert.equal(pkg.name, plugin.name);
for (const version of [plugin.version, lock.version, lock.packages[''].version]) assert.equal(version, pkg.version);
assert.equal(typeof pkg.dsh?.bundle?.patch, 'string', 'Missing dsh.bundle.patch');
const bundlePath = pkg.dsh.bundle.patch.replace(/^\.\//, '');
assert.ok(!bundlePath.startsWith('/') && !bundlePath.split('/').includes('..'), 'Bundle path must stay inside the package');
const patches = parseBundle(read(bundlePath));
const entries = patches.flatMap(patch => patch.insert ?? []);
assert.ok(entries.some(entry => entry.name === pkg.name), 'Bundle must insert the host plugin');
assert.equal(pkg.dsh.client.platform, 'web');
assert.match(pkg.repository.url, /^git\+https:\/\//);
assert.ok(pkg.keywords.includes('dsh-plugin'));
for (const name of Object.keys(pkg.dependencies)) assert.ok(!name.startsWith('@deepseek-ai/'), `${name} must be a peer`);
// This source-only plugin intentionally needs no install/build hooks. This is
// our package policy, not a prohibition on hooks in other DSH plugins.
for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) assert.equal(pkg.scripts[name], undefined, `Unexpected lifecycle script: ${name}`);
assert.ok(process.env.npm_execpath, 'Run via npm run check:package');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
const [pack] = JSON.parse(result.stdout), files = new Set(pack.files.map(file => file.path));
for (const entry of entries) {
  if (entry.name !== pkg.name && !entry.name.startsWith(pkg.name + '/')) continue;
  const subpath = '.' + entry.name.slice(pkg.name.length);
  assert.equal(typeof pkg.exports[subpath], 'string', `Missing bundle export: ${subpath}`);
  assert.ok(files.has(pkg.exports[subpath].replace(/^\.\//, '')), `Missing bundle entry: ${entry.name}`);
}
const required = [pkg.main, ...Object.values(pkg.exports), ...Object.values(pkg.bin), pkg.dsh.bundle.patch,
  'dsh.plugin.json', 'README.md', 'README.en.md', 'docs/assets/cover.png', 'docs/assets/README.md', 'LICENSE'];
for (const file of required) assert.ok(files.has(file.replace(/^\.\//, '')), `Missing package file: ${file}`);
checkClient(read(pkg.exports['./client']), pkg.name);
for (const file of files) {
  assert.ok(file.startsWith('src/') || required.some(path => path.replace(/^\.\//, '') === file), `Unexpected package file: ${file}`);
  if (!file.startsWith('src/') || !file.endsWith('.js')) continue;
  for (const [, specifier] of read(file).matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const dependency = new URL(specifier, new URL(file, 'https://package.invalid/')).pathname.slice(1);
    assert.ok(files.has(dependency), `Missing runtime import: ${file} -> ${dependency}`);
  }
}
console.log(`Package verified: ${pkg.name}@${pkg.version}, ${files.size} files; bundle entries, runtime imports and client registration passed.`);
