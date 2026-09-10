import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { parseBundle, checkClient } from '../scripts/plugin-contract.js';

test('the browser module registers its package id and access settings through DSH slots', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  checkClient(source, pkg.name);
  assert.throws(() => checkClient(source.replace("id: 'dsh-totp'", "id: 'wrong-package'"), pkg.name), /module id/);
});

test('the bundle preserves CLI trusted hosts for both the gateway and the Web runtime', () => {
  const patches = parseBundle(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const runtime = patches.find(row => row.id === 'web-runtime');
  const gateway = patches.flatMap(row => row.insert ?? []).find(row => row.name === 'dsh-totp');
  const trustedHosts = ['dsh.example.test:3080'];
  const context = { ctx: { webStartup: { host: '0.0.0.0', port: 3080, trustedHosts } } };
  assert.deepEqual(runInNewContext(runtime.config.trustedHosts, context), trustedHosts);
  assert.deepEqual(runInNewContext(gateway.config.allowedHosts, context), trustedHosts);
  assert.equal(runtime.config.openBrowser, false);
  assert.equal(runtime.config.printUrl, false);
  assert.equal(runtime.config.surfaceContext, true);
  assert.equal(patches.find(row => row.id === 'webserver').disabled, true);
});
