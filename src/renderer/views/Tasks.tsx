import { useEffect, useMemo, useState } from 'react';
import { api, useStore, navigate, uploadFiles, fmtDate, fmtDateTime, fmtBytes, userName, can, toast, monthNow, monthLabel, shiftMonth, bunny, type Task, type FileInfo, type User } from '../api';
import { Avatar, Btn, ErrorBox, ExportButtons, Field, Icon, Modal, Spinner, RichText, Tabs, confirmDialog, useAsync, Progress } from '../ui';
import { Attachment } from './Chat';

export const STATUS: Record<string, { label: string; color: string }> = {
  todo: { label: 'To do', color: '#8B8B95' },
  in_progress: { label: 'In progress', color: '#1F6BFF' },
  submitted: { label: 'Submitted for review', color: '#FFC53D' },
  changes: { label: 'Changes requested', color: '#FF1F56' },
  done: { label: 'Done', color: '#2BD488' },
  cancelled: { label: 'Cancelled', color: '#55555F' },
};
const COLUMNS = ['todo', 'in_progress', 'submitted', 'changes', 'done'];
const PRIOS = ['low', 'normal', 'high', 'urgent'];

// People the current user may assign to (server enforces the same rule).
export function assignable(users: Record<string, User>, meId: string): User[] {
  const all = Object.values(users).filter((u) => u.status === 'active');
  if (can('tasks.assign_any')) return all;
  const kids = new Map<string, string[]>();
  for (const u of all) if (u.managerId) kids.set(u.managerId, [...(kids.get(u.managerId) || []), u.id]);
  const out = new Set<string>([meId]);
  const q = [...(kids.get(meId) || [])];
  while (q.length) { const x = q.pop()!; if (out.has(x)) continue; out.add(x); q.push(...(kids.get(x) || [])); }
  return all.filter((u) => out.has(u.id));
}

