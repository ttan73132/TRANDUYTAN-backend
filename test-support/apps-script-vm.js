import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';

const source = await readFile(new URL('../tool/apps-script/Code.gs', import.meta.url), 'utf8');
export const testRelaySecret = 'test-only-relay-secret-never-used-for-production-0123456789';
export function signedEnvelope(payload, secret = testRelaySecret) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { payload: text, signature: createHmac('sha256', secret).update(text, 'utf8').digest('hex') };
}
export function newPayload(time, extra = {}) {
  return { to: 'recipient@example.test', code: '123456', purpose: 'login', issuedAt: time, nonce: randomUUID(), ttlMinutes: 10, ...extra };
}
export function relayRuntime({ time = Date.now(), quota = 100, failSend = false, lockAvailable = true, store = new Map([['OTP_RELAY_SECRET', testRelaySecret]]) } = {}) {
  let clock = time, remaining = quota, failure = failSend, locked = false;
  const sent = [];
  class RelayDate extends Date { static now() { return clock; } }
  const properties = {
    getProperty(key) { return store.get(key) ?? null; },
    setProperty(key, value) { store.set(key, String(value)); return properties; },
    getProperties() { return Object.fromEntries(store); },
    deleteProperty(key) { store.delete(key); return properties; },
  };
  const context = vm.createContext({
    Date: RelayDate,
    PropertiesService: { getScriptProperties() { return properties; } },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      newBlob(text) { return { getBytes() { return Array.from(Buffer.from(text, 'utf8')); } }; },
      computeHmacSha256Signature(text, secret) { return Array.from(createHmac('sha256', secret).update(text, 'utf8').digest(), byte => byte > 127 ? byte - 256 : byte); },
    },
    LockService: { getScriptLock() { return {
      tryLock() { if (!lockAvailable || locked) return false; locked = true; return true; },
      releaseLock() { locked = false; },
    }; } },
    MailApp: {
      getRemainingDailyQuota() { return remaining; },
      sendEmail(message) { if (failure) throw new Error('provider failure includes recipient but must never escape'); sent.push(JSON.parse(JSON.stringify(message))); remaining--; },
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput(text) { return { getContent() { return text; }, setMimeType() { return this; } }; } },
  });
  vm.runInContext(source, context, { filename: 'Code.gs', timeout: 1000 });
  function event(envelope) { const contents = JSON.stringify(envelope); return { postData: { type: 'application/json', contents, length: Buffer.byteLength(contents) } }; }
  return {
    time, sent, store,
    invoke(envelope) { return JSON.parse(context.doPost(event(envelope)).getContent()); },
    postEvent(value) { return JSON.parse(context.doPost(value).getContent()); },
    get() { return JSON.parse(context.doGet().getContent()); },
    setQuota(value) { remaining = value; },
    setFailure(value) { failure = value; },
    setTime(value) { clock = value; },
  };
}
