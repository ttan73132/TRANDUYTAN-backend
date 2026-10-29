import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createAppsScriptMailer } from '../src/mailer.js';
import { relayRuntime, testRelaySecret } from '../test-support/apps-script-vm.js';

const relayUrl = 'https://script.google.com/macros/s/test-deployment-id/exec';
const config = { otpRelayUrl: relayUrl, otpRelaySecret: testRelaySecret };
const env = { JWT_SECRET: 'test-jwt-'.repeat(5), OTP_SECRET: 'test-otp-'.repeat(5), OTP_RELAY_URL: relayUrl, OTP_RELAY_SECRET: testRelaySecret };
test('apps_script is the default provider and needs no Brevo account configuration', () => {
  const loaded = loadConfig(env);
  assert.equal(loaded.emailProvider, 'apps_script');
  assert.equal(loaded.otpRelayUrl, relayUrl);
  assert.equal(loaded.otpRelaySecret, testRelaySecret);
});
test('relay URL and separate signing secret validation reject expanded destinations or shared keys', () => {
  for (const url of ['http://script.google.com/macros/s/test/exec', 'https://evil.example/macros/s/test/exec', relayUrl + '?key=secret', relayUrl + '#fragment', 'https://user@script.google.com/macros/s/test/exec', 'https://script.google.com:443/macros/s/test/exec', 'https://script.google.com/macros/s/test/dev']) {
    assert.throws(() => loadConfig({ ...env, OTP_RELAY_URL: url }), /OTP_RELAY_URL/);
  }
  assert.throws(() => loadConfig({ ...env, OTP_RELAY_SECRET: env.JWT_SECRET }), /OTP_RELAY_SECRET/);
  assert.throws(() => loadConfig({ ...env, OTP_RELAY_SECRET: 'short' }), /OTP_RELAY_SECRET/);
  assert.throws(() => loadConfig({ ...env, EMAIL_PROVIDER: 'unknown' }), /EMAIL_PROVIDER/);
});
test('Node adapter interoperates with the actual relay protocol using a signed body and no secret in URL', async t => {
  const relay = relayRuntime();
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent = { url, options };
    return new Response(JSON.stringify(relay.invoke(JSON.parse(options.body))), { status: 200 });
  });
  await createAppsScriptMailer(config).sendOtp({ email: 'recipient@example.test', fullName: 'Must not be transmitted', code: '123456', purpose: 'login' });
  assert.equal(sent.url, relayUrl);
  const envelope = JSON.parse(sent.options.body), payload = JSON.parse(envelope.payload);
  assert.equal(envelope.signature, createHmac('sha256', testRelaySecret).update(envelope.payload, 'utf8').digest('hex'));
  assert.deepEqual(Object.keys(payload).sort(), ['to','code','purpose','issuedAt','nonce','ttlMinutes'].sort());
  assert.equal(payload.to, 'recipient@example.test');
  assert.equal(payload.fullName, undefined);
  assert.ok(Math.abs(payload.issuedAt - Date.now()) < 10000);
  assert.equal(relay.sent.length, 1);
});
test('Node adapter follows only the Content Service Google output redirect without resending POST data', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://script.googleusercontent.com/macros/echo?test-token=opaque' } });
    return new Response('{"ok":true}', { status: 200 });
  });
  await createAppsScriptMailer(config).sendOtp({ email: 'recipient@example.test', code: '123456', purpose: 'register' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.body, undefined);
});
test('Node adapter rejects false, malformed, oversized or untrusted provider responses', async t => {
  for (const response of [new Response('{"ok":false}'), new Response('{"ok":"true"}'), new Response('<html>Login required</html>'), new Response('x'.repeat(4097)), new Response(null, { status: 302, headers: { location: 'https://evil.example/receive' } }), new Response(null, { status: 307, headers: { location: 'https://script.googleusercontent.com/macros/echo' } })]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(createAppsScriptMailer(config).sendOtp({ email: 'recipient@example.test', code: '123456', purpose: 'login' }));
    mocked.mock.restore();
  }
});
