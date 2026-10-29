import { z } from 'zod';

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
  const senderEmail = required(env, 'BREVO_SENDER_EMAIL');
  if (!z.email().safeParse(senderEmail).success) throw new Error('BREVO_SENDER_EMAIL chưa hợp lệ.');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT chưa hợp lệ.');
  const timeZone = env.APP_TIME_ZONE?.trim() || 'Asia/Bangkok';
  try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()); }
  catch { throw new Error('APP_TIME_ZONE chưa hợp lệ.'); }
  return { jwtSecret, otpSecret, senderEmail, senderName: env.BREVO_SENDER_NAME?.trim() || 'Chấm công Nguyễn Hoài Nam',
    brevoApiKey: required(env, 'BREVO_API_KEY'), issuer: 'attendance-api', audience: 'attendance-app',
    trustProxy: env.TRUST_PROXY === 'true', timeZone, port };
}
