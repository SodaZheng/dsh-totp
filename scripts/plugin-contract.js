import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseDocument } from 'yaml';

export function parseBundle(source) {
  // Read Cordis expressions as data; installing/checking a bundle must not execute them.
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  assert.equal(document.errors.length, 0, document.errors.map(error => error.message).join('\n'));
  assert.equal(document.warnings.length, 0, document.warnings.map(error => error.message).join('\n'));
  const patches = document.toJS();
  assert.ok(Array.isArray(patches), 'dsh.bundle.patch must contain a patch list');
  return patches;
}

export function checkClient(source, packageName) {
  const modules = [];
  runInNewContext(source, { window: { __ModuleLoader__: { load: entry => modules.push(entry) } } }, { timeout: 1000 });
  assert.equal(modules.length, 1, 'The client must register exactly one module');
  assert.equal(modules[0].id, packageName, 'The client module id must match the package name');
  assert.equal(typeof modules[0].factory, 'function', 'Missing client factory');
  const client = modules[0].factory(name => {
    assert.equal(name, 'react', `Unexpected host module: ${name}`);
    return {}; // Registration defines the component; React renders it later.
  });
  assert.equal(client.name, packageName);
  assert.equal(typeof client.apply, 'function');
  assert.ok(client.inject.includes('slots'));
  const registered = [];
  client.apply({ slots: {
    inject: (name, register) => { assert.equal(name, 'settings.section'); return register(); },
    register: (entry, component) => { registered.push(entry); assert.equal(typeof component, 'function'); },
  } });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, packageName);
  assert.equal(registered[0].name, 'settings.section');
}
