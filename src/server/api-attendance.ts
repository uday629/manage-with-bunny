// Attendance: the boss / HR sets office hours; people check in from the office network.
// A working day without a check-in becomes "absent". All times come from the host's clock (members cannot fake them).
import { Router, bad, forbidden, notFound, str, optStr, id as vid, optId, type AuthUser } from './http';
import { S, audit, ancestors, descendants, isActive, isRemote, caretakerOf, canActFor, rolePerms } from './core';
import { allActive } from './api-auth';
import { now } from './db';

export const ATT_STATUS = ['present', 'late', 'half', 'leave', 'absent', 'holiday'] as const;
type AttStatus = (typeof ATT_STATUS)[number];
export interface AttSettings { start: string; end: string; grace: number; days: number[]; holidays: { day: string; name: string }[] }
const DEFAULTS: AttSettings = { start: '09:00', end: '18:00', grace: 15, days: [6, 0, 1, 2, 3, 4], holidays: [] }; // Sat-Thu (Friday off)

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Real calendar date only (rejects 2027-02-31, which JavaScript would roll over). */
export const validDay = (d: string) => DAY_RE.test(d) && ymd(new Date(d + 'T12:00:00')) === d;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const dayOfWeek = (day: string) => new Date(day + 'T12:00:00').getDay();

export function attSettings(): AttSettings {
  try { return { ...DEFAULTS, ...JSON.parse(S.db.meta('attendance') || '{}') }; } catch { return DEFAULTS; }
}

// Who may see someone's attendance: themselves, people above them, their caretaker, and attendance managers.
function canSee(u: AuthUser, target: string) {
  return target === u.id || u.perms.has('attendance.manage') || u.perms.has('analytics.view_all') || descendants(u.id).has(target) || (isRemote(target) && caretakerOf(target) === u.id);
}
function visibleIds(u: AuthUser): string[] {
  return allActive().filter((id) => canSee(u, id));
}

export function statusFor(day: string, rec: any, joinedDay: string, st: AttSettings, today: string, nowMin: number): string {
  if (day < joinedDay) return 'na';
  if (rec) return rec.status;
  if (st.holidays.some((h) => h.day === day)) return 'holiday';
  if (!st.days.includes(dayOfWeek(day))) return 'off';
  if (day > today) return 'future';
  if (day === today) return nowMin >= minutes(st.end) ? 'absent' : 'pending';
  return 'absent';
}

function notifyAttendance(userId: string) {
  const to = new Set<string>([userId, ...ancestors(userId)]);
  const ct = caretakerOf(userId); if (ct) to.add(ct);
  for (const r of S.db.all<{ id: string; is_owner: number; role_id: string }>("SELECT id, is_owner, role_id FROM users WHERE status='active'")) {
    const p = rolePerms(r as any);
    if (p.has('attendance.manage') || p.has('analytics.view_all')) to.add(r.id);
  }
  S.hub.send(to, { t: 'attendance', userId });
}

