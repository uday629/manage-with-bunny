import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Hit } from '../api';
import { api, bunny, useStore, getState, setState, navigate, loadMessages, loadAround, searchMessages, isVoice, loadConvs, sendMessage, sendTyping, retryFailed, uploadFiles, dismissUpload, retryUpload, fileUrl, downloadFile, peerOf, textOf, userName, fmtTime, fmtBytes, fmtDate, fmtAgo, can, toast, type Conv, type Msg, type FileInfo, type User } from '../api';
import { Avatar, Btn, Empty, Field, Icon, Modal, Progress, RichText, Spinner, UserPicker, confirmDialog } from '../ui';

export function Chat() {
  const convId = useStore((s) => s.routeArg);
  const convs = useStore((s) => s.convs);
  const conv = convs.find((c) => c.id === convId) || null;
  return (
    <div className="chat">
      <ConvList active={convId} />
      {conv ? <Thread key={conv.id} conv={conv} /> : <div className="thread"><div className="titlebar" /><Empty icon="chat" title="Pick a conversation" text="Direct messages are end-to-end encrypted. Only you and the other person can read them." /></div>}
    </div>
  );
}

function convTitle(c: Conv, users: Record<string, User>, me: string) {
  if (c.type === 'group') return c.name;
  const other = c.members.find((m) => m !== me);
  return (other && users[other]?.displayName) || 'Former member';
}

function ConvList({ active }: { active: string | null }) {
  const convs = useStore((s) => s.convs);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me!.user.id);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(false);
  const list = convs.filter((c) => !q || convTitle(c, users, me).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="conv-col">
      <div className="row between"><h2>Chat</h2><Btn small kind="primary" icon="plus" onClick={() => setModal(true)}>New</Btn></div>
      <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats and messages" /></div>
      <div className="conv-list">
        {list.map((c) => {
          const other = c.type === 'dm' ? users[c.members.find((m) => m !== me) || ''] : null;
          const last = c.last;
          const preview = !last ? 'No messages yet' : last.deleted ? 'Message deleted' : last.kind === 'file' ? (isVoice(last.file) ? 'Voice message' : `File: ${last.file?.name || ''}`) : last.kind === 'system' ? last.body : `${last.senderId === me ? 'You: ' : c.type === 'group' ? userName(last.senderId).split(' ')[0] + ': ' : ''}${textOf(last)}`;
          return (
            <button key={c.id} className={'conv' + (c.id === active ? ' on' : '')} onClick={() => navigate('chat', c.id)}>
              {c.type === 'dm' ? <Avatar user={other} size={36} /> : <span className="group-ic">{c.name.slice(0, 1).toUpperCase()}</span>}
              <span className="grow"><b className="ellipsis">{convTitle(c, users, me)}</b><small>{preview}</small></span>
              <span className="meta">{last && <span>{fmtAgo(last.createdAt)}</span>}{c.unread > 0 && !c.muted && <b className="badge">{c.unread}</b>}{c.muted && <Icon name="bell" size={12} />}</span>
            </button>
          );
        })}
        {!list.length && q.trim().length < 2 && <Empty icon="chat" title="No conversations" text="Start a direct message or create a group for your team." />}
        {q.trim().length >= 2 && <SearchResults q={q} onPick={() => setQ('')} />}
      </div>
      {modal && <NewChat onClose={() => setModal(false)} />}
    </div>
  );
}

