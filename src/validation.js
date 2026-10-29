import { z } from 'zod';
import { fail } from './security.js';
export { z };
export const id = z.uuid();
export const name = z.string().trim().min(2).max(100);
export const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.]{2,31}$/);
export const email = z.email().trim().toLowerCase().max(254);
export const password = z.string().min(10).max(128);
export const role = z.enum(['admin','manager','employee']);
export const status = z.enum(['pending','active','suspended']);
export const isoDate = z.iso.datetime({ offset: true });
export const coordinates = { latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracyMeters: z.number().finite().min(0).max(100) };
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) fail(422, 'VALIDATION_ERROR', 'Vui lòng kiểm tra dữ liệu đã nhập.', result.error.issues.map(x => ({ field: x.path.join('.'), message: x.message })));
  return result.data;
}
export function routeId(req) { return parse(id, req.params.id); }
export function nonemptyPatch(schema, body) {
  const result = parse(schema.partial().strict(), body);
  if (!Object.keys(result).length) fail(422, 'EMPTY_UPDATE', 'Chưa có nội dung cần cập nhật.');
  return result;
}
