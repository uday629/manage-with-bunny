// Narrow, typed bridge. The renderer never gets Node, ipcRenderer or raw secrets beyond its session token.
import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = ['state', 'hosts', 'suggestDataDir', 'pickFolder', 'createWorkspace', 'openWorkspace', 'probeCode', 'join', 'useExistingAccount', 'cancelJoin', 'login', 'resetWithCode',
  'changePassword', 'session', 'reconnect', 'signedOut', 'logout', 'leaveWorkspace', 'stopHosting', 'encrypt', 'decryptMany', 'checkPeer', 'trustPeer', 'moveStorage',
  'openDataFolder', 'micAccess', 'exportTable', 'netDiagnose', 'repairFirewall', 'openExternal', 'download', 'notify', 'setBadge', 'setAutoStart', 'setCloseToTray', 'quit'] as const;

const api: Record<string, unknown> = {};
for (const ch of CHANNELS) {
  api[ch] = async (...args: unknown[]) => {
    const r = await ipcRenderer.invoke(ch, ...args);
    if (!r?.ok) throw new Error(r?.error || 'Error');
    return r.data;
  };
}
api.onEvent = (cb: (ch: string, payload: unknown) => void) => {
  const fn = (_e: unknown, ch: string, payload: unknown) => cb(ch, payload);
  ipcRenderer.on('bunny:event', fn);
  return () => ipcRenderer.removeListener('bunny:event', fn);
};

contextBridge.exposeInMainWorld('bunny', Object.freeze(api));
