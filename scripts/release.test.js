import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const releaseSource = readFileSync(new URL('./release.js', import.meta.url), 'utf8');

function fixture(t, version = '0.0.1') {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-totp-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const remote = join(directory, 'remote.git');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  // Isolate the test repos from personal signing, hooks, and push configuration.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig') };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const command = (program, args, cwd = repo) => {
    const result = spawnSync(program, args, { cwd, env, encoding: 'utf8' });
    assert.ifError(result.error);
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const git = (...args) => {
    const result = command('git', args);
    assert.equal(result.status, 0, result.output);
    return result.stdout.trim();
  };
  const write = (file, content) => writeFileSync(join(repo, file), content);
  const read = (file) => readFileSync(join(repo, file), 'utf8');
  const json = (file) => JSON.parse(read(file));
  const commit = (subject) => { git('add', '.'); git('commit', '-m', subject); };
  const release = (...args) => process.env.npm_execpath
    ? command(process.execPath, [process.env.npm_execpath, 'run', 'release', '--', ...args])
    : command(process.execPath, ['scripts/release.js', ...args]);
  const remoteRef = (ref) => git('ls-remote', remote, ref).split(/\s+/)[0];
  const versions = () => [json('package.json').version, json('dsh.plugin.json').version,
    json('package-lock.json').version, json('package-lock.json').packages[''].version];

  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  write('package.json', `${JSON.stringify({ name: 'release-test', version, type: 'module',
    scripts: { release: 'node scripts/release.js' } }, null, 2)}\n`);
  write('dsh.plugin.json', `{\n  "name": "release-test",\n  "version": "${version}",\n  "entry": { "name": "release-test" }\n}\n`);
  write('package-lock.json', `${JSON.stringify({ name: 'release-test', version, lockfileVersion: 3,
    packages: { '': { name: 'release-test', version }, 'node_modules/example': { version: '9.8.7' } } }, null, 2)}\n`);
  write('scripts/release.js', releaseSource);
  write('scripts/check.js', "console.log('Fixture check passed.');\n");
  commit('Initial commit');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  return { repo, remote, git, write, read, json, commit, release, remoteRef, versions };
}

test('npm run release synchronizes versions and pushes an annotated tag on every successful run', (t) => {
  const f = fixture(t, '0.1.9');
  const entry = f.json('dsh.plugin.json').entry;
  // An existing local commit and a branch without an upstream are supported.
  f.write('feature.txt', 'New feature\n');
  f.commit('Add feature');
  for (const version of ['0.1.10', '0.1.11']) {
    const result = f.release();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(f.versions(), Array(4).fill(version));
    assert.deepEqual(f.json('dsh.plugin.json').entry, entry);
    assert.equal(f.json('package-lock.json').packages['node_modules/example'].version, '9.8.7');
    assert.equal(f.git('cat-file', '-t', `v${version}`), 'tag');
    assert.equal(f.git('log', '-1', '--format=%s'), `chore(release): v${version}`);
    assert.equal(f.remoteRef('refs/heads/main'), f.git('rev-parse', 'HEAD'));
    assert.equal(f.remoteRef(`refs/tags/v${version}`), f.git('rev-parse', `v${version}`));
    assert.equal(f.git('status', '--porcelain'), '');
    assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(),
      ['dsh.plugin.json', 'package-lock.json', 'package.json']);
  }
});

test('dry-run checks the release without changing files, commits, tags, or the remote', (t) => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  const result = f.release('--dry-run');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /0\.1\.0 → 0\.1\.1/);
  assert.deepEqual(f.versions(), Array(4).fill('0.0.1'));
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.remoteRef('refs/heads/main'), before);
  assert.equal(f.git('tag'), '');
  assert.equal(f.git('status', '--porcelain'), '');
});

test('stops for untracked, modified, or staged work without committing it', (t) => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  f.write('untracked.txt', 'keep me');
  assert.match(f.release().output, /工作区有未提交/);
  rmSync(join(f.repo, 'untracked.txt'));
  f.write('scripts/check.js', '// User edit\n');
  assert.match(f.release().output, /工作区有未提交/);
  f.git('add', 'scripts/check.js');
  const result = f.release();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /工作区有未提交/);
  assert.equal(f.read('scripts/check.js'), '// User edit\n');
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.deepEqual(f.versions(), Array(4).fill('0.0.1'));
});

