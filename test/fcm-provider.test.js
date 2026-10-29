import test from 'node:test';
import assert from 'node:assert/strict';
import { createFcmProvider, notificationMessage, PushDeliveryError } from '../src/fcm.js';

const event = { event_type: 'shift_assigned', entity_id: '22222222-2222-4222-8222-222222222222', recipient_id: '33333333-3333-4333-8333-333333333333' };
test('FCM v1 sends a FID with only the approved generic notification and opaque data', async () => {
  let request;
  const provider = createFcmProvider({ fcmProjectId: 'test-project' }, {
    getAccessToken: async () => 'test-access-token',
    fetchImpl: async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ name: 'projects/test-project/messages/accepted' }), { status: 200 }); },
  });
  await provider.send('c123456789012345678901', event);
  assert.equal(request.url, 'https://fcm.googleapis.com/v1/projects/test-project/messages:send');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, 'Bearer test-access-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.message.fid, 'c123456789012345678901');
  assert.equal(body.message.token, undefined);
  assert.deepEqual(body.message.notification, { title: 'Sổ ca HN', body: 'Bạn có cập nhật mới. Mở ứng dụng để xem' });
  assert.deepEqual(body.message.data, { eventType: 'shift_assigned', entityId: event.entity_id, recipientId: event.recipient_id });
  assert.equal(body.message.android.ttl, '300s');
  assert.equal(body.message.android.notification.visibility, 'PRIVATE');
});
test('provider never treats malformed success or HTTP failure as delivery, and classifies stale FIDs', async () => {
  for (const [status, body, code, retryable] of [
    [200, {}, 'FCM_RESPONSE_INVALID', true],
    [404, { error: { details: [{ errorCode: 'UNREGISTERED' }] } }, 'FCM_UNREGISTERED', false],
    [403, { error: { status: 'PERMISSION_DENIED' } }, 'FCM_PERMISSION_DENIED', false],
    [429, { error: {} }, 'FCM_RATE_LIMITED', true],
    [503, { error: {} }, 'FCM_UNAVAILABLE', true],
  ]) {
    const provider = createFcmProvider({ fcmProjectId: 'test-project' }, { getAccessToken: async () => 'private', fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
    await assert.rejects(provider.send('c123456789012345678901', event), error => error instanceof PushDeliveryError && error.code === code && error.retryable === retryable && !error.message.includes('private'));
  }
  const provider = createFcmProvider({ fcmProjectId: 'test-project' }, { getAccessToken: async () => { throw new Error('SECRET-CREDENTIAL'); } });
  await assert.rejects(provider.send('c123456789012345678901', event), error => error.code === 'FCM_AUTH_UNAVAILABLE' && !error.message.includes('SECRET'));
});
test('message builder discards all business content outside the allowlist', () => {
  const message = notificationMessage('c123456789012345678901', { ...event, email: 'private@example.test', reason: 'Private medical reason', latitude: 10, original_text: 'private' });
  assert.deepEqual(Object.keys(message.data).sort(), ['entityId', 'eventType', 'recipientId']);
  assert.equal(JSON.stringify(message).includes('private'), false);
});
test('FCM checks the current binding after OAuth and never sends a revoked target', async () => {
  const order = []; let sent = false;
  const provider = createFcmProvider({ fcmProjectId: 'test-project' }, { getAccessToken: async () => { order.push('oauth'); return 'private'; }, fetchImpl: async () => { sent = true; throw new Error(); } });
  await assert.rejects(provider.send('c123456789012345678901', event, { beforeSend: async () => { order.push('binding'); return false; } }), error => error.code === 'FCM_BINDING_STALE' && !error.retryable);
  assert.deepEqual(order, ['oauth','binding']); assert.equal(sent, false);
});
test('FCM honors the provider Retry-After interval without exposing its response details', async () => {
  const provider = createFcmProvider({ fcmProjectId: 'test-project' }, { getAccessToken: async () => 'private', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Sensitive provider diagnostic' } }), { status: 429, headers: { 'Retry-After': '120' } }) });
  await assert.rejects(provider.send('c123456789012345678901', event), error => error.retryAfterMs === 120000 && !error.message.includes('Sensitive'));
});
