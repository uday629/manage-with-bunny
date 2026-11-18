// Profile photo picker: choose an image, drag to position it, zoom, and save a 256x256 WebP.
import { useEffect, useRef, useState } from 'react';
import { api, loadUsers, loadMe, toast, type User } from '../api';
import { Btn, Icon, Modal } from '../ui';

const STAGE = 240, OUT = 256;

export function PhotoEditor({ user, onClose }: { user: User; onClose: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => { input.current?.click(); return () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }; }, []);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) { toast('Choose a PNG, JPEG, WebP, GIF or BMP image.', 'err'); return; }
    if (f.size > 25 * 1024 * 1024) { toast('That image is too large (max 25 MB).', 'err'); return; }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const u = URL.createObjectURL(f); urlRef.current = u;
    const im = new Image();
    im.onload = () => { setImg(im); setZoom(1); setOff({ x: 0, y: 0 }); };
    im.onerror = () => toast('Could not read that image.', 'err');
    im.src = u;
  };
  const base = img ? Math.max(STAGE / img.naturalWidth, STAGE / img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0, h = img ? img.naturalHeight * scale : 0;
  const clamp = (x: number, y: number) => ({ x: Math.max(-(w - STAGE) / 2, Math.min((w - STAGE) / 2, x)), y: Math.max(-(h - STAGE) / 2, Math.min((h - STAGE) / 2, y)) });
  useEffect(() => { setOff((o) => clamp(o.x, o.y)); }, [zoom, img]);

  const save = async () => {
    if (!img) return;
    setBusy(true);
    try {
      const c = document.createElement('canvas'); c.width = OUT; c.height = OUT;
      const ctx = c.getContext('2d')!;
      const k = OUT / STAGE;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (STAGE / 2 - w / 2 + off.x) * k, (STAGE / 2 - h / 2 + off.y) * k, w * k, h * k);
      let blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.9));
      if (!blob || blob.size > 380 * 1024) blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
      if (!blob) throw new Error('Could not process the image.');
      await api('PUT', `/api/users/${user.id}/avatar`, undefined, { raw: blob });
      await Promise.all([loadUsers(), loadMe()]);
      toast('Photo updated', 'ok');
      onClose();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api('DELETE', `/api/users/${user.id}/avatar`); await Promise.all([loadUsers(), loadMe()]); toast('Photo removed', 'ok'); onClose(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Profile photo${user.isRemote ? `: ${user.displayName}` : ''}`} onClose={onClose} footer={<>
      {!!user.avatarVer && <Btn kind="danger" icon="trash" onClick={remove} loading={busy} style={{ marginRight: 'auto' }}>Remove photo</Btn>}
      <Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!img} loading={busy} onClick={save}>Save photo</Btn>
    </>}>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {!img ? (
        <div className="photo-empty" onClick={() => input.current?.click()} role="button" tabIndex={0}>
          <Icon name="image" size={28} /><b>Choose a photo</b><span className="dim">PNG, JPEG or WebP. You can move and zoom it next.</span>
        </div>
      ) : <>
        <div className="photo-stage" style={{ width: STAGE, height: STAGE }}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; }}
          onPointerMove={(e) => { const d = drag.current; if (d) setOff(clamp(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y)); }}
          onPointerUp={() => { drag.current = null; }}
          onWheel={(e) => setZoom((z) => Math.max(1, Math.min(4, z - e.deltaY * 0.0015)))}>
          <img src={img.src} alt="" draggable={false} style={{ width: w, height: h, left: STAGE / 2 - w / 2 + off.x, top: STAGE / 2 - h / 2 + off.y }} />
          <i className="photo-mask" />
        </div>
        <label className="row" style={{ gap: 10 }}><Icon name="search" size={15} /><input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="grow" aria-label="Zoom" /></label>
        <p className="dim" style={{ fontSize: 12, textAlign: 'center' }}>Drag to position · scroll or use the slider to zoom</p>
        <Btn small kind="soft" icon="image" onClick={() => input.current?.click()} style={{ alignSelf: 'center' }}>Choose another photo</Btn>
      </>}
    </Modal>
  );
}