test('stops on inconsistent versions and invalid versions', (t) => {
  const f = fixture(t);
  f.write('dsh.plugin.json', JSON.stringify({ name: 'release-test', version: '0.0.9' }));
  f.commit('Inconsistent version');
  let result = f.release();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /版本不一致/);
  const pkg = f.json('package.json');
  pkg.version = '0.0.1-beta.1';
  f.write('package.json', JSON.stringify(pkg));
  f.commit('Prerelease version');
  result = f.release();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /版本必须为 x\.y\.z/);
  assert.equal(f.git('tag'), '');
});

test('stops on detached HEAD', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach');
  const result = f.release();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /detached HEAD/);
  assert.equal(f.git('tag'), '');
});

for (const remoteTag of [false, true]) {
  test(`stops when the next tag already exists ${remoteTag ? 'remotely' : 'locally'}`, (t) => {
    const f = fixture(t);
    f.git('tag', '-a', 'v0.1.1', '-m', 'Existing release');
    if (remoteTag) {
      f.git('push', 'origin', 'v0.1.1');
      f.git('tag', '-d', 'v0.1.1');
    }
    const result = f.release();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /v0\.1\.1 已存在/);
    assert.deepEqual(f.versions(), Array(4).fill('0.0.1'));
  });
}

test('stops when the remote branch is ahead or diverged', (t) => {
  const f = fixture(t);
  const initial = f.git('rev-parse', 'HEAD');
  f.write('remote.txt', 'Remote change\n');
  f.commit('Remote change');
  f.git('push', 'origin', 'main');
  f.git('reset', '--hard', initial);
  let result = f.release();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /落后.*或已分叉/);
  f.write('local.txt', 'Local change\n');
  f.commit('Local change');
  result = f.release();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /落后.*或已分叉/);
  assert.deepEqual(f.versions(), Array(4).fill('0.0.1'));
  assert.equal(f.git('tag'), '');
});

test('failed checks leave versions unchanged', (t) => {
  const f = fixture(t);
  f.write('scripts/check.js', 'process.exit(1);\n');
  f.commit('Fail check');
  const before = f.git('rev-parse', 'HEAD');
  const result = f.release();
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.versions(), Array(4).fill('0.0.1'));
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('a rejected commit restores the original version files and index', (t) => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  const hook = join(f.repo, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const result = f.release();
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.versions(), Array(4).fill('0.0.1'));
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('tag'), '');
  rmSync(hook);
  const retry = f.release();
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(f.versions(), Array(4).fill('0.1.1'));
});

for (const removeTag of [false, true]) {
  test(`a rejected push is atomic and retries the same version ${removeTag ? 'without a local tag' : 'with its tag'}`, (t) => {
    const f = fixture(t);
    const before = f.remoteRef('refs/heads/main');
    const hook = join(f.remote, 'hooks/update');
    writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\nexit 0\n');
    chmodSync(hook, 0o755);
    const result = f.release();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /再次执行 npm run release/);
    assert.deepEqual(f.versions(), Array(4).fill('0.1.1'));
    assert.equal(f.remoteRef('refs/heads/main'), before);
    assert.equal(f.remoteRef('refs/tags/v0.1.1'), '');
    const releaseHead = f.git('rev-parse', 'HEAD');
    if (removeTag) f.git('tag', '-d', 'v0.1.1');
    rmSync(hook);
    const retry = f.release();
    assert.equal(retry.status, 0, retry.output);
    assert.match(retry.output, /继续推送 v0\.1\.1/);
    assert.equal(f.git('rev-parse', 'HEAD'), releaseHead);
    assert.deepEqual(f.versions(), Array(4).fill('0.1.1'));
    assert.equal(f.remoteRef('refs/heads/main'), releaseHead);
    assert.equal(f.remoteRef('refs/tags/v0.1.1'), f.git('rev-parse', 'v0.1.1'));
    assert.equal(f.git('tag'), 'v0.1.1');
  });
}