function SearchResults({ q, onPick }: { q: string; onPick: () => void }) {
  const users = useStore((s) => s.users);
  const convs = useStore((s) => s.convs);
  const me = useStore((s) => s.me!.user.id);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setHits(null); setErr(null);
    const t = setTimeout(() => { searchMessages(q).then((h) => alive && setHits(h)).catch((e) => alive && setErr(e.message)); }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  const mark = (text: string) => {
    const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0) return text.slice(0, 120);
    const start = Math.max(0, i - 30);
    return <>{start > 0 ? '...' : ''}{text.slice(start, i)}<mark>{text.slice(i, i + q.trim().length)}</mark>{text.slice(i + q.trim().length, i + 90)}</>;
  };
  return (
    <div className="search-results">
      <span className="mono" style={{ padding: '10px 10px 4px' }}>Messages</span>
      {!hits && !err && <div style={{ padding: 12 }}><Spinner size={16} /></div>}
      {err && <p className="dim pad">{err}</p>}
      {hits && !hits.length && <p className="dim pad">No messages match "{q.trim()}".</p>}
      {hits?.map((h) => {
        const c = convs.find((x) => x.id === h.convId);
        return (
          <button key={h.convId + h.msgId} className="conv hit" onClick={() => { setState({ jump: { convId: h.convId, msgId: h.msgId } }); navigate('chat', h.convId); onPick(); }}>
            <Avatar user={h.senderId ? users[h.senderId] : null} size={28} />
            <span className="grow"><b className="ellipsis">{c ? convTitle(c, users, me) : 'Chat'} <span className="dim" style={{ fontWeight: 500 }}>· {userName(h.senderId).split(' ')[0]}</span></b><small>{h.file && !h.text ? `File: ${h.file}` : mark(h.text || h.file || '')}</small></span>
            <span className="meta"><span>{fmtAgo(h.createdAt)}</span></span>
          </button>
        );
      })}
    </div>
  );
}