export function registerAttendance(r: Router) {
  r.get('/api/attendance/settings', () => ({ ...attSettings(), today: ymd(new Date()), serverTime: now() }));

  r.put('/api/attendance/settings', (c) => {
    const b = c.body;
    const start = str(b.start, 'Office start', 5, 5); const end = str(b.end, 'Office end', 5, 5);
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw bad('Use 24-hour times like 09:00.');
    if (minutes(end) <= minutes(start)) throw bad('Office end must be after office start.');
    const grace = Number(b.grace);
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw bad('Late after must be 0-240 minutes.');
    if (!Array.isArray(b.days) || b.days.length > 7) throw bad('Invalid working days.');
    const days = [...new Set((b.days as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
    if (!Array.isArray(b.holidays) || b.holidays.length > 400) throw bad('Invalid holidays.');
    const holidays = (b.holidays as any[]).map((h) => ({ day: String(h?.day || ''), name: optStr(h?.name, 'Holiday name', 60) })).filter((h) => validDay(h.day));
    S.db.setMeta('attendance', JSON.stringify({ start, end, grace, days, holidays }));
    audit(c.user.id, 'attendance.settings', '', `${start}-${end} grace=${grace} days=${days.join(',')}`, c.ip);
    S.hub.send(allActive(), { t: 'attendance', userId: '' });
    return { ok: true };
  }, { perm: 'attendance.manage' });

  // Check in / out. Remote profiles can be checked in by their caretaker (or an admin).
  r.post('/api/attendance/check-in', (c) => {
    const target = optId(c.body.userId, 'person') || c.user.id;
    if (target !== c.user.id && !canActFor(c.user, target) && !c.user.perms.has('attendance.manage')) throw forbidden('You can only check yourself in.');
    if (!isActive(target)) throw notFound('Member not found.');
    const d = new Date(); const day = ymd(d); const st = attSettings();
    const existing = S.db.get('SELECT * FROM attendance WHERE user_id=? AND day=?', target, day);
    if (existing?.check_in) return { day, status: existing.status, checkIn: existing.check_in, checkOut: existing.check_out };
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const extraDay = !st.days.includes(d.getDay()) || st.holidays.some((h) => h.day === day);
    const status: AttStatus = !extraDay && nowMin > minutes(st.start) + st.grace ? 'late' : 'present';
    const ts = now();
    S.db.run(`INSERT INTO attendance(user_id,day,status,check_in,note,set_by,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,day) DO UPDATE SET status=excluded.status, check_in=excluded.check_in, set_by=excluded.set_by, updated_at=excluded.updated_at`,
      target, day, status, ts, [extraDay ? 'Extra day' : '', target !== c.user.id ? `Checked in by ${c.user.displayName}` : ''].filter(Boolean).join(' · '), c.user.id, ts);
    notifyAttendance(target);
    return { day, status, checkIn: ts, checkOut: null };
  }, { rate: { key: 'att', max: 60, windowMs: 60000 } });

  r.post('/api/attendance/check-out', (c) => {
    const target = optId(c.body.userId, 'person') || c.user.id;
    if (target !== c.user.id && !canActFor(c.user, target) && !c.user.perms.has('attendance.manage')) throw forbidden('You can only check yourself out.');
    const day = ymd(new Date());
    const rec = S.db.get('SELECT * FROM attendance WHERE user_id=? AND day=?', target, day);
    if (!rec?.check_in) throw bad('Check in first.');
    S.db.run('UPDATE attendance SET check_out=?, updated_at=? WHERE user_id=? AND day=?', now(), now(), target, day);
    notifyAttendance(target);
    return { ok: true };
  }, { rate: { key: 'att', max: 60, windowMs: 60000 } });

  // Corrections by HR / boss: mark leave, half day, absent, present, holiday, or clear back to automatic.
  r.put('/api/attendance/:userId/:day', (c) => {
    const target = vid(c.params.userId, 'person');
    const day = String(c.params.day);
    if (!validDay(day)) throw bad('Invalid date.');
    if (!c.user.perms.has('attendance.manage')) throw forbidden('Only people who manage attendance can change it.');
    if (!S.db.get("SELECT 1 FROM users WHERE id=? AND status IN ('active','disabled')", target)) throw notFound('Member not found.');
    const note = optStr(c.body.note, 'Note', 300);
    if (c.body.status === 'auto') {
      const rec = S.db.get('SELECT check_in FROM attendance WHERE user_id=? AND day=?', target, day);
      if (rec?.check_in) {
        const st = attSettings(); const t = new Date(rec.check_in);
        const s: AttStatus = t.getHours() * 60 + t.getMinutes() > minutes(st.start) + st.grace && st.days.includes(t.getDay()) && !st.holidays.some((h) => h.day === day) ? 'late' : 'present';
        S.db.run("UPDATE attendance SET status=?, note='', set_by=?, updated_at=? WHERE user_id=? AND day=?", s, c.user.id, now(), target, day);
      } else S.db.run('DELETE FROM attendance WHERE user_id=? AND day=?', target, day);
    } else {
      const status = c.body.status as AttStatus;
      if (!ATT_STATUS.includes(status)) throw bad('Invalid status.');
      S.db.run(`INSERT INTO attendance(user_id,day,status,note,set_by,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,day) DO UPDATE SET status=excluded.status, note=excluded.note, set_by=excluded.set_by, updated_at=excluded.updated_at`, target, day, status, note, c.user.id, now());
    }
    audit(c.user.id, 'attendance.edit', target, `${day} ${c.body.status}`, c.ip);
    notifyAttendance(target);
    return { ok: true };
  });

  // Sheet for a date range: one row per person, one cell per day, plus totals.
  r.get('/api/attendance', (c) => {
    const from = String(c.url.searchParams.get('from') || ''); const to = String(c.url.searchParams.get('to') || '');
    if (!validDay(from) || !validDay(to) || to < from) throw bad('Invalid date range.');
    const span = (new Date(to + 'T12:00:00').getTime() - new Date(from + 'T12:00:00').getTime()) / 86400000;
    if (span > 370) throw bad('Pick up to one year.');
    const only = optId(c.url.searchParams.get('userId'), 'person');
    if (only && !canSee(c.user, only)) throw notFound('Member not found.');
    const ids = only ? [only] : visibleIds(c.user);
    const st = attSettings(); const nowD = new Date(); const today = ymd(nowD); const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
    const days: { day: string; working: boolean; holiday: string | null }[] = [];
    for (let t = new Date(from + 'T12:00:00'); ymd(t) <= to; t = new Date(t.getTime() + 86400000)) {
      const day = ymd(t);
      days.push({ day, working: st.days.includes(t.getDay()), holiday: st.holidays.find((h) => h.day === day)?.name ?? null });
    }
    const people = ids.map((id) => {
      const u = S.db.get('SELECT created_at, approved_at FROM users WHERE id=?', id)!;
      const joined = ymd(new Date(u.approved_at || u.created_at));
      const recs = new Map(S.db.all('SELECT * FROM attendance WHERE user_id=? AND day>=? AND day<=?', id, from, to).map((x) => [x.day, x]));
      const cells: Record<string, { s: string; in: number | null; out: number | null; note: string }> = {};
      const sum = { present: 0, late: 0, half: 0, leave: 0, absent: 0, holiday: 0, workingDays: 0, rate: null as number | null };
      for (const d of days) {
        const rec = recs.get(d.day);
        const s = statusFor(d.day, rec, joined, st, today, nowMin);
        cells[d.day] = { s, in: rec?.check_in ?? null, out: rec?.check_out ?? null, note: rec?.note || '' };
        if (s in sum) (sum as any)[s]++;
        if (['present', 'late', 'half', 'absent', 'leave'].includes(s)) sum.workingDays++;
      }
      const counted = sum.workingDays - sum.leave;
      sum.rate = counted > 0 ? Math.round(((sum.present + sum.late + sum.half * 0.5) / counted) * 100) : null;
      return { userId: id, cells, summary: sum };
    });
    return { from, to, today, settings: st, days, people, canManage: c.user.perms.has('attendance.manage') };
  });
}
