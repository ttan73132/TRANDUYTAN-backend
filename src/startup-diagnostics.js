const stages = new Set(['config','database_options','migrations','bootstrap','application','listen']);
const codes = new Set([
  '28P01','28000','3D000','42501','53300','57P03','57014','42P01','42703','42710','23505',
  'ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH',
  'ERR_INVALID_URL','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER','ERR_DLOPEN_FAILED','EADDRINUSE','EACCES','VALIDATION_ERROR',
]);
const configKeys = ['JWT_SECRET','OTP_SECRET','OTP_RELAY_URL','OTP_RELAY_SECRET','BREVO_SENDER_EMAIL','BREVO_API_KEY','DATABASE_URL'];

// Never return error.message, stack, details, config values or arbitrary codes.
// Known local messages are compared in full and converted to fixed identifiers.
export function startupDiagnostic(stage, error) {
  const safeStage = stages.has(stage) ? stage : 'unknown';
  const candidates = [error?.code, error?.cause?.code, ...(Array.isArray(error?.errors) ? error.errors.slice(0, 8).map(item => item?.code) : [])];
  let code = candidates.find(candidate => codes.has(candidate));
  if (!code && stage === 'migrations' && error?.message === 'Migration đã áp dụng bị thay đổi. Hãy bổ sung migration mới.') code = 'MIGRATION_CHECKSUM_MISMATCH';
  if (!code && ['config','database_options'].includes(stage)) {
    const missing = configKeys.find(key => error?.message === `Thiếu cấu hình ${key}.`);
    code = missing ? `CONFIG_MISSING_${missing}` : 'CONFIG_INVALID';
  }
  return { stage: safeStage, code: code ?? 'UNKNOWN' };
}
