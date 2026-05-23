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
`);

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
  listUsers:         db.prepare('SELECT id,username,role,active,created_at,last_login FROM users ORDER BY created_at DESC'),
  createUser:        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  updateLastLogin:   db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  setActive:         db.prepare('UPDATE users SET active = ? WHERE id = ?'),
  setPassword:       db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setRole:           db.prepare('UPDATE users SET role = ? WHERE id = ?'),

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
};

module.exports = {
  db,

  // Users
  getUserByUsername: (username) => stmts.getUserByUsername.get(username),
  getUserById:       (id)       => stmts.getUserById.get(id),
  listUsers:         ()         => stmts.listUsers.all(),
  createUser: (username, plainPassword, role = 'viewer') => {
    const hash = bcrypt.hashSync(plainPassword, 12);
    return stmts.createUser.run(username, hash, role);
  },
  updateLastLogin: (id) => stmts.updateLastLogin.run(id),
  setActive:       (id, active) => stmts.setActive.run(active ? 1 : 0, id),
  setPassword: (id, plainPassword) => {
    const hash = bcrypt.hashSync(plainPassword, 12);
    return stmts.setPassword.run(hash, id);
  },
  setRole: (id, role) => stmts.setRole.run(role, id),

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
};
