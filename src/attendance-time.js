import { z } from 'zod';

export const DEFAULT_TIME_POLICY = Object.freeze({ checkInEarlyMinutes: 30, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10, checkOutLateMinutes: 120 });
const minutes = z.number().int().min(0).max(1440);
export const timePolicySchema = z.object({ checkInEarlyMinutes: minutes, lateGraceMinutes: minutes, earlyLeaveGraceMinutes: minutes, checkOutLateMinutes: minutes }).strict();
const minuteMs = 60000;
export function policyOf(shift) { return timePolicySchema.parse(shift.time_policy_snapshot); }
export function punchWindow(shift) {
  const policy = policyOf(shift), start = new Date(shift.starts_at).getTime(), end = new Date(shift.ends_at).getTime();
  return { checkInOpensAt: new Date(start - policy.checkInEarlyMinutes * minuteMs).toISOString(), checkInClosesAt: new Date(end).toISOString(), checkOutClosesAt: new Date(end + policy.checkOutLateMinutes * minuteMs).toISOString() };
}
export function timingOf(shift, attendance, time) {
  const policy = policyOf(shift), window = punchWindow(shift);
  const start = new Date(shift.starts_at).getTime(), end = new Date(shift.ends_at).getTime();
  const value = key => attendance?.[key] == null ? null : new Date(attendance[key]).getTime();
  const checkIn = value('check_in_at'), checkOut = value('check_out_at');
  const recordedIn = value('recorded_check_in_at'), recordedOut = value('recorded_check_out_at');
  const current = time.getTime();
  const missingCheckOut = checkIn !== null && checkOut === null && current > new Date(window.checkOutClosesAt).getTime();
  const state = checkOut !== null ? 'completed' : checkIn !== null ? (missingCheckOut ? 'missing_check_out' : 'in_progress')
    : current < new Date(window.checkInOpensAt).getTime() ? 'upcoming' : current > end ? 'missing_check_in' : 'not_checked_in';
  return { late: checkIn !== null && checkIn > start + policy.lateGraceMinutes * minuteMs,
    earlyLeave: checkOut !== null && checkOut < end - policy.earlyLeaveGraceMinutes * minuteMs,
    arrivalDelayMinutes: checkIn === null ? 0 : Math.max(0, (checkIn - start) / minuteMs),
    earlyLeaveMinutes: checkOut === null ? 0 : Math.max(0, (end - checkOut) / minuteMs),
    rawSpanMinutes: checkIn === null || checkOut === null ? null : (checkOut - checkIn) / minuteMs,
    recordedSpanMinutes: recordedIn === null || recordedOut === null ? null : (recordedOut - recordedIn) / minuteMs,
    missingCheckOut, state };
}
export function createLocalClock(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function parts(value) { return Object.fromEntries(formatter.formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value])); }
  return {
    date(value) { const p = parts(value); return `${p.year}-${p.month}-${p.day}`; },
    timestamp(value) { if (value == null) return null; const p = parts(value); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; },
  };
}