function NewChat({ onClose }: { onClose: () => void }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me!.user);
  const [tab, setTab] = useState<'dm' | 'group'>('dm');
  const [sel, setSel] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const people = Object.values(users).filter((u) => u.id !== me.id && u.status === 'active' && !u.isRemote);
  const reports = people.filter((u) => u.managerId === me.id).map((u) => u.id);
  const go = async () => {
    setBusy(true);
    try {
      const r = tab === 'dm' ? await api<{ id: string }>('POST', '/api/convs/dm', { userId: sel[0] }) : await api<{ id: string }>('POST', '/api/convs/group', { name, memberIds: sel });
      await loadConvs();
      navigate('chat', r.id);
      onClose();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="New conversation" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" loading={busy} disabled={!sel.length || (tab === 'group' && !name.trim())} onClick={go}>{tab === 'dm' ? 'Open chat' : 'Create group'}</Btn></>}>
      {can('chat.create_groups') && (
        <div className="tabs" style={{ alignSelf: 'flex-start' }}>
          <button className={'tab' + (tab === 'dm' ? ' on' : '')} onClick={() => { setTab('dm'); setSel(sel.slice(0, 1)); }}>Direct message</button>
          <button className={'tab' + (tab === 'group' ? ' on' : '')} onClick={() => setTab('group')}>Group</button>
        </div>
      )}
      {tab === 'group' && <>
        <Field label="Group name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Video Editing Team" /></Field>
        {reports.length > 0 && <Btn small icon="users" onClick={() => { setSel([...new Set([...sel, ...reports])]); if (!name) setName(`${me.displayName.split(' ')[0]}'s team`); }}>Add my whole team ({reports.length})</Btn>}
      </>}
      <UserPicker users={people} selected={sel} onChange={setSel} multi={tab === 'group'} />
      {tab === 'dm' && !can('chat.message_anyone') && <p className="dim" style={{ fontSize: 12 }}>You can message your manager, teammates and the people who report to you.</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- thread
function Thread({ conv }: { conv: Conv }) {
  const me = useStore((s) => s.me!.user.id);
  const users = useStore((s) => s.users);
  const msgs = useStore((s) => s.msgs[conv.id]);
  const typing = useStore((s) => s.typing[conv.id]);
  const allUploads = useStore((s) => s.uploads);
  const uploads = useMemo(() => allUploads.filter((u) => u.scopeId === conv.id), [allUploads, conv.id]);
  const [reads, setReads] = useState<Record<string, number>>({});
  const [loadingOld, setLoadingOld] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [reply, setReply] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [drag, setDrag] = useState(false);
  const [keyState, setKeyState] = useState<{ status: string; safety: string } | null>(null);
  const [settings, setSettings] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const peer = conv.type === 'dm' ? peerOf(conv) : null;

  useEffect(() => {
    loadMessages(conv.id).then((r) => {
      const map: Record<string, number> = {};
      for (const x of r.reads) map[x.user_id] = x.last_read_id;
      setReads(map);
      if (r.messages.length < 60) setNoMore(true);
    }).catch((e) => toast(e.message, 'err'));
    const onRead = (e: Event) => { const d = (e as CustomEvent).detail; if (d.convId === conv.id) setReads((r) => ({ ...r, [d.userId]: Math.max(r[d.userId] || 0, d.lastId) })); };
    window.addEventListener('bunny-read', onRead);
    return () => window.removeEventListener('bunny-read', onRead);
  }, [conv.id]);

  const jump = useStore((s) => (s.jump && s.jump.convId === conv.id ? s.jump : null));
  useEffect(() => {
    if (!jump) return;
    stick.current = false;
    loadAround(conv.id, jump.msgId).then(() => {
      setNoMore(false);
      requestAnimationFrame(() => {
        const el = document.getElementById('m-' + jump.msgId);
        if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400); }
      });
    }).catch((e) => toast(e.message, 'err')).finally(() => setState({ jump: null }));
  }, [jump?.msgId]);

  useEffect(() => { if (peer?.pubkey) bunny.checkPeer({ userId: peer.id, pub: peer.pubkey }).then(setKeyState).catch(() => {}); }, [peer?.pubkey]);

  // mark as read
  const lastId = msgs?.filter((m) => !m.pending).at(-1)?.id || 0;
  useEffect(() => {
    if (!lastId || !document.hasFocus()) return;
    if (lastId > conv.lastReadId || conv.unread) {
      api('POST', `/api/convs/${conv.id}/read`, { lastId }).catch(() => {});
      setState((s) => ({ convs: s.convs.map((c) => (c.id === conv.id ? { ...c, unread: 0, lastReadId: lastId } : c)) }));
    }
  }, [lastId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs?.length, uploads.length]);

  const onScroll = async () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && !loadingOld && !noMore && msgs?.length) {
      setLoadingOld(true);
      const h = el.scrollHeight;
      try {
        const first = msgs.find((m) => !m.pending);
        const r = await loadMessages(conv.id, first?.id);
        if (r.messages.length < 60) setNoMore(true);
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - h; });
      } finally { setLoadingOld(false); }
    }
  };

  const onFiles = (files: File[]) => {
    if (!files.length) return;
    uploadFiles(files, 'conv', conv.id, (f) => { void sendMessage(conv.id, '', null, f.id); });
    stick.current = true;
  };

  const others = conv.members.filter((x) => x !== me);
  const seenBy = (id: number) => others.filter((x) => (reads[x] || 0) >= id);
  const myLastId = msgs?.filter((m) => m.senderId === me && !m.pending).at(-1)?.id;
  const title = convTitle(conv, users, me);

  return (
    <div className="thread" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles([...e.dataTransfer.files]); }} style={{ position: 'relative' }}>
      <div className="titlebar" />
      <div className="thread-head">
        {conv.type === 'dm' ? <Avatar user={peer} size={38} /> : <span className="group-ic">{conv.name.slice(0, 1).toUpperCase()}</span>}
        <div className="grow">
          <h3 className="ellipsis">{title}</h3>
          {conv.type === 'dm'
            ? <small className="row" style={{ gap: 8 }}><span className="e2e"><Icon name="lock" size={12} /> End-to-end encrypted</span>{peer && <span>{peer.online ? 'Online' : peer.lastSeen ? `Last seen ${fmtAgo(peer.lastSeen)}` : 'Offline'}</span>}</small>
            : <small>{conv.members.length} members · {conv.members.filter((m) => users[m]?.online).length} online</small>}
        </div>
        <button className={'icon-btn' + (conv.muted ? ' on' : '')} title={conv.muted ? 'Unmute' : 'Mute notifications'} onClick={async () => { await api('POST', `/api/convs/${conv.id}/mute`, { muted: !conv.muted }); loadConvs(); }}><Icon name="bell" /></button>
        <button className="icon-btn" title={conv.type === 'dm' ? 'Verify encryption' : 'Group settings'} onClick={() => setSettings(true)}><Icon name={conv.type === 'dm' ? 'key' : 'settings'} /></button>
      </div>
      {keyState?.status === 'changed' && peer && (
        <div className="notice warn key-warn">
          <Icon name="key" size={16} />
          <span className="grow">{peer.displayName}'s security key changed (new device or account reset). Verify the code with them in person before sharing anything sensitive.</span>
          <Btn small onClick={async () => { await bunny.trustPeer({ userId: peer.id, pub: peer.pubkey }); setKeyState({ ...keyState, status: 'same' }); }}>Trust new key</Btn>
        </div>
      )}
      <div className="msgs" ref={scroller} onScroll={onScroll}>
        {loadingOld && <div style={{ alignSelf: 'center' }}><Spinner size={16} /></div>}
        {noMore && <div className="sys">{conv.type === 'dm' ? 'This is the start of your private, encrypted conversation.' : `This is the start of ${conv.name}.`}</div>}
        {!msgs && <div style={{ alignSelf: 'center', marginTop: 40 }}><Spinner /></div>}
        {msgs?.map((m, i) => {
          const prev = msgs[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped = !newDay && prev && prev.senderId === m.senderId && prev.kind !== 'system' && m.createdAt - prev.createdAt < 5 * 60000;
          return (
            <div key={m.pending ? 'p' + m.clientId : m.id} style={{ display: 'contents' }}>
              {newDay && <span className="day pill">{fmtDate(m.createdAt)}</span>}
              {m.kind === 'system' ? <div className="sys">{m.body}</div> : (
                <MessageItem m={m} grouped={!!grouped} mine={m.senderId === me} conv={conv} all={msgs} onReply={() => setReply(m)} onEdit={() => setEditing(m)} onImage={setLightbox}
                  seen={m.senderId === me && !m.pending ? (others.length && seenBy(m.id).length === others.length ? 'all' : seenBy(m.id).length ? 'some' : 'none') : null} />
              )}
              {m.id === myLastId && others.length > 0 && (() => {
                const by = seenBy(m.id);
                const label = conv.type === 'dm' ? (by.length ? 'Seen' : 'Delivered, not seen yet') : by.length === others.length ? 'Seen by everyone' : by.length ? `Seen by ${by.map((x) => userName(x).split(' ')[0]).slice(0, 4).join(', ')}${by.length > 4 ? ` +${by.length - 4}` : ''}` : 'Not seen yet';
                return <div className={'seen-line' + (by.length ? ' on' : '')} title={by.map((x) => userName(x)).join(', ')}>{label}</div>;
              })()}
            </div>
          );
        })}
      </div>
      <Composer conv={conv} reply={reply} clearReply={() => setReply(null)} editing={editing} clearEdit={() => setEditing(null)} onFiles={onFiles} peer={peer}
        typing={typing && typing.userId !== me ? `${userName(typing.userId).split(' ')[0]} is typing...` : ''} uploads={uploads} onSent={() => { stick.current = true; }} editLast={setEditing} />
      {drag && <div className="drop-hint">Drop files to send to {title}</div>}
      {settings && (conv.type === 'dm' ? <SafetyModal peer={peer} safety={keyState?.safety || ''} onClose={() => setSettings(false)} /> : <GroupSettings conv={conv} onClose={() => setSettings(false)} />)}
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="" /></div>}
    </div>
  );
}

