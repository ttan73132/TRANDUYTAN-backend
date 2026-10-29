import { createHmac, randomUUID } from 'node:crypto';
import { validateAppsScriptUrl } from './config.js';

export function createMailer(config) {
  if (config.emailProvider === 'apps_script') return createAppsScriptMailer(config);
  if (config.emailProvider === 'brevo') return createBrevoMailer(config);
  throw new Error('Email provider is not configured.');
}

async function requireRelaySuccess(response) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('OTP relay rejected request.'); }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('OTP relay response is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || body.ok !== true) throw new Error('OTP relay did not confirm sending.');
}
export function createAppsScriptMailer(config) {
  const url = validateAppsScriptUrl(config.otpRelayUrl);
  if (typeof config.otpRelaySecret !== 'string' || config.otpRelaySecret.length < 32) throw new Error('OTP relay signing secret is not configured.');
  return {
    async sendOtp({ email, code, purpose }) {
      const payload = JSON.stringify({ to: email, code, purpose, issuedAt: Date.now(), nonce: randomUUID(), ttlMinutes: 10 });
      const signature = createHmac('sha256', config.otpRelaySecret).update(payload, 'utf8').digest('hex');
      const signal = AbortSignal.timeout(15000);
      let response = await fetch(url, { method: 'POST', redirect: 'manual', signal,
        headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ payload, signature }) });
      if ([302,303].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const output = new URL(location);
        if (output.protocol !== 'https:' || output.hostname !== 'script.googleusercontent.com' || output.username || output.password || output.port || output.hash || !output.pathname.startsWith('/macros/')) throw new Error('OTP relay redirect is not trusted.');
        // ContentService returns its body through a one-time Google output URL.
        // Never resend the signed POST payload or any secret to that URL.
        response = await fetch(output.href, { method: 'GET', redirect: 'manual', signal, headers: { 'accept': 'application/json' } });
      }
      await requireRelaySuccess(response);
    },
  };
}

export function createBrevoMailer(config) {
  return {
    async sendOtp({ email, fullName, code }) {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': config.brevoApiKey },
        body: JSON.stringify({ sender: { name: config.senderName, email: config.senderEmail }, to: [{ email, name: fullName }],
          subject: 'Mã xác thực đăng nhập Chấm công',
          textContent: `Xin chào ${fullName},\n\nMã xác thực của bạn là: ${code}\nMã có hiệu lực trong 10 phút và chỉ dùng một lần. Không chia sẻ mã với bất kỳ ai.\nNếu bạn không yêu cầu mã, hãy bỏ qua email này.\n\nChấm công Nguyễn Hoài Nam` }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Email provider rejected request.'); }
      await response.body?.cancel();
    },
  };
}
