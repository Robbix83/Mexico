const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.sqlite');

// Ensure data directory exists
const fs = require('fs');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_login  TEXT
  );

  CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    username    TEXT,
    action      TEXT NOT NULL,
    detail      TEXT,
    ip          TEXT,
    ua          TEXT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_user      ON audit(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit(action);

  CREATE TABLE IF NOT EXISTS warehouse_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    data        TEXT    NOT NULL DEFAULT '[]',
    imported_at TEXT,
    count       INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO warehouse_state (id, data, count) VALUES (1, '[]', 0);

  -- Documentation portfolios ("תיק תיעוד") --
  CREATE TABLE IF NOT EXISTS doc_packs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL,
    type                TEXT    NOT NULL DEFAULT 'cctv',
    data                TEXT    NOT NULL DEFAULT '{}',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by_id       INTEGER,
    created_by_username TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_doc_packs_updated ON doc_packs(updated_at DESC);

  CREATE TABLE IF NOT EXISTS doc_pack_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id       INTEGER NOT NULL REFERENCES doc_packs(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL DEFAULT 'photo',
    filename      TEXT,
    original_name TEXT,
    mime          TEXT,
    size          INTEGER NOT NULL DEFAULT 0,
    caption       TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_doc_pack_files_pack    ON doc_pack_files(pack_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_doc_pack_files_created ON doc_pack_files(pack_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS doc_pack_shares (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id             INTEGER NOT NULL REFERENCES doc_packs(id) ON DELETE CASCADE,
    token               TEXT    NOT NULL UNIQUE,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by_username TEXT,
    expires_at          TEXT,
    revoked_at          TEXT,
    last_used_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_doc_pack_shares_pack  ON doc_pack_shares(pack_id);
  CREATE INDEX IF NOT EXISTS idx_doc_pack_shares_token ON doc_pack_shares(token);
`);

// ── Migrations for Drop 2B (extra columns on doc_pack_files) ──
// Each in its own try/catch since ALTER TABLE ADD COLUMN throws if it already exists.
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN visibility TEXT NOT NULL DEFAULT 'client'"); } catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN note TEXT"); }                                catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN contributor TEXT"); }                         catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN external_path TEXT"); }                       catch (_) {}

// Migration: add must_change_password column to existing DBs
try {
  db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
} catch(e) { /* column already exists — skip */ }

// Migration: add sections column (JSON array of allowed views, NULL = role-based default)
try {
  db.exec("ALTER TABLE users ADD COLUMN sections TEXT");
} catch(e) { /* column already exists — skip */ }

// Migration: add login_attempts column for lockout tracking
try {
  db.exec("ALTER TABLE users ADD COLUMN login_attempts INTEGER NOT NULL DEFAULT 0");
} catch(e) { /* column already exists — skip */ }

// Seed admin user from env vars if no users exist
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(adminPass, 12);
  db.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(adminUser, hash, 'admin');
  console.log(`[db] Seeded admin user: ${adminUser}`);
}

// ── User queries ──────────────────────────────────────────────────────────────

const stmts = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  getUserById:       db.prepare('SELECT * FROM users WHERE id = ?'),
  listUsers:         db.prepare('SELECT id,username,role,active,created_at,last_login,must_change_password,login_attempts FROM users ORDER BY created_at DESC'),
  createUser:        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  setMustChangePassword: db.prepare('UPDATE users SET must_change_password = ? WHERE id = ?'),
  setSections:       db.prepare('UPDATE users SET sections = ? WHERE id = ?'),
  deleteUser:        db.prepare('DELETE FROM users WHERE id = ?'),
  countAdmins:       db.prepare("SELECT COUNT(*) as n FROM users WHERE role='admin' AND active=1"),
  updateLastLogin:   db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  setActive:         db.prepare('UPDATE users SET active = ? WHERE id = ?'),
  setPassword:       db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setRole:           db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  incrementLoginAttempts: db.prepare('UPDATE users SET login_attempts = login_attempts + 1 WHERE id = ?'),
  resetLoginAttempts:     db.prepare('UPDATE users SET login_attempts = 0 WHERE id = ?'),

  // Audit
  insertAudit: db.prepare(
    'INSERT INTO audit (user_id, username, action, detail, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  listAudit: db.prepare(`
    SELECT a.id, a.username, a.action, a.detail, a.ip, a.timestamp
    FROM audit a
    WHERE (? IS NULL OR a.username = ?)
      AND (? IS NULL OR a.action   = ?)
      AND (? IS NULL OR a.timestamp >= ?)
      AND (? IS NULL OR a.timestamp <= ?)
    ORDER BY a.timestamp DESC
    LIMIT ? OFFSET ?
  `),
  countAudit: db.prepare(`
    SELECT COUNT(*) as n FROM audit a
    WHERE (? IS NULL OR a.username = ?)
      AND (? IS NULL OR a.action   = ?)
      AND (? IS NULL OR a.timestamp >= ?)
      AND (? IS NULL OR a.timestamp <= ?)
  `),

  // Warehouse
  getWarehouse: db.prepare('SELECT data, imported_at, count FROM warehouse_state WHERE id = 1'),
  setWarehouse: db.prepare("UPDATE warehouse_state SET data = ?, count = ?, imported_at = datetime('now') WHERE id = 1"),

  // Doc packs
  listDocPacks:   db.prepare('SELECT id, name, type, created_at, updated_at, created_by_username FROM doc_packs ORDER BY updated_at DESC'),
  getDocPack:     db.prepare('SELECT * FROM doc_packs WHERE id = ?'),
  createDocPack:  db.prepare("INSERT INTO doc_packs (name, type, data, created_by_id, created_by_username) VALUES (?, ?, ?, ?, ?)"),
  updateDocPack:  db.prepare("UPDATE doc_packs SET name = ?, data = ?, updated_at = datetime('now') WHERE id = ?"),
  deleteDocPack:  db.prepare('DELETE FROM doc_packs WHERE id = ?'),
  // Files
  addDocPackFile: db.prepare(`INSERT INTO doc_pack_files
    (pack_id, kind, filename, original_name, mime, size, caption, sort_order, visibility, note, contributor, external_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  listDocPackFiles:  db.prepare('SELECT * FROM doc_pack_files WHERE pack_id = ? ORDER BY sort_order ASC, id ASC'),
  listDocPackFilesByDate: db.prepare('SELECT * FROM doc_pack_files WHERE pack_id = ? ORDER BY created_at DESC, id DESC'),
  getDocPackFile:    db.prepare('SELECT * FROM doc_pack_files WHERE id = ?'),
  deleteDocPackFile: db.prepare('DELETE FROM doc_pack_files WHERE id = ?'),
  updateDocPackFileMeta: db.prepare(`UPDATE doc_pack_files SET
    caption    = COALESCE(?, caption),
    sort_order = COALESCE(?, sort_order),
    visibility = COALESCE(?, visibility),
    note       = COALESCE(?, note),
    kind       = COALESCE(?, kind)
    WHERE id = ?`),
  sumDocPackFileSize: db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM doc_pack_files WHERE pack_id = ? AND filename IS NOT NULL'),

  // Doc pack shares (public tokens)
  createDocPackShare: db.prepare(`INSERT INTO doc_pack_shares
    (pack_id, token, created_by_username, expires_at) VALUES (?, ?, ?, ?)`),
  listDocPackShares:  db.prepare('SELECT id, token, created_at, created_by_username, expires_at, revoked_at, last_used_at FROM doc_pack_shares WHERE pack_id = ? ORDER BY created_at DESC'),
  getDocPackShareByToken: db.prepare('SELECT * FROM doc_pack_shares WHERE token = ?'),
  revokeDocPackShare:   db.prepare("UPDATE doc_pack_shares SET revoked_at = datetime('now') WHERE id = ?"),
  touchDocPackShare:    db.prepare("UPDATE doc_pack_shares SET last_used_at = datetime('now') WHERE id = ?"),
};

module.exports = {
  db,

  // Users
  getUserByUsername: (username) => stmts.getUserByUsername.get(username),
  getUserById:       (id)       => stmts.getUserById.get(id),
  listUsers:         ()         => stmts.listUsers.all(),
  createUser: (username, plainPassword, role = 'viewer') => {
    const hash = bcrypt.hashSync(plainPassword, 12);
    const r = stmts.createUser.run(username, hash, role);
    stmts.setMustChangePassword.run(1, r.lastInsertRowid);
    // New viewers start with no sections (empty — admin must grant access)
    if (role === 'viewer') stmts.setSections.run('[]', r.lastInsertRowid);
    return r;
  },
  setMustChangePassword: (id, val) => stmts.setMustChangePassword.run(val ? 1 : 0, id),
  setSections: (id, sectionsArr) => stmts.setSections.run(
    sectionsArr !== null ? JSON.stringify(sectionsArr) : null, id
  ),
  deleteUser:  (id) => stmts.deleteUser.run(id),
  countAdmins: ()  => stmts.countAdmins.get().n,
  updateLastLogin: (id) => stmts.updateLastLogin.run(id),
  setActive:       (id, active) => stmts.setActive.run(active ? 1 : 0, id),
  setPassword: (id, plainPassword) => {
    const hash = bcrypt.hashSync(plainPassword, 12);
    return stmts.setPassword.run(hash, id);
  },
  setRole: (id, role) => stmts.setRole.run(role, id),
  incrementLoginAttempts: (id) => stmts.incrementLoginAttempts.run(id),
  resetLoginAttempts:     (id) => stmts.resetLoginAttempts.run(id),

  // Audit
  logAudit: (userId, username, action, detail, ip, ua) =>
    stmts.insertAudit.run(userId ?? null, username ?? null, action, detail ?? null, ip ?? null, ua ?? null),

  listAudit: ({ username, action, from, to, limit = 100, offset = 0 } = {}) => {
    const rows = stmts.listAudit.all(
      username ?? null, username ?? null,
      action   ?? null, action   ?? null,
      from     ?? null, from     ?? null,
      to       ?? null, to       ?? null,
      limit, offset
    );
    const total = stmts.countAudit.get(
      username ?? null, username ?? null,
      action   ?? null, action   ?? null,
      from     ?? null, from     ?? null,
      to       ?? null, to       ?? null,
    ).n;
    return { rows, total };
  },

  // Warehouse
  getWarehouse: () => stmts.getWarehouse.get(),
  setWarehouse: (dataJson, count) => stmts.setWarehouse.run(dataJson, count),

  // Doc packs
  listDocPacks: () => stmts.listDocPacks.all(),
  getDocPack:   (id) => stmts.getDocPack.get(id),
  createDocPack: (name, type, dataJson, userId, username) =>
    stmts.createDocPack.run(name, type || 'cctv', dataJson || '{}', userId || null, username || null),
  updateDocPack: (id, name, dataJson) => stmts.updateDocPack.run(name, dataJson, id),
  deleteDocPack: (id) => stmts.deleteDocPack.run(id),

  // Doc pack files
  addDocPackFile: (opts) => stmts.addDocPackFile.run(
    opts.packId,
    opts.kind || 'photo',
    opts.filename || null,
    opts.originalName || null,
    opts.mime || null,
    opts.size || 0,
    opts.caption || null,
    opts.sortOrder || 0,
    opts.visibility || 'client',
    opts.note || null,
    opts.contributor || null,
    opts.externalPath || null,
  ),
  listDocPackFiles:       (packId) => stmts.listDocPackFiles.all(packId),
  listDocPackFilesByDate: (packId) => stmts.listDocPackFilesByDate.all(packId),
  getDocPackFile:         (id)     => stmts.getDocPackFile.get(id),
  deleteDocPackFile:      (id)     => stmts.deleteDocPackFile.run(id),
  updateDocPackFileMeta: (id, fields = {}) => stmts.updateDocPackFileMeta.run(
    fields.caption    ?? null,
    fields.sortOrder  ?? null,
    fields.visibility ?? null,
    fields.note       ?? null,
    fields.kind       ?? null,
    id,
  ),
  sumDocPackFileSize: (packId) => stmts.sumDocPackFileSize.get(packId).total,

  // Doc pack shares
  createDocPackShare: (packId, token, username, expiresAt) =>
    stmts.createDocPackShare.run(packId, token, username || null, expiresAt || null),
  listDocPackShares:        (packId) => stmts.listDocPackShares.all(packId),
  getDocPackShareByToken:   (token)  => stmts.getDocPackShareByToken.get(token),
  revokeDocPackShare:       (id)     => stmts.revokeDocPackShare.run(id),
  touchDocPackShare:        (id)     => stmts.touchDocPackShare.run(id),
};