function MessageItem({ m, grouped, mine, conv, all, onReply, onEdit, onImage, seen }: { m: Msg; grouped: boolean; mine: boolean; conv: Conv; all: Msg[]; onReply: () => void; onEdit: () => void; onImage: (u: string) => void; seen: 'all' | 'some' | 'none' | null }) {
  const user = useStore((s) => (m.senderId ? s.users[m.senderId] : null));
  const text = textOf(m);
  const replied = m.replyTo ? all.find((x) => x.id === m.replyTo) : null;
  const del = async () => {
    if (!(await confirmDialog({ title: 'Delete message?', text: 'It will be removed for everyone in this conversation.', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/messages/${m.id}`); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div id={m.pending ? undefined : 'm-' + m.id} className={`msg${mine ? ' mine' : ''}${m.pending ? ' pending' : ''}${m.pending === 'failed' ? ' failed' : ''}`} style={{ marginTop: grouped ? 0 : 10 }}>
      <div className="gutter">{!grouped && <Avatar user={user} size={34} />}</div>
      <div className="grow">
        {!grouped && <div className="mh"><b>{user?.displayName || 'Former member'}</b><time>{fmtTime(m.createdAt)}</time>{m.editedAt && <span className="dim" style={{ fontSize: 11 }}>(edited)</span>}</div>}
        {replied && <div className="reply-ref">↪ {userName(replied.senderId)}: {replied.deleted ? 'deleted message' : replied.kind === 'file' ? (isVoice(replied.file) ? 'Voice message' : replied.file?.name) : textOf(replied)}</div>}
        {m.deleted ? <div className="body deleted">Message deleted</div> : <>
          {text && <div className="body"><RichText text={text} /></div>}
          {m.file && <Attachment f={m.file} onImage={onImage} />}
        </>}
        {m.pending === 'failed' && <Btn small kind="danger" icon="refresh" onClick={() => retryFailed(m)}>Not sent. Retry</Btn>}
        {m.pending === 'sending' && <span className="dim" style={{ fontSize: 11 }}>Sending...</span>}
      </div>
      {mine && !m.deleted && <span className={'tick' + (seen === 'all' ? ' seen' : '')} title={m.pending === 'sending' ? 'Sending' : seen === 'all' ? 'Seen' : seen === 'some' ? 'Seen by some' : 'Sent'}>
        {m.pending === 'sending' ? <Icon name="clock" size={13} /> : m.pending === 'failed' ? null : <><Icon name="check" size={13} />{seen !== 'none' && <Icon name="check" size={13} className="tick2" />}</>}
      </span>}
      {!m.pending && !m.deleted && (
        <div className="tools">
          <button className="icon-btn" title="Reply" onClick={onReply}><Icon name="reply" size={15} /></button>
          {mine && m.kind === 'text' && <button className="icon-btn" title="Edit" onClick={onEdit}><Icon name="edit" size={15} /></button>}
          {text && <button className="icon-btn" title="Copy" onClick={() => { navigator.clipboard.writeText(text); toast('Copied', 'ok'); }}><Icon name="copy" size={15} /></button>}
          {(mine || (conv.type === 'group' && conv.isAdmin)) && <button className="icon-btn" title="Delete" onClick={del}><Icon name="trash" size={15} /></button>}
        </div>
      )}
    </div>
  );
}

export function Attachment({ f, onImage }: { f: FileInfo; onImage?: (u: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const kind = f.mime.startsWith('image/') ? 'image' : f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('audio/') ? 'audio' : 'file';
  useEffect(() => { if (kind !== 'file') fileUrl(f.id).then((r) => setUrl(r.url)).catch(() => setErr(true)); }, [f.id]);
  const card = (
    <div className="fcard">
      <span className="fi"><Icon name={kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'file'} /></span>
      <span className="grow"><b title={f.name}>{f.name}</b><small>{fmtBytes(f.size)}{f.version > 1 ? ` · v${f.version}` : ''}</small></span>
      <button className="icon-btn" title="Download" onClick={() => downloadFile(f).catch((e) => toast(e.message, 'err'))}><Icon name="download" /></button>
    </div>
  );
  if (isVoice(f) && !err) return <VoicePlayer f={f} url={url} />;
  if (kind === 'file' || err) return card;
  return (
    <div>
      <div className="media">
        {!url ? <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}><Spinner /></div>
          : kind === 'image' ? <img src={url} alt={f.name} loading="lazy" onClick={() => onImage?.(url)} onError={() => setErr(true)} />
          : kind === 'video' ? <video src={url} controls preload="metadata" onError={() => setErr(true)} />
          : <audio src={url} controls preload="metadata" style={{ width: '100%' }} />}
      </div>
      {card}
    </div>
  );
}

function VoicePlayer({ f, url }: { f: FileInfo; url: string | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const dur = Number(/-(\d+)s\.weba$/.exec(f.name)?.[1] || 0) || 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) a.play().catch(() => toast('Could not play this voice message.', 'err')); else a.pause(); };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => { const a = audio.current; if (!a || !dur) return; const r = e.currentTarget.getBoundingClientRect(); a.currentTime = ((e.clientX - r.left) / r.width) * dur; };
  return (
    <div className="voice">
      <button className="voice-btn" onClick={toggle} disabled={!url} aria-label={playing ? 'Pause' : 'Play voice message'}>{!url ? <Spinner size={14} /> : <Icon name={playing ? 'pause' : 'play'} size={16} />}</button>
      <div className="voice-bar" onClick={seek}>{Array.from({ length: 34 }, (_, i) => <i key={i} className={dur && i / 34 < t / dur ? 'on' : ''} style={{ height: `${30 + Math.abs(Math.sin(i * 1.7 + f.size % 7)) * 70}%` }} />)}</div>
      <span className="voice-time">{fmt(playing || t ? t : dur)}</span>
      {url && <audio ref={audio} src={url} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setT(0); }} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} />}
    </div>
  );
}

// Records a voice message with the microphone (WebM/Opus), max 10 minutes.
function VoiceRecorder({ onDone, onCancel }: { onDone: (f: File) => void; onCancel: () => void }) {
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const send = useRef(false);
  const started = useRef(0);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    (async () => {
      try {
        if (!(await bunny.micAccess())) throw new Error('Microphone access is blocked. Allow it in your system privacy settings.');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const r = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
        rec.current = r;
        r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
        r.onstop = () => {
          stream?.getTracks().forEach((t) => t.stop());
          const d = Math.max(1, Math.round((Date.now() - started.current) / 1000));
          if (send.current && chunks.current.length) onDone(new File(chunks.current, `voice-${Date.now()}-${d}s.weba`, { type: 'audio/webm' }));
        };
        r.start(1000);
        started.current = Date.now();
        timer = window.setInterval(() => { const s = Math.floor((Date.now() - started.current) / 1000); setSecs(s); if (s >= 600) stop(true); }, 250);
      } catch (e) { toast((e as Error).message || 'Microphone not available.', 'err'); onCancel(); }
    })();
    return () => { window.clearInterval(timer); if (rec.current && rec.current.state !== 'inactive') { send.current = false; rec.current.stop(); } stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  const stop = (ok: boolean) => { send.current = ok; if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); if (!ok) onCancel(); };
  return (
    <div className="recording">
      <i className="rec-dot" /><span>Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span><span className="grow" />
      <Btn small kind="soft" icon="trash" onClick={() => stop(false)}>Cancel</Btn>
      <Btn small kind="primary" icon="send" onClick={() => { stop(true); onCancel(); }}>Send voice</Btn>
    </div>
  );
}

function Composer({ conv, reply, clearReply, editing, clearEdit, onFiles, typing, uploads, onSent, peer, editLast }: {
  editLast: (m: Msg) => void; conv: Conv; reply: Msg | null; clearReply: () => void; editing: Msg | null; clearEdit: () => void; onFiles: (f: File[]) => void; typing: string;
  uploads: ReturnType<typeof getState>['uploads']; onSent: () => void; peer: User | null;
}) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const draftKey = 'draft:' + conv.id;
  useEffect(() => { try { setText(sessionStorage.getItem(draftKey) || ''); } catch { /* */ } ta.current?.focus(); }, [conv.id]);
  useEffect(() => { try { if (text) sessionStorage.setItem(draftKey, text); else sessionStorage.removeItem(draftKey); } catch { /* */ } }, [text]);
  useEffect(() => { if (editing) { setText(textOf(editing)); ta.current?.focus(); } }, [editing]);
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = '0px'; el.style.height = Math.min(180, el.scrollHeight) + 'px'; } }, [text]);
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (t.length > 15000) { toast('Message is too long.', 'err'); return; }
    if (editing) {
      try {
        const body = conv.type === 'dm' && peer ? await bunny.encrypt({ convId: conv.id, peerPub: peer.pubkey, text: t }) : t;
        await api('PATCH', `/api/messages/${editing.id}`, { body });
      } catch (e) { toast((e as Error).message, 'err'); return; }
      clearEdit(); setText(''); return;
    }
    setText(''); clearReply(); onSent();
    await sendMessage(conv.id, t, reply?.id ?? null);
  };
  const disabled = conv.type === 'dm' && (!peer || peer.status !== 'active');
  return (
    <div className="composer">
      {uploads.length > 0 && (
        <div className="uploads">
          {uploads.map((u) => (
            <div key={u.id} className="up-row">
              <Icon name={u.status === 'error' ? 'x' : u.status === 'done' ? 'check' : 'upload'} size={15} />
              <span className="ellipsis" style={{ maxWidth: 220 }}>{u.name}</span>
              <Progress value={(u.sent / Math.max(1, u.size)) * 100} tone={u.status === 'error' ? 'var(--red)' : undefined} />
              <span className="dim" style={{ whiteSpace: 'nowrap' }}>{u.status === 'error' ? u.error : u.status === 'paused' ? 'Waiting for connection' : u.status === 'done' ? 'Sent' : `${fmtBytes(u.sent)} / ${fmtBytes(u.size)}${u.speed ? ` · ${fmtBytes(u.speed)}/s` : ''}`}</span>
              {u.status === 'error' && <button className="icon-btn" title="Retry" onClick={() => retryUpload(u.id)}><Icon name="refresh" size={14} /></button>}
              {u.status !== 'done' && <button className="icon-btn" title="Cancel" onClick={() => dismissUpload(u.id)}><Icon name="x" size={14} /></button>}
            </div>
          ))}
        </div>
      )}
      {(reply || editing) && (
        <div className="reply-bar">
          <Icon name={editing ? 'edit' : 'reply'} size={14} />
          <span className="grow ellipsis">{editing ? 'Editing message' : `Replying to ${userName(reply!.senderId)}: ${reply!.kind === 'file' ? reply!.file?.name : textOf(reply!)}`}</span>
          <button className="icon-btn" onClick={() => { clearReply(); if (editing) { clearEdit(); setText(''); } }} aria-label="Cancel"><Icon name="x" size={14} /></button>
        </div>
      )}
      {recording ? <VoiceRecorder onDone={(f) => onFiles([f])} onCancel={() => setRecording(false)} /> : <div className="composer-box">
        <button className="icon-btn" title="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}><Icon name="clip" /></button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { onFiles([...(e.target.files || [])]); e.target.value = ''; }} />
        <textarea ref={ta} rows={1} value={text} disabled={disabled} placeholder={disabled ? 'This person is no longer active.' : conv.type === 'dm' ? 'Write an encrypted message...' : `Message ${conv.name}`} aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            if (Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); sendTyping(conv.id); }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { clearReply(); if (editing) { clearEdit(); setText(''); } }
            if (e.key === 'ArrowUp' && !text) { const mine = (getState().msgs[conv.id] || []).filter((m) => m.senderId === getState().me?.user.id && m.kind === 'text' && !m.deleted && !m.pending).at(-1); if (mine) { e.preventDefault(); editLast(mine); } }
          }}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); onFiles(files); } }} />
        {!text.trim() && !editing
          ? <Btn kind="primary" icon="mic" disabled={disabled} onClick={() => setRecording(true)} aria-label="Record voice message" title="Record voice message" />
          : <Btn kind="primary" icon="send" disabled={!text.trim() || disabled} onClick={submit} aria-label="Send" />}
      </div>}
      <div className="typing">{typing}</div>
    </div>
  );
}

function SafetyModal({ peer, safety, onClose }: { peer: User | null; safety: string; onClose: () => void }) {
  return (
    <Modal title="Verify encryption" onClose={onClose} footer={<Btn kind="primary" onClick={onClose}>Done</Btn>}>
      <p className="muted">Messages between you and {peer?.displayName} are end-to-end encrypted. The host stores only scrambled data. To be sure nobody is in the middle, compare this code with {peer?.displayName.split(' ')[0]}'s screen. They should match exactly.</p>
      <div className="code" style={{ fontSize: 18, lineHeight: 1.6 }}>{safety || '...'}</div>
    </Modal>
  );
}

function GroupSettings({ conv, onClose }: { conv: Conv; onClose: () => void }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me!.user.id);
  const [name, setName] = useState(conv.name);
  const [add, setAdd] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const isAdmin = conv.isAdmin || conv.createdBy === me;
  const candidates = useMemo(() => Object.values(users).filter((u) => u.status === 'active' && !u.isRemote && !conv.members.includes(u.id)), [users, conv.members]);
  const save = async (body: any) => {
    setBusy(true);
    try { await api('PATCH', `/api/convs/${conv.id}`, body); await loadConvs(); toast('Group updated', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const leave = async () => {
    if (!(await confirmDialog({ title: `Leave ${conv.name}?`, text: 'You will stop receiving messages from this group.', ok: 'Leave', danger: true }))) return;
    await api('POST', `/api/convs/${conv.id}/leave`, {}); await loadConvs(); navigate('chat'); onClose();
  };
  return (
    <Modal title="Group settings" onClose={onClose} wide>
      {isAdmin && <div className="row"><Field label="Group name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field><Btn style={{ alignSelf: 'flex-end' }} loading={busy} disabled={!name.trim() || name === conv.name} onClick={() => save({ name })}>Rename</Btn></div>}
      <h4>Members ({conv.members.length})</h4>
      <div className="list">
        {conv.members.map((id) => (
          <div key={id} className="list-row" style={{ cursor: 'default' }}>
            <Avatar user={users[id]} size={28} /><span className="grow">{users[id]?.displayName || 'Member'}{id === me ? ' (you)' : ''}</span>
            {isAdmin && id !== me && <Btn small kind="soft" onClick={() => save({ removeIds: [id] })}>Remove</Btn>}
          </div>
        ))}
      </div>
      {isAdmin && candidates.length > 0 && <>
        <h4>Add people</h4>
        <UserPicker users={candidates} selected={add} onChange={setAdd} />
        <Btn kind="primary" disabled={!add.length} loading={busy} onClick={async () => { await save({ addIds: add }); setAdd([]); }}>Add {add.length || ''}</Btn>
      </>}
      <div className="divider" />
      <Btn kind="danger" icon="logout" onClick={leave}>Leave group</Btn>
    </Modal>
  );
}

