import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
async function check(dir) {
  for (const item of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) await check(path);
    else if (item.name.endsWith('.js')) run(['--check', path]);
  }
}
await check('src'); await check('scripts'); await check('test');
console.log('JavaScript syntax checked.');
run(['--test', 'test/*.test.js', 'scripts/release.test.js']);
