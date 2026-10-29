import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { databaseOptions, loadConfig } from '../src/config.js';
import { createBrevoMailer } from '../src/mailer.js';

const env = { EMAIL_PROVIDER: 'brevo', JWT_SECRET: 'test-only-jwt-'.repeat(4), OTP_SECRET: 'test-only-otp-'.repeat(4), BREVO_API_KEY: 'test-only-key', BREVO_SENDER_EMAIL: 'sender@example.test' };
test('configuration rejects missing or reused authentication secrets', () => {
  assert.throws(() => loadConfig({ ...env, OTP_SECRET: env.JWT_SECRET }));
  assert.throws(() => loadConfig({ ...env, JWT_SECRET: '' }));
  assert.throws(() => loadConfig({ ...env, BREVO_SENDER_EMAIL: 'not-an-email' }));
});
test('production PostgreSQL TLS verification cannot be disabled by a URL sslmode parameter', () => {
  const options = databaseOptions({ DATABASE_URL: 'postgresql://test:test@example.test/attendance?sslmode=no-verify', NODE_ENV: 'production' });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'), false);
  assert.throws(() => databaseOptions({ DATABASE_URL: 'postgresql://test:test@example.test/attendance', DATABASE_SSL: 'false', NODE_ENV: 'production' }));
});
test('Brevo adapter sends the actual recipient and OTP to the documented HTTPS endpoint', async t => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent = { url, options }; return new Response('{}', { status: 201 }); });
  const mailer = createBrevoMailer({ brevoApiKey: 'test-only-key', senderEmail: 'sender@example.test', senderName: 'Test app' });
  await mailer.sendOtp({ email: 'recipient@example.test', fullName: 'Recipient', code: '123456', purpose: 'login' });
  assert.equal(sent.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(sent.options.method, 'POST');
  const body = JSON.parse(sent.options.body);
  assert.equal(body.to[0].email, 'recipient@example.test');
  assert.match(body.textContent, /123456/);
  assert.equal(body.sender.email, 'sender@example.test');
  assert.ok(sent.options.signal instanceof AbortSignal);
});
test('Brevo rejection does not report a successful email delivery', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  const mailer = createBrevoMailer({ brevoApiKey: 'test-only-key', senderEmail: 'sender@example.test', senderName: 'Test app' });
  await assert.rejects(mailer.sendOtp({ email: 'recipient@example.test', fullName: 'Recipient', code: '123456' }));
});
test('server exits instead of opening an unauthenticated fallback when credentials are missing', () => {
  const child = spawnSync(process.execPath, ['src/server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, JWT_SECRET: '', OTP_SECRET: '', BREVO_API_KEY: '', BREVO_SENDER_EMAIL: '', DATABASE_URL: '' },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout.includes('listening'), false);
  assert.match(child.stderr, /API chưa khởi động/);
});
