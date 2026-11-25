import { DatabaseSync, StatementSync } from 'node:sqlite';
import crypto from 'node:crypto';

export type Row = Record<string, any>;
type P = string | number | bigint | null | Uint8Array;

export class Db {
  raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;');
    migrate(this);
  }
  private st(sql: string) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  private norm(p: unknown[]): P[] {
    return p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as P)));
  }
  get<T = Row>(sql: string, ...p: unknown[]): T | undefined { return this.st(sql).get(...this.norm(p)) as T | undefined; }
  all<T = Row>(sql: string, ...p: unknown[]): T[] { return this.st(sql).all(...this.norm(p)) as T[]; }
  run(sql: string, ...p: unknown[]) { return this.st(sql).run(...this.norm(p)); }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.raw.exec('COMMIT'); return r; } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
  meta(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM meta WHERE key=?', key)?.value; }
  setMeta(key: string, value: string) { this.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  close() { this.cache.clear(); this.raw.close(); }
}

export const newId = () => crypto.randomBytes(12).toString('base64url');
export const now = () => Date.now();

const MIGRATIONS: string[] = [
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE roles(id TEXT PRIMARY KEY, name TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]', is_owner INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE users(
     id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
     role_id TEXT REFERENCES roles(id), manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     status TEXT NOT NULL CHECK(status IN ('pending','active','disabled','rejected')), is_owner INTEGER NOT NULL DEFAULT 0,
     kdf_salt TEXT NOT NULL, auth_hash TEXT NOT NULL, pubkey TEXT NOT NULL, enc_priv TEXT NOT NULL, key_version INTEGER NOT NULL DEFAULT 1,
     color TEXT NOT NULL, created_at INTEGER NOT NULL, approved_at INTEGER, last_seen INTEGER,
     pending_token_hash TEXT, reset_hash TEXT, reset_expires INTEGER, device_name TEXT NOT NULL DEFAULT '');
   CREATE INDEX users_manager ON users(manager_id);
   CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
     device_name TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE conversations(id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('dm','group')), name TEXT NOT NULL DEFAULT '', dm_key TEXT UNIQUE,
     created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, last_msg_at INTEGER NOT NULL);
   CREATE TABLE conv_members(conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     is_admin INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, last_read_id INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conv_id,user_id));
   CREATE INDEX conv_members_user ON conv_members(user_id);
   CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK(kind IN ('text','file','system')), body TEXT NOT NULL DEFAULT '', e2e INTEGER NOT NULL DEFAULT 0, file_id TEXT, reply_to INTEGER,
     client_id TEXT, created_at INTEGER NOT NULL, edited_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX messages_conv ON messages(conv_id, id);
   CREATE UNIQUE INDEX messages_client ON messages(sender_id, client_id) WHERE client_id IS NOT NULL;
   CREATE TABLE blobs(sha TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE files(id TEXT PRIMARY KEY, sha TEXT NOT NULL REFERENCES blobs(sha), name TEXT NOT NULL, ext TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, mime TEXT NOT NULL,
     uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL, scope TEXT NOT NULL CHECK(scope IN ('conv','task')), scope_id TEXT NOT NULL,
     group_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX files_scope ON files(scope, scope_id);
   CREATE INDEX files_sha ON files(sha);
   CREATE INDEX files_group ON files(group_id);
   CREATE TABLE uploads(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
     scope TEXT NOT NULL, scope_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]',
     assigner_id TEXT REFERENCES users(id) ON DELETE SET NULL, assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL, parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
     status TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     started_at INTEGER, submitted_at INTEGER, completed_at INTEGER, revisions INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX tasks_assignee ON tasks(assignee_id, created_at);
   CREATE INDEX tasks_assigner ON tasks(assigner_id, created_at);
   CREATE INDEX tasks_parent ON tasks(parent_id);
   CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     type TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', file_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
   CREATE INDEX task_events_task ON task_events(task_id, id);
   CREATE TABLE sheets(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, columns TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE sheet_rows(id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE, data TEXT NOT NULL, position INTEGER NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX sheet_rows_sheet ON sheet_rows(sheet_id, position);
   CREATE TABLE sheet_shares(sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, can_edit INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sheet_id,user_id));
   CREATE TABLE reviews(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month TEXT NOT NULL, reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     rating INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, month));
   CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '');
   CREATE INDEX audit_at ON audit(at);`,
  // v2: remote profiles (members who cannot be on the Wi-Fi; a caretaker keeps their work updated) + work log
  `ALTER TABLE users ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN caretaker_id TEXT REFERENCES users(id) ON DELETE SET NULL;
   ALTER TABLE users ADD COLUMN remote_note TEXT NOT NULL DEFAULT '';
   ALTER TABLE task_events ADD COLUMN on_behalf_of TEXT;
   CREATE TABLE worklog(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     day TEXT NOT NULL, hours REAL, note TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
   CREATE INDEX worklog_user ON worklog(user_id, day);`,
  // v3: full-text search (trigram works for Bengali, English and partial words). Only non-encrypted messages are indexed;
  // direct messages are end-to-end encrypted and searched on the member's own device instead.
  `CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='trigram');
   CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.e2e=0 AND new.kind<>'system' BEGIN
     INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
   CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages WHEN old.e2e=0 AND old.kind<>'system' BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body); END;
   CREATE TRIGGER messages_fts_au AFTER UPDATE OF body ON messages WHEN old.e2e=0 AND old.kind<>'system' BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
     INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body); END;
   INSERT INTO messages_fts(rowid, body) SELECT id, body FROM messages WHERE e2e=0 AND kind<>'system';
   CREATE INDEX tasks_completed ON tasks(assignee_id, completed_at);
   CREATE INDEX tasks_status ON tasks(status, assignee_id);
   CREATE INDEX messages_sender ON messages(conv_id, sender_id, id);
   CREATE INDEX files_uploader ON files(uploader_id);`,
  // v4: profile photos (separate table so user lists stay small), client / hours / quality rating for the work report
  `CREATE TABLE avatars(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data BLOB NOT NULL, mime TEXT NOT NULL, updated_at INTEGER NOT NULL);
   ALTER TABLE users ADD COLUMN avatar_ver INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN client TEXT NOT NULL DEFAULT '';
   ALTER TABLE tasks ADD COLUMN hours_spent REAL;
   ALTER TABLE tasks ADD COLUMN rating INTEGER;
   ALTER TABLE worklog ADD COLUMN client TEXT NOT NULL DEFAULT '';
   CREATE INDEX tasks_client ON tasks(client);
   CREATE INDEX tasks_done_at ON tasks(completed_at);
   CREATE INDEX worklog_day ON worklog(day);`,
  // v5: attendance (one row per person per day; days without a row are computed as absent / off / holiday)
  `CREATE TABLE attendance(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('present','late','half','leave','absent','holiday')), check_in INTEGER, check_out INTEGER,
     note TEXT NOT NULL DEFAULT '', set_by TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, day));
   CREATE INDEX attendance_day ON attendance(day);`,
];

function migrate(db: Db) {
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  const row = db.raw.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.raw.prepare('INSERT INTO schema_version(v) VALUES(0)').run();
  while (v < MIGRATIONS.length) {
    db.raw.exec('BEGIN');
    try {
      db.raw.exec(MIGRATIONS[v]);
      v++;
      db.raw.prepare('UPDATE schema_version SET v=?').run(v);
      db.raw.exec('COMMIT');
    } catch (e) { db.raw.exec('ROLLBACK'); throw e; }
  }
}
