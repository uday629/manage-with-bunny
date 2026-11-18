import { Router, bad, forbidden, notFound, str, optStr, id as vid, optId, int, oneOf, safeUrl, monthRange, monthKey, type AuthUser } from './http';
import { S, audit, canAssignTo, requireTask, taskVisible, ancestors, descendants, analyticsVisible, isActive, isRemote, caretakerOf, canActFor, caredFor } from './core';
import { newId, now } from './db';
import { TASK_PRIORITY, TASK_STATUS } from '../shared/perms';
import { LIMITS } from '../shared/kdf';

const OPEN = ['todo', 'in_progress', 'submitted', 'changes'];

function taskOut(t: any) {
  let links: string[] = [];
  try { links = JSON.parse(t.links); } catch { /* */ }
  return {
    id: t.id, title: t.title, description: t.description, links, assignerId: t.assigner_id, assigneeId: t.assignee_id, parentId: t.parent_id,
    status: t.status, priority: t.priority, dueAt: t.due_at, createdAt: t.created_at, updatedAt: t.updated_at, startedAt: t.started_at,
    submittedAt: t.submitted_at, completedAt: t.completed_at, revisions: t.revisions,
    subtasks: t.sub_n ?? S.db.get<{ n: number }>('SELECT COUNT(*) n FROM tasks WHERE parent_id=?', t.id)!.n,
    files: t.file_n ?? S.db.get<{ n: number }>("SELECT COUNT(*) n FROM files WHERE scope='task' AND scope_id=? AND deleted=0", t.id)!.n,
  };
}

function audience(t: any): string[] {
  const s = new Set<string>();
  for (const id of [t.assigner_id, t.assignee_id]) if (id) { s.add(id); for (const a of ancestors(id)) s.add(a); }
  return [...s];
}
function notifyTask(t: any, actorId: string, title: string, body: string, to: (string | null)[]) {
  S.hub.send(audience(t), { t: 'task', id: t.id });
  // Remote profiles cannot receive notifications; their caretaker gets them instead.
  const targets = [...new Set(to.map((x) => (x && isRemote(x) ? caretakerOf(x) : x)))].filter((x): x is string => !!x && x !== actorId);
  if (targets.length) S.hub.send(targets, { t: 'notify', kind: 'task', id: t.id, title, body });
}

function parseLinks(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LIMITS.maxLinks) throw bad('Invalid links.');
  return v.filter((x) => typeof x === 'string' && x.trim()).map(safeUrl);
}
function parseDue(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  return int(v, 'due date', 946684800000, 4102444800000);
}
function taskFileIds(taskId: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50) throw bad('Invalid attachments.');
  const ids = v.map((x) => vid(x, 'file'));
  for (const f of ids) if (!S.db.get("SELECT 1 FROM files WHERE id=? AND scope='task' AND scope_id=? AND deleted=0", f, taskId)) throw bad('Attachment not found.');
  return ids;
}

function canDecide(u: AuthUser, t: any) {
  if (t.assigner_id === u.id || u.isOwner) return true;
  if ((!t.assigner_id || !isActive(t.assigner_id)) && t.assignee_id && ancestors(t.assignee_id).includes(u.id)) return true;
  return false;
}

function stats(userId: string, start: number, end: number) {
  const g = (sql: string, ...p: unknown[]) => S.db.get<{ n: number }>(sql, ...p)!.n || 0;
  const assigned = g('SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND created_at>=? AND created_at<? AND status<>\'cancelled\'', userId, start, end);
  const completed = g("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status='done' AND completed_at>=? AND completed_at<?", userId, start, end);
  const onTime = g("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status='done' AND completed_at>=? AND completed_at<? AND (due_at IS NULL OR completed_at<=due_at)", userId, start, end);
  const overdue = g(`SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND due_at>=? AND due_at<? AND due_at<? AND (status IN ('todo','in_progress','submitted','changes') OR (status='done' AND completed_at>due_at))`, userId, start, end, now());
  const open = g("SELECT COUNT(*) n FROM tasks WHERE assignee_id=? AND status IN ('todo','in_progress','submitted','changes') AND created_at<?", userId, end);
  const avg = S.db.get<{ a: number | null }>("SELECT AVG(completed_at-created_at) a FROM tasks WHERE assignee_id=? AND status='done' AND completed_at>=? AND completed_at<?", userId, start, end)!.a;
  const revisions = g("SELECT IFNULL(SUM(revisions),0) n FROM tasks WHERE assignee_id=? AND status='done' AND completed_at>=? AND completed_at<?", userId, start, end);
  const ym = new Date(start); const dayPrefix = `${ym.getFullYear()}-${String(ym.getMonth() + 1).padStart(2, '0')}-%`;
  const loggedHours = S.db.get<{ h: number | null }>('SELECT SUM(hours) h FROM worklog WHERE user_id=? AND day LIKE ?', userId, dayPrefix)!.h ?? 0;
  const updates = S.db.get<{ n: number }>('SELECT COUNT(*) n FROM worklog WHERE user_id=? AND day LIKE ?', userId, dayPrefix)!.n;
  const score = assigned + completed === 0 ? null : Math.round(60 * (completed ? onTime / completed : 0) + 40 * Math.min(1, completed / Math.max(assigned, 1)));
  return { loggedHours, updates, assigned, completed, onTime, overdue, open, avgHours: avg ? Math.round(avg / 360000) / 10 : null, revisions, score };
}

