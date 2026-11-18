import { useEffect, useState } from 'react';
import { bunny, toast } from '../api';
import { Btn, ErrorBox, Icon, Modal, Spinner } from '../ui';

interface Diagnosis {
  platform: string; interfaces: { name: string; address: string }[]; profiles: { alias: string; category: string }[];
  firewall: string; host: { addr: string; port: number; reachable: boolean; sameSubnet: boolean } | null; beaconsSeen: number;
  findings: { level: 'ok' | 'warn' | 'bad'; text: string; fix?: 'firewall' }[];
}

export function NetCheckModal({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<Diagnosis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => { setD(null); setErr(null); bunny.netDiagnose().then(setD).catch((e: Error) => setErr(e.message)); };
  useEffect(run, []);
  const fix = async () => {
    setBusy(true);
    try { await bunny.repairFirewall(); toast('Firewall rule repaired', 'ok'); run(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Network check" onClose={onClose} wide footer={<><Btn icon="refresh" onClick={run}>Run again</Btn><Btn kind="primary" onClick={onClose}>Done</Btn></>}>
      {err && <ErrorBox text={err} />}
      {!d && !err && <div className="row"><Spinner /><span className="muted">Checking this computer and the network...</span></div>}
      {d && <>
        <div className="col" style={{ gap: 8 }}>
          {d.findings.map((f, i) => (
            <div key={i} className={'finding ' + f.level}>
              <Icon name={f.level === 'ok' ? 'check' : f.level === 'warn' ? 'bell' : 'x'} size={16} />
              <span className="grow">{f.text}</span>
              {f.fix === 'firewall' && <Btn small kind="primary" loading={busy} onClick={fix}>Fix it</Btn>}
            </div>
          ))}
        </div>
        <dl className="kv">
          <dt>This computer</dt><dd>{d.interfaces.map((i) => `${i.address} (${i.name})`).join(', ') || 'No network'}</dd>
          {d.profiles.length > 0 && <><dt>Network type</dt><dd>{d.profiles.map((p) => `${p.alias}: ${p.category}`).join(', ')}</dd></>}
          {d.platform === 'win32' && <><dt>Firewall rule</dt><dd>{d.firewall === 'ok' ? 'Present (local network only)' : d.firewall === 'missing' ? 'Missing' : d.firewall === 'blocked' ? 'Blocked by a Windows rule' : d.firewall === 'limited' ? 'Private networks only' : 'Not checked (development build)'}</dd></>}
          {d.host && <><dt>Host</dt><dd>{d.host.addr}:{d.host.port} · {d.host.reachable ? 'reachable' : 'not reachable'}{d.host.sameSubnet ? '' : ' · different network'}</dd></>}
        </dl>
        <p className="dim" style={{ fontSize: 12 }}>Tips: use the main office Wi-Fi (guest networks usually block devices from seeing each other), keep the host computer on, and reserve the host's IP address in the router. If discovery is blocked, paste the full invite (code and address) when joining.</p>
      </>}
    </Modal>
  );
}

// "Code + address" invite text. Joining parses both, so it works even where discovery is blocked.
export function inviteText(name: string, code: string, addresses: string[], port: number) {
  return `Join "${name}" on Manage with Bunny\nJoin code: ${code}\nHost address: ${addresses.map((a) => `${a}:${port}`).join(' or ') || 'ask the admin'}\n(Install the app, choose "Join a team" and paste this whole message.)`;
}
export function parseInvite(text: string): { code: string | null; addr: string | null } {
  const code = /([0-9A-Za-z]{5}-[0-9A-Za-z]{5}-[0-9A-Za-z]{5}-[0-9A-Za-z]{5})/.exec(text)?.[1]?.toUpperCase() || null;
  const addr = /\b((?:\d{1,3}\.){3}\d{1,3})(?::(\d{2,5}))?\b/.exec(text);
  return { code, addr: addr ? addr[1] + (addr[2] ? ':' + addr[2] : '') : null };
}
