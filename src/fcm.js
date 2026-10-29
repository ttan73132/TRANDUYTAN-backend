import { JWT } from 'google-auth-library';

export class PushDeliveryError extends Error {
  constructor(code, retryable, retryAfterMs = 0) { super('Không gửi được thông báo.'); this.code = code; this.retryable = retryable; this.retryAfterMs = retryAfterMs; }
}
export function notificationMessage(fid, event) {
  return { fid, notification: { title: 'Sổ ca HN', body: 'Bạn có cập nhật mới. Mở ứng dụng để xem' },
    data: { eventType: event.event_type, entityId: event.entity_id, recipientId: event.recipient_id },
    android: { ttl: '300s', priority: 'normal', notification: { visibility: 'PRIVATE' } } };
}
async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new PushDeliveryError('FCM_RESPONSE_INVALID', true);
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new PushDeliveryError('FCM_RESPONSE_INVALID', true); }
}
export function createFcmProvider(config, { getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  // Only the scoped service-account identity/key are accepted. In particular, a
  // credential JSON token_uri cannot redirect authentication to another host.
  const client = getAccessToken ? null : new JWT({ email: config.fcmCredentials.client_email, key: config.fcmCredentials.private_key,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'], transporterOptions: { timeout: 8000, retry: false } });
  const accessToken = getAccessToken ?? (async () => (await client.getAccessToken()).token);
  return {
    async send(fid, event, { beforeSend } = {}) {
      let token;
      try { token = await accessToken(); if (!token) throw new Error(); }
      catch { throw new PushDeliveryError('FCM_AUTH_UNAVAILABLE', true); }
      // OAuth can take seconds. Revalidate the binding after obtaining the token,
      // immediately before the external side effect rather than before OAuth.
      if (beforeSend && !await beforeSend()) throw new PushDeliveryError('FCM_BINDING_STALE', false);
      let response;
      try {
        response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${config.fcmProjectId}/messages:send`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: notificationMessage(fid, event) }),
        });
      } catch { throw new PushDeliveryError('FCM_UNAVAILABLE', true); }
      const body = await responseJson(response);
      if (response.ok) {
        if (typeof body.name !== 'string' || !body.name.startsWith(`projects/${config.fcmProjectId}/messages/`) || body.name.length > 512) throw new PushDeliveryError('FCM_RESPONSE_INVALID', true);
        return;
      }
      const unregistered = body.error?.details?.some?.(detail => detail.errorCode === 'UNREGISTERED');
      if (unregistered) throw new PushDeliveryError('FCM_UNREGISTERED', false);
      const retryHeader = response.headers.get('retry-after');
      const retryAfterMs = retryHeader ? Math.max(0, Math.min(86400000, /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now())) || 0 : 0;
      if (response.status === 429) throw new PushDeliveryError('FCM_RATE_LIMITED', true, retryAfterMs);
      if (response.status >= 500) throw new PushDeliveryError('FCM_UNAVAILABLE', true, retryAfterMs);
      if ([401,403].includes(response.status)) throw new PushDeliveryError('FCM_PERMISSION_DENIED', false);
      throw new PushDeliveryError('FCM_REQUEST_REJECTED', false);
    },
  };
}
