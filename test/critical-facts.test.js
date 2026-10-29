import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalFactValue, validateCriticalFacts, verifyFactAnswers } from '../src/critical-facts.js';

const fact = (kind, value) => ({ id: randomUUID(), kind, label: 'Thông tin cần kiểm tra', value });
test('critical fact normalization is bounded and deterministic across fullwidth, case, hyphens and decimals', () => {
  assert.equal(canonicalFactValue('equipment', ' ＥＱ — １２ '), 'eq-12');
  assert.equal(canonicalFactValue('equipment', 'EQ_12'), 'eq_12');
  assert.equal(canonicalFactValue('quantity', '１２,５０'), '12.5');
  assert.equal(canonicalFactValue('quantity', '0012.000'), '12');
  assert.equal(canonicalFactValue('quantity', '1,000'), '1');
  for (const value of ['-12','12 kg','12.1234','1234567890','1,234.5']) assert.equal(canonicalFactValue('quantity', value), null);
  assert.equal(canonicalFactValue('deadline', '２０２８－０２－２９　１７：３０'), '2028-02-29 17:30');
  for (const value of ['2026-02-29 17:30','2026-13-01 12:00','24:00','7:30','17h30','29/10/2026 17:30']) assert.equal(canonicalFactValue('deadline', value), null);
});
test('submitted facts require complete canonical anchors in both original and translated text', () => {
  const facts = [fact('equipment','EQ-12'),fact('quantity','12.50'),fact('deadline','2026-10-29 17:30')];
  const result = validateCriticalFacts(facts, { originalText: 'Máy EQ–12, số lượng １２,５０, hạn 2026-10-29 17:30.', translatedText: 'Equipment eq-12; quantity 12.5; deadline 2026-10-29 17:30.', required: true, requireAnchors: true });
  assert.deepEqual(result.map(item=>item.value), ['eq-12','12.5','2026-10-29 17:30']);
  for (const wrong of ['112','EQ12','12.5','-12','12:30','12/10']) assert.throws(() => validateCriticalFacts([fact('quantity','12')], { originalText: wrong, translatedText: 'Quantity 12', required: true, requireAnchors: true }), error => error.code === 'CRITICAL_FACT_NOT_ANCHORED');
  assert.throws(() => validateCriticalFacts([fact('equipment','EQ-12')], { originalText: 'EQ-12', translatedText: 'EQ-112', requireAnchors: true }), error => error.code === 'CRITICAL_FACT_NOT_ANCHORED');
  assert.throws(() => validateCriticalFacts([fact('quantity','12')], { originalText: 'Số lượng 12', translatedText: '数量 112 个', requireAnchors: true }), error => error.code === 'CRITICAL_FACT_NOT_ANCHORED');
});
test('drafts allow no facts or unanchored valid facts, but reject duplicate, invalid and oversized fact sets', () => {
  assert.deepEqual(validateCriticalFacts([]), []);
  assert.equal(validateCriticalFacts([fact('quantity','12')]).length, 1);
  assert.throws(()=>validateCriticalFacts([], {required:true}), error=>error.code==='CRITICAL_FACTS_REQUIRED');
  const a=fact('quantity','12');
  assert.throws(()=>validateCriticalFacts([a,{...a,value:'13'}]), error=>error.code==='CRITICAL_FACT_DUPLICATE');
  assert.throws(()=>validateCriticalFacts([a,fact('quantity','１２.０')]), error=>error.code==='CRITICAL_FACT_DUPLICATE');
  assert.throws(()=>validateCriticalFacts([fact('deadline','25:00')]), error=>error.code==='CRITICAL_FACT_VALUE_INVALID');
  assert.throws(()=>validateCriticalFacts([1,2,3,4].map(n=>fact('quantity',String(n)))), error=>error.status===422);
});
test('recipient answers must be the exact complete fact ID set with canonical equality', () => {
  const facts = validateCriticalFacts([fact('equipment','EQ-12'),fact('quantity','12.5')]);
  const valid = [{factId:facts[0].id,value:'ｅｑ－１２'},{factId:facts[1].id,value:'１２,５０'}];
  assert.deepEqual(verifyFactAnswers(facts, valid).map(item=>item.value), ['eq-12','12.5']);
  assert.throws(()=>verifyFactAnswers(facts, undefined), error=>error.code==='FACT_ANSWERS_REQUIRED');
  for (const answers of [[valid[0]],[valid[0],valid[0]],[...valid,{factId:randomUUID(),value:'12'}],[{factId:randomUUID(),value:'12'},valid[1]]]) assert.throws(()=>verifyFactAnswers(facts,answers), error=>error.code==='FACT_ANSWERS_INVALID');
  assert.throws(()=>verifyFactAnswers(facts,[valid[0],{factId:facts[1].id,value:'112.5'}]), error=>error.code==='FACT_ANSWER_MISMATCH');
});