export function registerTasks(r: Router) {
  r.get('/api/tasks', (c) => {
    const view = oneOf(c.url.searchParams.get('view') || 'mine', 'view', ['mine', 'assigned', 'team', 'all'] as const);
    const month = c.url.searchParams.get('month');
    const where: string[] = [];
    const p: unknown[] = [];
    if (view === 'mine') { where.push('assignee_id=?'); p.push(c.user.id); }
    else if (view === 'assigned') { where.push('assigner_id=?'); p.push(c.user.id); }
    else if (view === 'team') {
      const ids = [...descendants(c.user.id)];
      if (!ids.length) return [];
      where.push(`assignee_id IN (${ids.map(() => '?').join(',')})`); p.push(...ids);
    }
    if (month) { const [s, e] = monthRange(month); where.push('created_at<? AND (completed_at IS NULL OR completed_at>=?)'); p.push(e, s); }
    const rows = S.db.all(`SELECT t.*, (SELECT COUNT(*) FROM tasks c WHERE c.parent_id=t.id) sub_n, (SELECT COUNT(*) FROM files f WHERE f.scope='task' AND f.scope_id=t.id AND f.deleted=0) file_n
      FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC LIMIT 2000`, ...p);
    return rows.filter((t) => taskVisible(c.user, t as any)).map(taskOut);
  });

  r.post('/api/tasks', (c) => {
    const b = c.body;
    const title = str(b.title, 'Title', 1, LIMITS.title);
    const description = optStr(b.description, 'Description', LIMITS.description, true);
    const assignee = vid(b.assigneeId, 'assignee');
    if (!canAssignTo(c.user, assignee)) throw forbidden('You can assign tasks to yourself and people below you in the team chart.');
    const parentId = optId(b.parentId, 'parent');
    if (parentId) {
      const parent = requireTask(c.user, parentId);
      if (parent.assignee_id !== c.user.id && parent.assigner_id !== c.user.id) throw forbidden('You can only split tasks that are assigned to you or by you.');
    }
    const ts = now();
    const t = {
      id: newId(), title, description, links: JSON.stringify(parseLinks(b.links)), assigner_id: c.user.id, assignee_id: assignee, parent_id: parentId,
      status: 'todo', priority: b.priority ? oneOf(b.priority, 'priority', TASK_PRIORITY) : 'normal', due_at: parseDue(b.dueAt),
    };
    S.db.run('INSERT INTO tasks(id,title,description,links,assigner_id,assignee_id,parent_id,status,priority,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      t.id, t.title, t.description, t.links, t.assigner_id, t.assignee_id, t.parent_id, t.status, t.priority, t.due_at, ts, ts);
    S.db.run("INSERT INTO task_events(task_id,user_id,type,created_at) VALUES(?,?,'created',?)", t.id, c.user.id, ts);
    if (parentId) S.db.run("INSERT INTO task_events(task_id,user_id,type,note,created_at) VALUES(?,?,'delegated',?,?)", parentId, c.user.id, title, ts);
    notifyTask(t, c.user.id, 'New task for you', `${c.user.displayName}: ${title}`, [assignee]);
    return taskOut(S.db.get('SELECT * FROM tasks WHERE id=?', t.id));
  }, { rate: { key: 'task', max: 120, windowMs: 60000 } });

  r.get('/api/tasks/:id', (c) => {
    const t = requireTask(c.user, vid(c.params.id));
    const events = S.db.all('SELECT * FROM task_events WHERE task_id=? ORDER BY id ASC LIMIT 1000', t.id).map((e) => ({ id: e.id, userId: e.user_id, type: e.type, note: e.note, fileIds: JSON.parse(e.file_ids), createdAt: e.created_at, onBehalfOf: e.on_behalf_of }));
    const subtasks = S.db.all('SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at', t.id).filter((x) => taskVisible(c.user, x as any)).map(taskOut);
    const parent = t.parent_id ? S.db.get('SELECT * FROM tasks WHERE id=?', t.parent_id) : null;
    return { task: taskOut(t), events, subtasks, parent: parent && taskVisible(c.user, parent as any) ? taskOut(parent) : null, canDecide: canDecide(c.user, t), canEdit: t.assigner_id === c.user.id || c.user.isOwner, actingFor: t.assignee_id !== c.user.id && canActFor(c.user, t.assignee_id) ? t.assignee_id : null };
  });

  r.patch('/api/tasks/:id', (c) => {
    const t = requireTask(c.user, vid(c.params.id));
    if (t.assigner_id !== c.user.id && !c.user.isOwner) throw forbidden('Only the person who assigned this task can edit it.');
    const b = c.body;
    const changes: string[] = [];
    if (b.title !== undefined) { S.db.run('UPDATE tasks SET title=? WHERE id=?', str(b.title, 'Title', 1, LIMITS.title), t.id); changes.push('title'); }
    if (b.description !== undefined) { S.db.run('UPDATE tasks SET description=? WHERE id=?', optStr(b.description, 'Description', LIMITS.description, true), t.id); changes.push('description'); }
    if (b.links !== undefined) { S.db.run('UPDATE tasks SET links=? WHERE id=?', JSON.stringify(parseLinks(b.links)), t.id); changes.push('links'); }
    if (b.dueAt !== undefined) { S.db.run('UPDATE tasks SET due_at=? WHERE id=?', parseDue(b.dueAt), t.id); changes.push('due date'); }
    if (b.priority !== undefined) { S.db.run('UPDATE tasks SET priority=? WHERE id=?', oneOf(b.priority, 'priority', TASK_PRIORITY), t.id); changes.push('priority'); }
    if (b.assigneeId !== undefined && b.assigneeId !== t.assignee_id) {
      const a = vid(b.assigneeId, 'assignee');
      if (!canAssignTo(c.user, a)) throw forbidden('You cannot assign this task to that person.');
      S.db.run('UPDATE tasks SET assignee_id=? WHERE id=?', a, t.id); changes.push('assignee');
      S.hub.send([a], { t: 'notify', kind: 'task', id: t.id, title: 'Task reassigned to you', body: t.title });
    }
    if (changes.length) {
      S.db.run('UPDATE tasks SET updated_at=? WHERE id=?', now(), t.id);
      S.db.run("INSERT INTO task_events(task_id,user_id,type,note,created_at) VALUES(?,?,'edited',?,?)", t.id, c.user.id, changes.join(', '), now());
    }
    const nt = S.db.get('SELECT * FROM tasks WHERE id=?', t.id)!;
    S.hub.send(audience(nt), { t: 'task', id: t.id });
    return taskOut(nt);
  });

  r.post('/api/tasks/:id/action', (c) => {
    const t = requireTask(c.user, vid(c.params.id));
    const action = oneOf(c.body.action, 'action', ['start', 'submit', 'approve', 'request_changes', 'cancel', 'reopen', 'comment'] as const);
    const note = optStr(c.body.note, 'Note', LIMITS.note, true);
    const fileIds = taskFileIds(t.id, c.body.fileIds);
    const isAssignee = canActFor(c.user, t.assignee_id);
    const onBehalf = isAssignee && t.assignee_id !== c.user.id && (action === 'start' || action === 'submit') ? t.assignee_id : null;
    const ts = now();
    let status = t.status as string;
    const set: string[] = [];
    switch (action) {
      case 'start':
        if (!isAssignee) throw forbidden('Only the assignee can start this task.');
        if (!['todo', 'changes'].includes(status)) throw bad('This task cannot be started now.');
        status = 'in_progress'; set.push(`started_at=IFNULL(started_at,${ts})`); break;
      case 'submit':
        if (!isAssignee) throw forbidden('Only the assignee can submit this task.');
        if (!['todo', 'in_progress', 'changes'].includes(status)) throw bad('This task cannot be submitted now.');
        if (t.assigner_id === c.user.id) { status = 'done'; set.push(`submitted_at=${ts}`, `completed_at=${ts}`); }
        else { status = 'submitted'; set.push(`submitted_at=${ts}`); }
        break;
      case 'approve':
        if (!canDecide(c.user, t)) throw forbidden('Only the person who assigned this task can approve it.');
        if (status !== 'submitted') throw bad('Only submitted work can be approved.');
        status = 'done'; set.push(`completed_at=${ts}`); break;
      case 'request_changes':
        if (!canDecide(c.user, t)) throw forbidden('Only the person who assigned this task can request changes.');
        if (status !== 'submitted') throw bad('Only submitted work can be sent back.');
        if (!note) throw bad('Please explain what needs to change.');
        status = 'changes'; set.push('revisions=revisions+1'); break;
      case 'cancel':
        if (!canDecide(c.user, t)) throw forbidden('Only the person who assigned this task can cancel it.');
        if (status === 'done' || status === 'cancelled') throw bad('This task is already closed.');
        status = 'cancelled'; break;
      case 'reopen':
        if (!canDecide(c.user, t)) throw forbidden('Only the person who assigned this task can reopen it.');
        if (status !== 'done' && status !== 'cancelled') throw bad('This task is not closed.');
        status = 'in_progress'; set.push('completed_at=NULL'); break;
      case 'comment':
        if (!note && !fileIds.length) throw bad('Write a comment or attach a file.');
        break;
    }
    if (!TASK_STATUS.includes(status as any)) throw bad('Invalid status.');
    S.db.tx(() => {
      S.db.run(`UPDATE tasks SET status=?, updated_at=?${set.length ? ', ' + set.join(', ') : ''} WHERE id=?`, status, ts, t.id);
      S.db.run('INSERT INTO task_events(task_id,user_id,type,note,file_ids,created_at,on_behalf_of) VALUES(?,?,?,?,?,?,?)', t.id, c.user.id, action, note, JSON.stringify(fileIds), ts, onBehalf);
    });
    const nt = S.db.get('SELECT * FROM tasks WHERE id=?', t.id)!;
    const labels: Record<string, string> = { start: 'started', submit: status === 'done' ? 'completed' : 'submitted work on', approve: 'approved', request_changes: 'requested changes on', cancel: 'cancelled', reopen: 'reopened', comment: 'commented on' };
    const to = action === 'submit' || action === 'start' ? [t.assigner_id] : action === 'comment' ? [t.assigner_id, t.assignee_id] : [t.assignee_id];
    notifyTask(nt, c.user.id, `${c.user.displayName} ${labels[action]} a task`, t.title, to);
    return taskOut(nt);
  }, { rate: { key: 'taction', max: 200, windowMs: 60000 } });

  r.del('/api/tasks/:id', (c) => {
    const t = requireTask(c.user, vid(c.params.id));
    if (t.assigner_id !== c.user.id && !c.user.isOwner) throw forbidden('Only the person who assigned this task can delete it.');
    S.db.run("UPDATE files SET deleted=1 WHERE scope='task' AND scope_id=?", t.id);
    S.db.run('DELETE FROM tasks WHERE id=?', t.id);
    audit(c.user.id, 'task.deleted', t.id, t.title, c.ip);
    S.hub.send(audience(t), { t: 'task', id: t.id });
    return { ok: true };
  });

  // ---------- dashboard ----------
  r.get('/api/dashboard', (c) => {
    const me = c.user.id;
    const ts = now();
    const mine = S.db.all(`SELECT * FROM tasks WHERE assignee_id=? AND status IN ('todo','in_progress','changes','submitted') ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at LIMIT 50`, me).map(taskOut);
    const review = S.db.all("SELECT * FROM tasks WHERE assigner_id=? AND status='submitted' AND assignee_id<>? ORDER BY submitted_at LIMIT 50", me, me).map(taskOut);
    const team = [...descendants(me)];
    const month = monthKey(ts);
    const [s, e] = monthRange(month);
    const myStats = stats(me, s, e);
    let teamStats = null;
    if (team.length) {
      const ph = team.map(() => '?').join(',');
      const g = (sql: string, ...p: unknown[]) => S.db.get<{ n: number }>(sql, ...p)!.n;
      teamStats = {
        members: team.length,
        open: g(`SELECT COUNT(*) n FROM tasks WHERE assignee_id IN (${ph}) AND status IN ('todo','in_progress','changes','submitted')`, ...team),
        overdue: g(`SELECT COUNT(*) n FROM tasks WHERE assignee_id IN (${ph}) AND status IN ('todo','in_progress','changes','submitted') AND due_at<?`, ...team, ts),
        doneThisMonth: g(`SELECT COUNT(*) n FROM tasks WHERE assignee_id IN (${ph}) AND status='done' AND completed_at>=? AND completed_at<?`, ...team, s, e),
      };
    }
    const remote = caredFor(me).filter(isActive).map((id) => {
      const open = S.db.all("SELECT * FROM tasks WHERE assignee_id=? AND status IN ('todo','in_progress','changes','submitted') ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at LIMIT 20", id).map(taskOut);
      const last = S.db.get<{ day: string }>('SELECT day FROM worklog WHERE user_id=? ORDER BY day DESC LIMIT 1', id);
      return { userId: id, open, lastUpdate: last?.day ?? null };
    });
    return { mine, review, myStats, teamStats, month, remote };
  });

  // ---------- analytics ----------
  r.get('/api/analytics', (c) => {
    const month = c.url.searchParams.get('month') || monthKey(now());
    const [s, e] = monthRange(month);
    const ids = c.user.perms.has('analytics.view_all')
      ? S.db.all<{ id: string }>("SELECT id FROM users WHERE status='active'").map((x) => x.id)
      : [c.user.id, ...descendants(c.user.id)];
    const people = ids.map((id) => {
      const rv = S.db.get('SELECT rating, note, reviewer_id FROM reviews WHERE user_id=? AND month=?', id, month);
      return { userId: id, ...stats(id, s, e), review: rv ? { rating: rv.rating, note: rv.note, reviewerId: rv.reviewer_id } : null, canReview: ancestors(id).includes(c.user.id) || (c.user.isOwner && id !== c.user.id) };
    });
    const ph = ids.map(() => '?').join(',');
    const byStatus = S.db.all(`SELECT status, COUNT(*) n FROM tasks WHERE assignee_id IN (${ph}) AND created_at<? AND (completed_at IS NULL OR completed_at>=?) GROUP BY status`, ...ids, e, s);
    return { month, people, byStatus };
  });

  r.get('/api/analytics/user/:id', (c) => {
    const uid = vid(c.params.id);
    if (!analyticsVisible(c.user, uid)) throw notFound('Member not found.');
    const months = int(c.url.searchParams.get('months') ?? 12, 'months', 1, 36);
    const series = [];
    const d = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const m = monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime());
      const [s, e] = monthRange(m);
      series.push({ month: m, ...stats(uid, s, e) });
    }
    const reviews = S.db.all('SELECT month, rating, note, reviewer_id, updated_at FROM reviews WHERE user_id=? ORDER BY month DESC LIMIT 36', uid)
      .map((x) => ({ month: x.month, rating: x.rating, note: x.note, reviewerId: x.reviewer_id, updatedAt: x.updated_at }));
    return { userId: uid, series, reviews };
  });

  r.put('/api/reviews/:userId/:month', (c) => {
    const uid = vid(c.params.userId);
    const month = String(c.params.month);
    monthRange(month);
    if (uid === c.user.id) throw forbidden('You cannot review yourself.');
    if (!ancestors(uid).includes(c.user.id) && !c.user.isOwner) throw forbidden('Only someone above this person in the team chart can review them.');
    const rating = int(c.body.rating, 'rating', 1, 5);
    const note = optStr(c.body.note, 'Note', LIMITS.note, true);
    S.db.run('INSERT INTO reviews(user_id,month,reviewer_id,rating,note,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET reviewer_id=excluded.reviewer_id, rating=excluded.rating, note=excluded.note, updated_at=excluded.updated_at',
      uid, month, c.user.id, rating, note, now());
    S.hub.send([uid], { t: 'notify', kind: 'review', title: 'New performance review', body: `${c.user.displayName} reviewed your work for ${month}.` });
    return { ok: true };
  });
}

export { OPEN };
