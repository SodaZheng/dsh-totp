// Fake npm boundary for release tests. No requests reach a real registry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.DSH_RELEASE_TEST_NPM_STATE;
if (!stateFile) throw new Error('This fixture requires an isolated test state file.');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const [command, ...args] = process.argv.slice(2);
assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
state.events.push({ command, hasOtp: args.some((arg) => arg.startsWith('--otp=')) });
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const fail = (code) => { save(); console.log(JSON.stringify({ error: { code } })); process.exit(1); };

switch (command) {
  case 'view': {
    if (state.viewError) fail(state.viewError);
    const spec = args[0];
    const version = spec.slice(spec.lastIndexOf('@') + 1);
    if (!state.versions[version]) fail('E404');
    if (state.publishedViewFailure === 'empty') break;
    if (state.publishedViewFailure) fail(state.publishedViewFailure);
    console.log(JSON.stringify(state.versions[version]));
    break;
  }
  case 'whoami':
    if (state.failAuth) fail('ENEEDAUTH');
    console.log('release-test');
    break;
  case 'pack':
    assert.ok(args.includes('--dry-run'));
    assert.ok(args.includes('--ignore-scripts'));
    console.log('Package contents checked.');
    break;
  case 'publish': {
    assert.ok(args.includes('--access=public'));
    assert.ok(args.includes('--tag=latest'));
    assert.ok(args.includes('--dry-run=false'));
    assert.ok(args.includes('--ignore-scripts=false'));
    if (state.failPublish) fail('EOTP');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    if (state.versions[pkg.version]) fail('EPUBLISHCONFLICT');
    state.versions[pkg.version] = {
      name: pkg.name,
      version: pkg.version,
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    };
    if (state.publishThenFail) fail('ECONNRESET');
    console.log(`+ ${pkg.name}@${pkg.version}`);
    break;
  }
  default:
    throw new Error(`Unexpected npm command: ${command}`);
}
save();
