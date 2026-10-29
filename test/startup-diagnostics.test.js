import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { startupDiagnostic } from '../src/startup-diagnostics.js';

const sensitive = 'postgresql://private-user:PRIVATE_PASSWORD@private-host/db?SECRET_KEY=PRIVATE_KEY';
test('startup diagnostic emits only allowlisted stages and error codes, never raw error content', () => {
  const error = Object.assign(new Error(sensitive), { code: '28P01', detail: sensitive, stack: sensitive });
  assert.deepEqual(startupDiagnostic('migrations', error), { stage: 'migrations', code: '28P01' });
  assert.deepEqual(startupDiagnostic(sensitive, { code: sensitive, message: sensitive }), { stage: 'unknown', code: 'UNKNOWN' });
  assert.deepEqual(startupDiagnostic('migrations', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: sensitive } }), { stage: 'migrations', code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  assert.deepEqual(startupDiagnostic('migrations', { errors: [{ code: 'ECONNREFUSED', message: sensitive }] }), { stage: 'migrations', code: 'ECONNREFUSED' });
  assert.deepEqual(startupDiagnostic('config', new Error('Thiếu cấu hình JWT_SECRET.')), { stage: 'config', code: 'CONFIG_MISSING_JWT_SECRET' });
  assert.deepEqual(startupDiagnostic('config', new Error(sensitive)), { stage: 'config', code: 'CONFIG_INVALID' });
  assert.deepEqual(startupDiagnostic('migrations', new Error('Migration đã áp dụng bị thay đổi. Hãy bổ sung migration mới.')), { stage: 'migrations', code: 'MIGRATION_CHECKSUM_MISMATCH' });
});
test('actual server startup catch reports each failing stage safely and closes its pool', async () => {
  const source = (await readFile(new URL('../src/server.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  for (const failing of ['config','database_options','migrations','bootstrap','application','listen']) {
    const logs = []; let closed = false;
    const error = Object.assign(new Error(sensitive), { code: '42501', detail: sensitive });
    const check = stage => { if (stage === failing) throw error; };
    const context = {
      pg: { Pool: class { async end() { closed = true; } } },
      loadConfig() { check('config'); return { port: 8080 }; }, databaseOptions() { check('database_options'); return {}; },
      async applyMigrations() { check('migrations'); }, bootstrapInput() { check('bootstrap'); return {}; }, async bootstrapAdmin() { return false; },
      createMailer() { return {}; }, createApp() { check('application'); return { listen() { check('listen'); } }; },
      startupDiagnostic, process: { env: { BOOTSTRAP_ADMIN_EMAIL: 'synthetic@example.test' }, exitCode: 0 },
      console: { error: value => logs.push(value), log: value => logs.push(value) },
    };
    await vm.runInNewContext(`(async () => { ${source}\n })()`, context);
    assert.equal(context.process.exitCode, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`stage=${failing} code=42501`));
    for (const marker of ['PRIVATE_PASSWORD','private-host','PRIVATE_KEY','postgresql://']) assert.equal(logs[0].includes(marker), false);
    assert.equal(closed, !['config','database_options'].includes(failing));
  }
});