export function Tasks() {
  const arg = useStore((s) => s.routeArg);
  const ver = useStore((s) => s.ver.tasks);
  const [view, setView] = useState<'mine' | 'assigned' | 'team' | 'all'>('mine');
  const [month, setMonth] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState<{ parentId?: string; assigneeId?: string } | null>(null);
  const { data, error, loading, reload } = useAsync(() => api<Task[]>('GET', `/api/tasks?view=${view}${month ? '&month=' + month : ''}`), [view, month, ver]);
  useEffect(() => { if (arg === 'new') { setCreating({}); navigate('tasks'); } }, [arg]);
  const openId = arg && arg !== 'new' ? arg : null;
  const filtered = (data || []).filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()) || userName(t.assigneeId).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Tasks</h1><p>Assign work down the chain, submit it back up, approve and track every step.</p></div>
        <Btn kind="primary" icon="plus" onClick={() => setCreating({})}>New task</Btn>
      </div>
      <div className="toolbar">
        <Tabs value={view} onChange={setView} items={[
          { id: 'mine', label: 'Assigned to me' }, { id: 'assigned', label: 'Assigned by me' }, { id: 'team', label: 'My team' }, { id: 'all', label: 'Everything', hidden: !can('tasks.view_all') },
        ]} />
        <div className="month-pick">
          {month ? <>
            <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="left" size={16} /></button>
            <span>{monthLabel(month)}</span>
            <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month"><Icon name="right" size={16} /></button>
            <button className="icon-btn" onClick={() => setMonth(null)} title="All time"><Icon name="x" size={14} /></button>
          </> : <Btn small kind="soft" icon="clock" onClick={() => setMonth(monthNow())}>Filter by month</Btn>}
        </div>
        <div className="search-box grow" style={{ maxWidth: 300 }}><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks or people" /></div>
        <ExportButtons disabled={!data} table={() => ({ title: `Tasks - ${({ mine: 'Assigned to me', assigned: 'Assigned by me', team: 'My team', all: 'Everything' } as Record<string, string>)[view]}${month ? ' - ' + monthLabel(month) : ''}`,
          columns: ['Title', 'Assigned to', 'Assigned by', 'Status', 'Priority', 'Due', 'Created', 'Completed', 'Revisions', 'Files', 'Subtasks', 'Details'],
          rows: filtered.map((t) => [t.title, userName(t.assigneeId), userName(t.assignerId), STATUS[t.status]?.label || t.status, t.priority, t.dueAt ? fmtDateTime(t.dueAt) : '', fmtDateTime(t.createdAt), t.completedAt ? fmtDateTime(t.completedAt) : '', t.revisions, t.files, t.subtasks, t.description]) })} />
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : (
        <div className="board-wrap">
          <div className="board">
            {COLUMNS.map((col) => {
              const items = filtered.filter((t) => t.status === col);
              return (
                <div key={col} className="column">
                  <div className="column-head"><i style={{ background: STATUS[col].color }} />{STATUS[col].label}<span className="n">{items.length}</span></div>
                  {items.map((t) => <TaskCard key={t.id} t={t} />)}
                  {!items.length && <p className="dim" style={{ fontSize: 12, padding: '6px 6px 10px' }}>Nothing here</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {creating && <TaskForm initial={creating} onClose={() => setCreating(null)} onSaved={(t) => { setCreating(null); reload(); navigate('tasks', t.id); }} />}
      {openId && <TaskDrawer id={openId} onClose={() => navigate('tasks')} onSubtask={(parentId) => setCreating({ parentId })} onChanged={reload} />}
    </div>
  );
}

function TaskCard({ t }: { t: Task }) {
  const users = useStore((s) => s.users);
  const late = t.dueAt && t.dueAt < Date.now() && !['done', 'cancelled'].includes(t.status);
  return (
    <button className="tcard" onClick={() => navigate('tasks', t.id)}>
      <b>{t.title}</b>
      <div className="tmeta">
        {t.priority !== 'normal' && <span className={'prio ' + t.priority}>{t.priority}</span>}
        {t.dueAt && <span className={late ? 'late' : ''}><Icon name="clock" size={11} className="inline" /> {fmtDate(t.dueAt)}</span>}
        {t.files > 0 && <span>{t.files} file{t.files > 1 ? 's' : ''}</span>}
        {t.subtasks > 0 && <span>{t.subtasks} subtask{t.subtasks > 1 ? 's' : ''}</span>}
        {t.revisions > 0 && <span>{t.revisions} revision{t.revisions > 1 ? 's' : ''}</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <Avatar user={users[t.assigneeId || '']} size={22} />
        <span className="dim ellipsis" style={{ fontSize: 12 }}>{userName(t.assigneeId)}</span>
        <span className="grow" />
        <span className="dim" style={{ fontSize: 11 }}>from {userName(t.assignerId).split(' ')[0]}</span>
      </div>
    </button>
  );
}

const toLocalInput = (t: number | null) => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function TaskForm({ initial, task, onClose, onSaved }: { initial?: { parentId?: string; assigneeId?: string }; task?: Task; onClose: () => void; onSaved: (t: Task) => void }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me!.user.id);
  const people = useMemo(() => assignable(users, me), [users, me]);
  const [title, setTitle] = useState(task?.title || '');
  const [desc, setDesc] = useState(task?.description || '');
  const [assignee, setAssignee] = useState(task?.assigneeId || initial?.assigneeId || '');
  const [due, setDue] = useState(toLocalInput(task?.dueAt ?? null));
  const [prio, setPrio] = useState(task?.priority || 'normal');
  const [links, setLinks] = useState((task?.links || []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { title, description: desc, assigneeId: assignee, dueAt: due ? new Date(due).getTime() : null, priority: prio, links: links.split(/\s+/).filter(Boolean), parentId: initial?.parentId };
    try {
      const t = task ? await api<Task>('PATCH', `/api/tasks/${task.id}`, body) : await api<Task>('POST', '/api/tasks', body);
      toast(task ? 'Task updated' : 'Task assigned', 'ok');
      onSaved(t);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={task ? 'Edit task' : initial?.parentId ? 'Delegate a subtask' : 'New task'} onClose={onClose} wide footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!title.trim() || !assignee} onClick={save}>{task ? 'Save' : 'Assign task'}</Btn></>}>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="e.g. Edit XYZ client reel, 60s, vertical" /></Field>
      <Field label="Details"><textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={8000} rows={5} placeholder="What needs to be done, references, how it should look..." /></Field>
      <div className="form-row">
        <Field label="Assign to">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Choose a person</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.id === me ? `${u.displayName} (me)` : u.displayName}{u.isRemote ? ' (remote)' : ''}{u.title ? ` - ${u.title}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Priority"><select value={prio} onChange={(e) => setPrio(e.target.value)}>{PRIOS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select></Field>
      </div>
      <div className="form-row">
        <Field label="Due"><input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Links (one per line)"><textarea rows={2} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://drive.google.com/..." style={{ minHeight: 42 }} /></Field>
      </div>
      {err && <ErrorBox text={err} />}
    </Modal>
  );
}

interface Detail { task: Task; events: { id: number; userId: string; type: string; note: string; fileIds: string[]; createdAt: number; onBehalfOf?: string | null }[]; subtasks: Task[]; parent: Task | null; canDecide: boolean; canEdit: boolean; actingFor: string | null }
const EV: Record<string, string> = { created: 'created this task', start: 'started working', submit: 'submitted work', approve: 'approved the work', request_changes: 'requested changes', cancel: 'cancelled the task', reopen: 'reopened the task', comment: 'commented', edited: 'edited', delegated: 'delegated a subtask' };

function TaskDrawer({ id, onClose, onSubtask, onChanged }: { id: string; onClose: () => void; onSubtask: (parentId: string) => void; onChanged: () => void }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me!.user.id);
  const ver = useStore((s) => s.ver.tasks);
  const { data, error, loading, reload } = useAsync(() => api<Detail>('GET', `/api/tasks/${id}`), [id, ver]);
  const files = useAsync(() => api<FileInfo[]>('GET', `/api/files?scope=task&scopeId=${id}`), [id, ver]);
  const allUploads = useStore((s) => s.uploads);
  const uploads = useMemo(() => allUploads.filter((u) => u.scopeId === id), [allUploads, id]);
  const [note, setNote] = useState('');
  const [attached, setAttached] = useState<FileInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [editing]);
  const act = async (action: string) => {
    if (action === 'cancel' && !(await confirmDialog({ title: 'Cancel this task?', text: 'It stays in history but is closed.', ok: 'Cancel task', danger: true }))) return;
    setBusy(action);
    try {
      await api('POST', `/api/tasks/${id}/action`, { action, note, fileIds: attached.map((f) => f.id) });
      setNote(''); setAttached([]); reload(); files.reload(); onChanged();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: 'Delete task?', text: 'The task, its history and its attachments are removed permanently.', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/tasks/${id}`); onChanged(); onClose(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const t = data?.task;
  const isAssignee = t?.assigneeId === me || !!data?.actingFor;
  const forWhom = data?.actingFor ? ` for ${userName(data.actingFor).split(' ')[0]}` : '';
  const fileMap = new Map((files.data || []).map((f) => [f.id, f]));
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Task">
        {loading && !data ? <div className="drawer-body"><Spinner /></div> : error ? <div className="drawer-body"><ErrorBox text={error} /><Btn onClick={onClose}>Close</Btn></div> : t && data && <>
          <div className="drawer-head">
            <div className="row between">
              <span className="pill" style={{ color: STATUS[t.status].color, borderColor: STATUS[t.status].color + '55' }}><span className="status-dot" style={{ background: STATUS[t.status].color }} />{STATUS[t.status].label}</span>
              <div className="row" style={{ gap: 4 }}>
                {data.canEdit && <button className="icon-btn" title="Edit" onClick={() => setEditing(true)}><Icon name="edit" /></button>}
                {data.canEdit && <button className="icon-btn" title="Delete" onClick={del}><Icon name="trash" /></button>}
                <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
              </div>
            </div>
            <h2 className="sel">{t.title}</h2>
            {data.parent && <a onClick={() => navigate('tasks', data.parent!.id)} style={{ fontSize: 12.5 }}>Part of: {data.parent.title}</a>}
          </div>
          <div className="drawer-body">
            <dl className="kv">
              <dt>Assigned to</dt><dd className="row" style={{ gap: 8 }}><Avatar user={users[t.assigneeId || '']} size={22} />{userName(t.assigneeId)}</dd>
              <dt>Assigned by</dt><dd className="row" style={{ gap: 8 }}><Avatar user={users[t.assignerId || '']} size={22} />{userName(t.assignerId)}</dd>
              <dt>Priority</dt><dd><span className={'prio ' + t.priority}>{t.priority}</span></dd>
              <dt>Due</dt><dd>{t.dueAt ? <span className={t.dueAt < Date.now() && !['done', 'cancelled'].includes(t.status) ? 'late' : ''} style={{ color: t.dueAt < Date.now() && !['done', 'cancelled'].includes(t.status) ? '#FF6B8E' : undefined }}>{fmtDateTime(t.dueAt)}</span> : <span className="dim">No deadline</span>}</dd>
              <dt>Created</dt><dd>{fmtDateTime(t.createdAt)}</dd>
              {t.completedAt && <><dt>Completed</dt><dd>{fmtDateTime(t.completedAt)}</dd></>}
              {t.revisions > 0 && <><dt>Revisions</dt><dd>{t.revisions}</dd></>}
            </dl>
            {t.description && <div className="note" style={{ whiteSpace: 'pre-wrap', padding: 12, borderRadius: 12, background: 'var(--card)', border: '1px solid var(--line)' }}><RichText text={t.description} /></div>}
            {t.links.length > 0 && <div className="col" style={{ gap: 6 }}>{t.links.map((l) => <a key={l} onClick={() => bunny.openExternal(l)} className="row ellipsis" style={{ gap: 6 }}><Icon name="link" size={14} />{l}</a>)}</div>}

            {data.actingFor && !['done', 'cancelled'].includes(t.status) && <div className="notice"><Icon name="globe" size={16} /><span>{userName(data.actingFor)} works remotely. You can start and submit this task on their behalf; the history shows it was you.</span></div>}
            {(data.subtasks.length > 0 || isAssignee) && (
              <div className="col">
                <div className="row between"><h4>Delegated subtasks</h4>{(isAssignee || data.canEdit) && !['done', 'cancelled'].includes(t.status) && <Btn small icon="plus" onClick={() => onSubtask(t.id)}>Delegate</Btn>}</div>
                {data.subtasks.map((s) => (
                  <div key={s.id} className="list-row" onClick={() => navigate('tasks', s.id)}>
                    <span className="status-dot" style={{ background: STATUS[s.status].color }} /><span className="grow ellipsis">{s.title}</span>
                    <span className="dim" style={{ fontSize: 12 }}>{userName(s.assigneeId)}</span><span className="pill">{STATUS[s.status].label}</span>
                  </div>
                ))}
                {!data.subtasks.length && <p className="dim" style={{ fontSize: 12.5 }}>Split this task and hand parts to people under you.</p>}
              </div>
            )}

            {(files.data?.length || 0) > 0 && (
              <div className="col">
                <h4>Files ({files.data!.length})</h4>
                {files.data!.map((f) => <Attachment key={f.id} f={f} />)}
              </div>
            )}

            <div className="col">
              <h4>Activity</h4>
              <div className="timeline">
                {data.events.map((e) => (
                  <div key={e.id} className="ev">
                    <Avatar user={users[e.userId]} size={26} />
                    <div className="evb">
                      <div className="evh"><b>{userName(e.userId)}</b> {EV[e.type] || e.type}{e.onBehalfOf ? ` for ${userName(e.onBehalfOf)}` : ''} {e.type === 'edited' && e.note ? `(${e.note})` : ''} · <span className="dim">{fmtDateTime(e.createdAt)}</span></div>
                      {e.note && e.type !== 'edited' && <div className="note"><RichText text={e.note} /></div>}
                      {e.fileIds.length > 0 && <div className="row wrap" style={{ marginTop: 6 }}>{e.fileIds.map((fid) => fileMap.get(fid)).filter(Boolean).map((f) => <span key={f!.id} className="pill"><Icon name="file" size={12} />{f!.name}</span>)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {t.status !== 'cancelled' && (
            <div className="composer" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              {uploads.map((u) => <div key={u.id} className="up-row"><Icon name="upload" size={14} /><span className="ellipsis" style={{ maxWidth: 200 }}>{u.name}</span><Progress value={(u.sent / Math.max(1, u.size)) * 100} /><span className="dim">{u.status === 'error' ? u.error : fmtBytes(u.sent)}</span></div>)}
              {attached.length > 0 && <div className="row wrap">{attached.map((f) => <span key={f.id} className="pill blue"><Icon name="file" size={12} />{f.name}<button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setAttached(attached.filter((x) => x.id !== f.id))}><Icon name="x" size={11} /></button></span>)}</div>}
              <div className="composer-box">
                <label className="icon-btn" title="Attach files" style={{ cursor: 'pointer' }}>
                  <Icon name="clip" />
                  <input type="file" multiple hidden onChange={(e) => { uploadFiles([...(e.target.files || [])], 'task', t.id, (f) => setAttached((a) => [...a, f])); e.target.value = ''; }} />
                </label>
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={isAssignee && ['todo', 'in_progress', 'changes'].includes(t.status) ? 'Add a note for your submission or a comment...' : 'Write a comment or feedback...'} />
              </div>
              <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                <Btn small loading={busy === 'comment'} disabled={!note.trim() && !attached.length} onClick={() => act('comment')}>Comment</Btn>
                {isAssignee && ['todo', 'changes'].includes(t.status) && <Btn small icon="play" loading={busy === 'start'} onClick={() => act('start')}>{'Start' + forWhom}</Btn>}
                {isAssignee && ['todo', 'in_progress', 'changes'].includes(t.status) && <Btn small kind="primary" icon="send" loading={busy === 'submit'} onClick={() => act('submit')}>{(t.assignerId === me ? 'Mark done' : 'Submit for review') + forWhom}</Btn>}
                {data.canDecide && t.status === 'submitted' && <>
                  <Btn small kind="danger" loading={busy === 'request_changes'} disabled={!note.trim()} title={!note.trim() ? 'Write what needs to change' : ''} onClick={() => act('request_changes')}>Request changes</Btn>
                  <Btn small kind="primary" icon="check" loading={busy === 'approve'} onClick={() => act('approve')}>Approve</Btn>
                </>}
                {data.canDecide && !['done', 'cancelled'].includes(t.status) && <Btn small kind="soft" loading={busy === 'cancel'} onClick={() => act('cancel')}>Cancel task</Btn>}
                {data.canDecide && t.status === 'done' && <Btn small kind="soft" icon="refresh" loading={busy === 'reopen'} onClick={() => act('reopen')}>Reopen</Btn>}
              </div>
            </div>
          )}
        </>}
      </aside>
      {editing && t && <TaskForm task={t} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); onChanged(); }} />}
    </>
  );
}

export { TaskForm };
