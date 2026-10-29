import { z } from 'zod';
import { createPrivateKey } from 'node:crypto';

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Thiếu cấu hình ${key}.`);
  return value;
}
export function databaseOptions(env = process.env) {
  const connection = new URL(required(env, 'DATABASE_URL'));
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('DATABASE_URL phải là kết nối PostgreSQL.');
  const tls = env.DATABASE_SSL !== 'false';
  if (!tls && env.NODE_ENV === 'production') throw new Error('Cần bật TLS cho cơ sở dữ liệu production.');
  // Keep one TLS authority: pg URL ssl options otherwise replace the explicit verifier.
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) connection.searchParams.delete(key);
  return { connectionString: connection.toString(), ssl: tls ? { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}) } : false,
    max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 10000, query_timeout: 12000 };
}
export function loadConfig(env = process.env) {
  const jwtSecret = required(env, 'JWT_SECRET'), otpSecret = required(env, 'OTP_SECRET');
  if (jwtSecret.length < 32 || otpSecret.length < 32 || jwtSecret === otpSecret) throw new Error('JWT_SECRET và OTP_SECRET cần khác nhau và dài ít nhất 32 ký tự.');
  const emailProvider = env.EMAIL_PROVIDER?.trim() || 'apps_script';
  let mailConfig;
  if (emailProvider === 'apps_script') {
    const otpRelayUrl = validateAppsScriptUrl(required(env, 'OTP_RELAY_URL'));
    const otpRelaySecret = required(env, 'OTP_RELAY_SECRET');
    if (otpRelaySecret.length < 32 || otpRelaySecret === jwtSecret || otpRelaySecret === otpSecret) throw new Error('OTP_RELAY_SECRET cần là khóa riêng dài ít nhất 32 ký tự.');
    mailConfig = { otpRelayUrl, otpRelaySecret };
  } else if (emailProvider === 'brevo') {
    const senderEmail = required(env, 'BREVO_SENDER_EMAIL');
    if (!z.email().safeParse(senderEmail).success) throw new Error('BREVO_SENDER_EMAIL chưa hợp lệ.');
    mailConfig = { senderEmail, senderName: env.BREVO_SENDER_NAME?.trim() || 'Chấm công Nguyễn Hoài Nam', brevoApiKey: required(env, 'BREVO_API_KEY') };
  } else throw new Error('EMAIL_PROVIDER chỉ nhận apps_script hoặc brevo.');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT chưa hợp lệ.');
  const timeZone = env.APP_TIME_ZONE?.trim() || 'Asia/Bangkok';
  try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); }
  catch { throw new Error('APP_TIME_ZONE chưa hợp lệ.'); }
  return { jwtSecret, otpSecret, emailProvider, ...mailConfig, ...fcmConfig(env), issuer: 'attendance-api', audience: 'attendance-app',
    trustProxy: env.TRUST_PROXY === 'true', timeZone, port };
}
function fcmConfig(env) {
  const project = env.FCM_PROJECT_ID?.trim(), json = env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!project && !json) return { fcmEnabled: false, fcmProjectId: null };
  try {
    if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !json || json.length > 32768) throw new Error();
    const credential = JSON.parse(json);
    if (credential.type !== 'service_account' || credential.project_id !== project
      || typeof credential.client_email !== 'string' || !/^[A-Za-z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(credential.client_email)
      || typeof credential.private_key !== 'string' || createPrivateKey(credential.private_key).asymmetricKeyType !== 'rsa') throw new Error();
    return { fcmEnabled: true, fcmProjectId: project, fcmCredentials: { client_email: credential.client_email, private_key: credential.private_key } };
  } catch { throw new Error('Cấu hình FCM_PROJECT_ID/FCM_SERVICE_ACCOUNT_JSON chưa hợp lệ hoặc không cùng dự án.'); }
}
export function validateAppsScriptUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)) throw new Error('OTP_RELAY_URL phải đúng dạng https://script.google.com/macros/s/<deployment>/exec, không query, fragment, port hoặc thông tin đăng nhập.');
  return value;
}
