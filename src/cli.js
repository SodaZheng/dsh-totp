#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, dataPath } from './core.js';
import { OwnerLease } from './control.js';

const args = process.argv.slice(2);
const command = args.shift() || 'help';
const dirIndex = args.indexOf('--data-dir');
const dir = dirIndex >= 0 ? resolve(args[dirIndex + 1] || '') : dataPath();
async function call(record, path, body = {}) {
  const r = await fetch(record.url + '/_totp/control/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-totp-control': record.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error); return value;
}
async function main() {
  if (command === 'help' || command === '--help') {
    console.log('dsh-totp <status|enable|disable|lock|doctor> [--data-dir PATH]\n\nstatus / doctor  检查绑定、保护状态和运行入口\nenable / disable 动态开启或关闭访问验证\nlock            开启保护并锁定所有设备\n\n绑定和换绑请在 DSH 设置 → 访问验证中操作。\n默认数据目录：$DSH_TOTP_DATA_DIR 或 $DSH_HOME/dsh-totp。'); return;
  }
  if (!['status', 'doctor', 'enable', 'disable', 'lock'].includes(command)) throw new Error('未知命令。绑定和换绑请在 DSH 设置 → 访问验证中操作。');
  let record;
  try { record = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')); await call(record, 'status'); } catch { record = null; }
  if (!record) {
    const store = new Store(dir); let lease;
    try {
      lease = new OwnerLease(dir);
      const result = ['status', 'doctor'].includes(command) ? { ...store.status(), gateway: null } : { revision: store.change(command !== 'disable', { local: true }), ok: true };
      console.log(JSON.stringify(result, null, 2));
    } finally { lease?.close(); store.close(); }
    return;
  }
  console.log(JSON.stringify(await call(record, command === 'doctor' ? 'status' : command), null, 2));
}
main().catch(error => { console.error('dsh-totp: ' + error.message); process.exitCode = 1; });
