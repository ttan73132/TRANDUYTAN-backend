import { z, id, parse } from './validation.js';
import { fail } from './security.js';

export const criticalFactSchema = z.object({ id, kind: z.enum(['equipment','quantity','deadline']),
  label: z.string().trim().min(1).max(80), value: z.string().min(1).max(80) }).strict();
const answerSchema = z.array(z.object({ factId: id, value: z.string().min(1).max(80) }).strict()).max(3);
function normalize(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{Dash_Punctuation}\u2212]/gu, '-')
    .replace(/\s+/gu, ' ').replace(/\s*-\s*/gu, '-').trim();
}
export function canonicalFactValue(kind, value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const text = normalize(value);
  if (kind === 'equipment') return text.length >= 2 && text.length <= 40 && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(text) ? text : null;
  if (kind === 'quantity') {
    if (!/^\d{1,9}(?:[.,]\d{1,3})?$/.test(text)) return null;
    const [integer, fraction = ''] = text.replace(',', '.').split('.');
    const whole = integer.replace(/^0+(?=\d)/, ''), decimal = fraction.replace(/0+$/, '');
    return whole + (decimal ? '.' + decimal : '');
  }
  if (kind === 'deadline') {
    const match = /^(?:(\d{4})-(\d{2})-(\d{2}) )?(\d{2}):(\d{2})$/.exec(text);
    if (!match || Number(match[4]) > 23 || Number(match[5]) > 59) return null;
    if (match[1]) {
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1) return null;
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    }
    return text;
  }
  return null;
}
function tokenBoundary(text, start, end) {
  const before = text[start - 1] ?? '', after = text[end] ?? '';
  if (/[\p{L}\p{N}_:/+\-]/u.test(before) || /[\p{L}\p{N}_:/+\-]/u.test(after)) return false;
  // A sentence-ending dot/comma is a separator; an embedded dotted/numeric
  // continuation is not. Match full candidates before comparing, never prefixes.
  if (/[.,]/.test(before) && /[\p{L}\p{N}]/u.test(text[start - 2] ?? '')) return false;
  if (/[.,]/.test(after) && /[\p{L}\p{N}]/u.test(text[end + 1] ?? '')) return false;
  return true;
}
function anchored(fact, rawText) {
  const text = normalize(rawText);
  const pattern = fact.kind === 'equipment' ? /[a-z0-9]+(?:[-_][a-z0-9]+)*/g
    : fact.kind === 'quantity' ? /[+-]?\d+(?:[.,]\d+)?/g
      : /(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}/g;
  for (const match of text.matchAll(pattern)) {
    if (tokenBoundary(text, match.index, match.index + match[0].length) && canonicalFactValue(fact.kind, match[0]) === fact.value) return true;
  }
  return false;
}
export function validateCriticalFacts(input, { originalText = '', translatedText = '', required = false, requireAnchors = false } = {}) {
  const facts = parse(z.array(criticalFactSchema).max(3), input);
  if (required && facts.length === 0) fail(422, 'CRITICAL_FACTS_REQUIRED', 'Cần thêm từ 1 đến 3 thông tin quan trọng trước khi gửi hoặc xác nhận bàn giao.');
  const ids = new Set(), values = new Set();
  const normalized = facts.map(fact => {
    const value = canonicalFactValue(fact.kind, fact.value);
    if (value === null) fail(422, 'CRITICAL_FACT_VALUE_INVALID', 'Giá trị mã thiết bị, số lượng hoặc hạn chót chưa đúng định dạng.', { factId: fact.id, kind: fact.kind });
    const key = `${fact.kind}:${value}`;
    if (ids.has(fact.id) || values.has(key)) fail(422, 'CRITICAL_FACT_DUPLICATE', 'Thông tin quan trọng bị trùng ID hoặc trùng loại và giá trị chuẩn hóa.');
    ids.add(fact.id); values.add(key);
    return { ...fact, value };
  });
  if (requireAnchors) for (const fact of normalized) {
    const fields = ['originalText','translatedText'].filter(field => !anchored(fact, field === 'originalText' ? originalText : translatedText));
    if (fields.length) fail(422, 'CRITICAL_FACT_NOT_ANCHORED', 'Mỗi thông tin quan trọng phải xuất hiện đầy đủ trong cả văn bản gốc và bản dịch.', { factId: fact.id, fields });
  }
  return normalized;
}
export function verifyFactAnswers(facts, input) {
  if (input === undefined) fail(422, 'FACT_ANSWERS_REQUIRED', 'Người nhận cần nhập lại tất cả thông tin quan trọng để xác nhận.');
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success || parsed.data.length !== facts.length || new Set(parsed.data.map(answer => answer.factId)).size !== facts.length
    || parsed.data.some(answer => !facts.some(fact => fact.id === answer.factId))) fail(422, 'FACT_ANSWERS_INVALID', 'Câu trả lời phải đúng và đủ ID của thông tin quan trọng hiện tại, không trùng hoặc thêm mục.');
  const mismatches = facts.filter(fact => canonicalFactValue(fact.kind, parsed.data.find(answer => answer.factId === fact.id).value) !== fact.value);
  if (mismatches.length) fail(422, 'FACT_ANSWER_MISMATCH', 'Giá trị nhập lại chưa khớp thông tin quan trọng. Hãy đối chiếu bản gốc và bản dịch.', { factIds: mismatches.map(fact => fact.id) });
  return facts.map(fact => ({ factId: fact.id, value: fact.value }));
}
