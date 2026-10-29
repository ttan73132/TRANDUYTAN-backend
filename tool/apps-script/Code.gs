// No account address, OTP, or secret is embedded in this source.
// Set OTP_RELAY_SECRET in Project Settings > Script properties.
const OTP_RELAY_MAX_BODY_BYTES = 4096;
const OTP_RELAY_MAX_PAYLOAD_BYTES = 2048;
const OTP_RELAY_FRESHNESS_MS = 120000;
const OTP_RELAY_NONCE_LIFETIME_MS = 300000;
const OTP_RELAY_MAX_NONCES = 256;
const OTP_RELAY_MAX_PER_MINUTE = 20;
const OTP_RELAY_NONCE_PREFIX = 'OTP_RELAY_NONCE_';

function relayResponse_(ok) {
  return ContentService.createTextOutput(JSON.stringify({ ok: ok === true })).setMimeType(ContentService.MimeType.JSON);
}
function exactKeys_(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
}
function utf8Size_(value) { return Utilities.newBlob(value).getBytes().length; }
function signatureHex_(payload, secret) {
  return Utilities.computeHmacSha256Signature(payload, secret, Utilities.Charset.UTF_8).map(function (byte) {
    return ('0' + (byte & 255).toString(16)).slice(-2);
  }).join('');
}
function sameSignature_(expected, actual) {
  // Both strings have already been constrained to 64 hexadecimal characters.
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}
function validPayload_(value, now) {
  if (!exactKeys_(value, ['to','code','purpose','issuedAt','nonce','ttlMinutes'])) return false;
  if (typeof value.to !== 'string' || value.to.length > 254 || !/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value.to) || value.to.indexOf('..') !== -1) return false;
  if (typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) return false;
  if (['register','login','face_login'].indexOf(value.purpose) === -1) return false;
  if (!Number.isSafeInteger(value.issuedAt) || Math.abs(now - value.issuedAt) > OTP_RELAY_FRESHNESS_MS) return false;
  if (typeof value.nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.nonce)) return false;
  return Number.isInteger(value.ttlMinutes) && value.ttlMinutes >= 1 && value.ttlMinutes <= 10;
}
function doGet() { return relayResponse_(false); }
// Run manually as the owner once to review/authorize the send_mail scope.
// This checks quota and does not send email or read any Gmail message.
function authorizeRelayOwner() { MailApp.getRemainingDailyQuota(); }
function doPost(event) {
  let lock = null;
  let acquired = false;
  try {
    const post = event && event.postData;
    if (!post || typeof post.contents !== 'string' || typeof post.type !== 'string' || post.type.toLowerCase().split(';')[0].trim() !== 'application/json' || event.queryString) return relayResponse_(false);
    if (post.contents.length > OTP_RELAY_MAX_BODY_BYTES || utf8Size_(post.contents) > OTP_RELAY_MAX_BODY_BYTES) return relayResponse_(false);
    const envelope = JSON.parse(post.contents);
    if (!exactKeys_(envelope, ['payload','signature']) || typeof envelope.payload !== 'string' || utf8Size_(envelope.payload) > OTP_RELAY_MAX_PAYLOAD_BYTES || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) return relayResponse_(false);
    const properties = PropertiesService.getScriptProperties();
    const configuredSecret = properties.getProperty('OTP_RELAY_SECRET');
    const secret = typeof configuredSecret === 'string' ? configuredSecret.trim() : '';
    if (secret.length < 32 || !sameSignature_(signatureHex_(envelope.payload, secret), envelope.signature)) return relayResponse_(false);
    const now = Date.now();
    const payload = JSON.parse(envelope.payload);
    if (!validPayload_(payload, now)) return relayResponse_(false);

    lock = LockService.getScriptLock();
    acquired = lock.tryLock(5000);
    if (!acquired) return relayResponse_(false);
    const stored = properties.getProperties();
    let activeNonces = 0;
    Object.keys(stored).forEach(function (key) {
      if (key.indexOf(OTP_RELAY_NONCE_PREFIX) !== 0) return;
      const expiresAt = Number(stored[key]);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) properties.deleteProperty(key);
      else activeNonces++;
    });
    const nonceKey = OTP_RELAY_NONCE_PREFIX + payload.nonce.toLowerCase();
    if (properties.getProperty(nonceKey) !== null || activeNonces >= OTP_RELAY_MAX_NONCES) return relayResponse_(false);
    // Persist consumption before quota checks or MailApp. A failed send is never replayed.
    properties.setProperty(nonceKey, String(now + OTP_RELAY_NONCE_LIFETIME_MS));
    const minute = String(Math.floor(now / 60000));
    const currentCount = properties.getProperty('OTP_RELAY_RATE_MINUTE') === minute ? Number(properties.getProperty('OTP_RELAY_RATE_COUNT') || 0) : 0;
    if (!Number.isFinite(currentCount) || currentCount >= OTP_RELAY_MAX_PER_MINUTE) return relayResponse_(false);
    properties.setProperty('OTP_RELAY_RATE_MINUTE', minute);
    properties.setProperty('OTP_RELAY_RATE_COUNT', String(currentCount + 1));
    const remaining = MailApp.getRemainingDailyQuota();
    if (!Number.isFinite(remaining) || remaining < 1) return relayResponse_(false);
    MailApp.sendEmail({
      to: payload.to,
      subject: 'Mã xác thực Chấm công',
      name: 'Chấm công Nguyễn Hoài Nam',
      body: 'Mã xác thực của bạn là: ' + payload.code + '\n\nMã chỉ dùng một lần, có hiệu lực tối đa ' + payload.ttlMinutes + ' phút. Không chia sẻ mã cho bất kỳ ai.\nNếu bạn không yêu cầu mã này, hãy bỏ qua email.',
    });
    return relayResponse_(true);
  } catch (_error) {
    // Never log provider exceptions: they can contain the recipient or message body.
    return relayResponse_(false);
  } finally {
    if (acquired && lock) lock.releaseLock();
  }
}
