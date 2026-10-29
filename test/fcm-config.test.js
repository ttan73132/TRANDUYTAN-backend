import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '../src/config.js';
const env = { EMAIL_PROVIDER: 'brevo', JWT_SECRET: 'test-only-jwt-'.repeat(4), OTP_SECRET: 'test-only-otp-'.repeat(4), BREVO_API_KEY: 'test-key', BREVO_SENDER_EMAIL: 'sender@example.test' };
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
const credentials = { type: 'service_account', project_id: 'test-project', client_email: 'messaging@test-project.iam.gserviceaccount.com', private_key: key };
test('FCM is explicitly disabled without optional credentials and rejects partial/mismatched configuration', () => {
  assert.equal(loadConfig(env).fcmEnabled, false);
  assert.throws(() => loadConfig({ ...env, FCM_PROJECT_ID: 'test-project' }));
  assert.throws(() => loadConfig({ ...env, FCM_SERVICE_ACCOUNT_JSON: '{}' }));
  assert.throws(() => loadConfig({ ...env, FCM_PROJECT_ID: 'test-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...credentials, project_id: 'other-project' }) }));
  assert.throws(() => loadConfig({ ...env, FCM_PROJECT_ID: '../unsafe', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials) }));
  assert.throws(() => loadConfig({ ...env, FCM_PROJECT_ID: 'test-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...credentials, private_key: 'not-a-private-key' }) }));
});
test('FCM accepts only service-account identity/key fields and never imports credential-supplied URLs', () => {
  const config = loadConfig({ ...env, FCM_PROJECT_ID: 'test-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...credentials, token_uri: 'https://untrusted.example.test/collect' }) });
  assert.equal(config.fcmEnabled, true); assert.equal(config.fcmProjectId, 'test-project');
  assert.deepEqual(Object.keys(config.fcmCredentials).sort(), ['client_email', 'private_key']);
});
