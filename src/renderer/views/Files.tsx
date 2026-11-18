import { useEffect, useState } from 'react';
import { api, useStore, fileUrl, downloadFile, fmtBytes, fmtDate, userName, toast, navigate, type FileInfo } from '../api';
import { Btn, Empty, ErrorBox, Icon, Modal, Spinner, Tabs, confirmDialog, useAsync } from '../ui';

function Thumb({ f }: { f: FileInfo }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImg = f.mime.startsWith('image/');
  useEffect(() => { if (isImg) fileUrl(f.id).then((r) => setUrl(r.url)).catch(() => {}); }, [f.id]);
  if (isImg && url) return <img src={url} alt="" loading="lazy" />;
  return <Icon name={f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('image/') ? 'image' : 'file'} size={34} />;
}

export function Preview({ f, onClose }: { f: FileInfo; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { fileUrl(f.id).then((r) => setUrl(r.url)).catch((e) => toast(e.message, 'err')); }, [f.id]);
  const kind = f.mime.split('/')[0];
  return (
    <Modal title={f.name} onClose={onClose} wide footer={<Btn kind="primary" icon="download" onClick={() => downloadFile(f)}>Download</Btn>}>
      {!url ? <Spinner /> : kind === 'video' ? <video src={url} controls autoPlay style={{ width: '100%', maxHeight: '65vh', borderRadius: 12, background: '#000' }} />
        : kind === 'image' ? <img src={url} alt={f.name} style={{ maxWidth: '100%', maxHeight: '65vh', borderRadius: 12, alignSelf: 'center' }} />
        : kind === 'audio' ? <audio src={url} controls autoPlay style={{ width: '100%' }} />
        : <p className="muted">No preview for this file type. Download it to open it on your computer.</p>}
      <p className="dim" style={{ fontSize: 12 }}>{fmtBytes(f.size)} · v{f.version} · uploaded by {userName(f.uploaderId)} {f.createdAt ? `on ${fmtDate(f.createdAt)}` : ''}</p>
    </Modal>
  );
}

function Versions({ f, onClose, onChanged }: { f: FileInfo; onClose: () => void; onChanged: () => void }) {
  const { data, loading, reload } = useAsync(() => api<FileInfo[]>('GET', `/api/files/${f.id}/versions`), [f.id]);
  const [prev, setPrev] = useState<FileInfo | null>(null);
  const del = async (v: FileInfo) => {
    if (!(await confirmDialog({ title: `Delete version ${v.version}?`, text: 'This version is removed for everyone.', ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/files/${v.id}`); reload(); onChanged(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <Modal title={`Versions of ${f.name}`} onClose={onClose} wide>
      {loading ? <Spinner /> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>Version</th><th>Size</th><th>Uploaded by</th><th>Date</th><th>Fingerprint</th><th /></tr></thead><tbody>
          {data?.map((v) => (
            <tr key={v.id}><td><b>v{v.version}</b></td><td>{fmtBytes(v.size)}</td><td>{userName(v.uploaderId)}</td><td>{v.createdAt && fmtDate(v.createdAt)}</td><td className="mono" style={{ letterSpacing: '.04em' }}>{v.sha}</td>
              <td><div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}><button className="icon-btn" title="Preview" onClick={() => setPrev(v)}><Icon name="eye" size={15} /></button><button className="icon-btn" title="Download" onClick={() => downloadFile(v)}><Icon name="download" size={15} /></button><button className="icon-btn" title="Delete" onClick={() => del(v)}><Icon name="trash" size={15} /></button></div></td></tr>
          ))}
        </tbody></table></div>
      )}
      <p className="dim" style={{ fontSize: 12 }}>Uploading a file with the same name in the same chat or task creates a new version. Identical files are stored only once on the host.</p>
      {prev && <Preview f={prev} onClose={() => setPrev(null)} />}
    </Modal>
  );
}

export function Files() {
  const ver = useStore((s) => s.ver.files);
  const convs = useStore((s) => s.convs);
  const [kind, setKind] = useState<'all' | 'video' | 'image' | 'doc'>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const { data, error, loading, reload } = useAsync(() => api<FileInfo[]>('GET', `/api/files/browse?kind=${kind}&q=${encodeURIComponent(query)}`), [kind, query, ver]);
  const [prev, setPrev] = useState<FileInfo | null>(null);
  const [vers, setVers] = useState<FileInfo | null>(null);
  const source = (f: FileInfo) => {
    if (f.scope === 'task') return { label: 'Task', go: () => navigate('tasks', f.scopeId!) };
    const c = convs.find((x) => x.id === f.scopeId);
    return { label: c ? (c.type === 'group' ? c.name : 'Direct message') : 'Chat', go: () => navigate('chat', f.scopeId!) };
  };
  const total = (data || []).reduce((a, f) => a + f.size, 0);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Files</h1><p>Everything shared in your chats and tasks. Stored on the host, transferred at full Wi-Fi speed.</p></div>
        <span className="pill">{data?.length || 0} files · {fmtBytes(total)}</span>
      </div>
      <div className="toolbar">
        <Tabs value={kind} onChange={setKind} items={[{ id: 'all', label: 'All' }, { id: 'video', label: 'Videos' }, { id: 'image', label: 'Images' }, { id: 'doc', label: 'Documents' }]} />
        <div className="search-box grow" style={{ maxWidth: 320 }}><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by file name" /></div>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Spinner /> : data && data.length ? (
        <div className="file-grid">
          {data.map((f) => {
            const s = source(f);
            return (
              <div key={f.id} className="ftile">
                <div className="thumb" onClick={() => setPrev(f)} style={{ cursor: 'pointer' }}>
                  <Thumb f={f} />
                  {(f.versions || 1) > 1 && <span className="pill blue vbadge">v{f.version} · {f.versions} versions</span>}
                </div>
                <div className="fb">
                  <b title={f.name}>{f.name}</b>
                  <small>{fmtBytes(f.size)} · {userName(f.uploaderId).split(' ')[0]} · {f.createdAt && fmtDate(f.createdAt)}</small>
                  <small><a onClick={s.go}>{s.label}</a></small>
                </div>
                <div className="fa">
                  <Btn small kind="soft" icon="eye" onClick={() => setPrev(f)}>Open</Btn>
                  <Btn small kind="soft" icon="download" onClick={() => downloadFile(f).catch((e) => toast(e.message, 'err'))} />
                  <Btn small kind="soft" icon="layers" onClick={() => setVers(f)} title="Versions" />
                </div>
              </div>
            );
          })}
        </div>
      ) : <Empty icon="files" title="No files yet" text="Files you send in chats or attach to tasks appear here." />}
      {prev && <Preview f={prev} onClose={() => setPrev(null)} />}
      {vers && <Versions f={vers} onClose={() => setVers(null)} onChanged={reload} />}
    </div>
  );
}
