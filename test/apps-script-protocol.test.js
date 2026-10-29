import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { relayRuntime, newPayload, signedEnvelope, testRelaySecret } from '../test-support/apps-script-vm.js';

test('authenticated relay sends one OTP and exposes no recipient or code in its response', () => {
  const relay = relayRuntime();
  const result = relay.invoke(signedEnvelope(newPayload(relay.time)));
  assert.deepEqual(result, { ok: true });
  assert.equal(relay.sent.length, 1);
  assert.equal(relay.sent[0].to, 'recipient@example.test');
  assert.match(relay.sent[0].body, /123456/);
  assert.equal(JSON.stringify(result).includes('recipient'), false);
  assert.equal(JSON.stringify(result).includes('123456'), false);
});
test('invalid signatures and stale or future timestamps never send email', () => {
  const relay = relayRuntime();
  const valid = signedEnvelope(newPayload(relay.time));
  assert.deepEqual(relay.invoke({ ...valid, signature: '0'.repeat(64) }), { ok: false });
  assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time, { issuedAt: relay.time - 120001 }))), { ok: false });
  assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time, { issuedAt: relay.time + 120001 }))), { ok: false });
  assert.equal(relay.sent.length, 0);
  assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time))), { ok: true });
});
test('relay rejects a consumed nonce even in a fresh Apps Script VM using the same persistent properties', () => {
  const first = relayRuntime();
  const request = signedEnvelope(newPayload(first.time));
  assert.deepEqual(first.invoke(request), { ok: true });
  const second = relayRuntime({ time: first.time, store: first.store });
  assert.deepEqual(second.invoke(request), { ok: false });
  assert.equal(second.sent.length, 0);
});
test('daily quota failure consumes the nonce and cannot be replayed after quota becomes available', () => {
  const relay = relayRuntime({ quota: 0 });
  const request = signedEnvelope(newPayload(relay.time));
  assert.deepEqual(relay.invoke(request), { ok: false });
  relay.setQuota(100);
  assert.deepEqual(relay.invoke(request), { ok: false });
  assert.equal(relay.sent.length, 0);
  assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time))), { ok: true });
});
test('mail provider failure consumes the nonce and never returns ok true', () => {
  const relay = relayRuntime({ failSend: true });
  const request = signedEnvelope(newPayload(relay.time));
  assert.deepEqual(relay.invoke(request), { ok: false });
  relay.setFailure(false);
  assert.deepEqual(relay.invoke(request), { ok: false });
  assert.equal(relay.sent.length, 0);
  assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time))), { ok: true });
});
test('minute throttle blocks excess requests and does not revive their consumed nonce next minute', () => {
  const relay = relayRuntime();
  for (let i = 0; i < 20; i++) assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time))), { ok: true });
  const blocked = signedEnvelope(newPayload(relay.time));
  assert.deepEqual(relay.invoke(blocked), { ok: false });
  relay.setTime(relay.time + 60000);
  assert.deepEqual(relay.invoke(blocked), { ok: false });
  assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time + 60000))), { ok: true });
  assert.equal(relay.sent.length, 21);
});
test('relay enforces strict envelope, payload, single recipient, content size and GET sends nothing', () => {
  const relay = relayRuntime();
  for (const extra of [{ to: 'one@example.test,two@example.test' }, { code: '12345' }, { purpose: 'arbitrary' }, { ttlMinutes: 11 }, { ttlMinutes: 0 }, { issuedAt: String(relay.time) }, { nonce: 'not-a-uuid' }, { from: 'override@example.test' }]) {
    assert.deepEqual(relay.invoke(signedEnvelope(newPayload(relay.time, extra))), { ok: false });
  }
  assert.deepEqual(relay.invoke({ ...signedEnvelope(newPayload(relay.time)), extra: true }), { ok: false });
  assert.deepEqual(relay.postEvent({ postData: { type: 'application/json', contents: 'x'.repeat(4097) } }), { ok: false });
  assert.deepEqual(relay.postEvent({ postData: { type: 'text/plain', contents: JSON.stringify(signedEnvelope(newPayload(relay.time))) } }), { ok: false });
  assert.deepEqual(relay.get(), { ok: false });
  assert.equal(relay.sent.length, 0);
});
test('unavailable lock or missing relay secret fails closed', () => {
  const busy = relayRuntime({ lockAvailable: false });
  assert.deepEqual(busy.invoke(signedEnvelope(newPayload(busy.time))), { ok: false });
  assert.equal(busy.sent.length, 0);
  const unconfigured = relayRuntime({ store: new Map() });
  assert.deepEqual(unconfigured.invoke(signedEnvelope(newPayload(unconfigured.time), testRelaySecret)), { ok: false });
  assert.equal(unconfigured.sent.length, 0);
});
test('relay manifest requests send_mail only and never Gmail read access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../tool/apps-script/appsscript.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/script.send_mail']);
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.equal(manifest.webapp.access, 'ANYONE_ANONYMOUS');
});
