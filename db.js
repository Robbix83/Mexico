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

  -- Background datasheet finder queue --
  CREATE TABLE IF NOT EXISTS ds_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model         TEXT    NOT NULL,
    manufacturer  TEXT    NOT NULL,
    source        TEXT    NOT NULL DEFAULT 'pricelist',
    status        TEXT    NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_attempt  TEXT,
    found_path    TEXT,
    error_msg     TEXT,
    next_retry_at TEXT    NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_queue_model_source ON ds_queue(model, source);
  CREATE INDEX IF NOT EXISTS idx_ds_queue_pending ON ds_queue(status, next_retry_at);

  -- Per-manufacturer enabled/disabled setting for ds-finder --
  CREATE TABLE IF NOT EXISTS ds_finder_settings (
    manufacturer TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 1,
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Purchase requisitions (דרישת רכש) --
  CREATE TABLE IF NOT EXISTS requisitions (
    id           TEXT    PRIMARY KEY,
    req_number   TEXT    NOT NULL,
    supplier     TEXT,
    requester    TEXT,
    notes        TEXT,
    items_json   TEXT    NOT NULL DEFAULT '[]',
    show_prices  INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_req_created  ON requisitions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_req_number   ON requisitions(req_number);

  -- User join requests (public landing page form) --
  CREATE TABLE IF NOT EXISTS user_requests (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name           TEXT NOT NULL,
    last_name            TEXT NOT NULL,
    email                TEXT NOT NULL,
    phone                TEXT NOT NULL,
    role_title           TEXT NOT NULL,
    division             TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending',
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at          TEXT,
    reviewed_by_username TEXT,
    rejection_note       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_requests_status ON user_requests(status, created_at DESC);
`);

// ── Migrations for Drop 2B (extra columns on doc_pack_files) ──
// Each in its own try/catch since ALTER TABLE ADD COLUMN throws if it already exists.
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN visibility TEXT NOT NULL DEFAULT 'client'"); } catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN note TEXT"); }                                catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN contributor TEXT"); }                         catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN external_path TEXT"); }                       catch (_) {}

// Migration: doc_pack_files.filename was originally NOT NULL. With Drop 2B,
// datasheets are stored as "linked" rows (filename NULL, external_path set).
// SQLite can't DROP NOT NULL in place; the only way is to recreate the
// table. We detect the constraint via PRAGMA table_info and migrate if so.
try {
  const cols = db.prepare("PRAGMA table_info(doc_pack_files)").all();
  const filenameCol = cols.find(c => c.name === 'filename');
  if (filenameCol && filenameCol.notnull === 1) {
    console.log('[db] migrating doc_pack_files to make filename nullable…');
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE doc_pack_files__new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id       INTEGER NOT NULL REFERENCES doc_packs(id) ON DELETE CASCADE,
        kind          TEXT    NOT NULL DEFAULT 'photo',
        filename      TEXT,
        original_name TEXT,
        mime          TEXT,
        size          INTEGER NOT NULL DEFAULT 0,
        caption       TEXT,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        visibility    TEXT    NOT NULL DEFAULT 'client',
        note          TEXT,
        contributor   TEXT,
        external_path TEXT
      );
      INSERT INTO doc_pack_files__new
        (id, pack_id, kind, filename, original_name, mime, size, caption, sort_order, created_at, visibility, note, contributor, external_path)
        SELECT id, pack_id, kind, filename, original_name, mime, size, caption, sort_order, created_at,
               COALESCE(visibility,'client'), note, contributor, external_path
          FROM doc_pack_files;
      DROP TABLE doc_pack_files;
      ALTER TABLE doc_pack_files__new RENAME TO doc_pack_files;
      CREATE INDEX IF NOT EXISTS idx_doc_pack_files_pack    ON doc_pack_files(pack_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_doc_pack_files_created ON doc_pack_files(pack_id, created_at DESC);
      COMMIT;
    `);
    console.log('[db] ✓ doc_pack_files migration done');
  }
} catch (e) {
  console.error('[db] doc_pack_files filename migration failed:', e.message);
  try { db.exec('ROLLBACK'); } catch {}
}

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

// Migration: add status column to requisitions (draft/pending/approved/done)
try {
  db.exec("ALTER TABLE requisitions ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
} catch(e) { /* column already exists — skip */ }

// Seed admin user from env vars if no users exist
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  const adminUser = process.env.ADMIN_USER || 'admin';
  // L2 — In production we REFUSE to seed with the known-default password.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    console.error('[fatal] ADMIN_PASSWORD env var is required when seeding the first admin in production.');
    process.exit(1);
  }
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
  listUsers:         db.prepare('SELECT id,username,role,active,created_at,last_login,must_change_password,login_attempts,sections FROM users ORDER BY created_at DESC'),
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

  // DS Finder queue
  createDsQueueItem: db.prepare(
    "INSERT OR IGNORE INTO ds_queue (model, manufacturer, source) VALUES (?, ?, ?)"
  ),
  getDsQueueStats: db.prepare(`
    SELECT
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='found'     THEN 1 ELSE 0 END) AS found,
      SUM(CASE WHEN status='not_found' THEN 1 ELSE 0 END) AS not_found,
      SUM(CASE WHEN status='error'     THEN 1 ELSE 0 END) AS error,
      COUNT(*) AS total
    FROM ds_queue
  `),
  listDsQueuePending: db.prepare(`
    SELECT * FROM ds_queue
    WHERE status IN ('pending','error') AND next_retry_at <= datetime('now')
    ORDER BY next_retry_at ASC
    LIMIT ?
  `),
  markDsQueueFound: db.prepare(`
    UPDATE ds_queue SET status='found', found_path=?, last_attempt=datetime('now'), error_msg=NULL
    WHERE id=?
  `),
  markDsQueueNotFound: db.prepare(
    "UPDATE ds_queue SET status='not_found', last_attempt=datetime('now') WHERE id=?"
  ),
  markDsQueueError: db.prepare(`
    UPDATE ds_queue SET status='error', attempts=attempts+1,
      last_attempt=datetime('now'), error_msg=?, next_retry_at=?
    WHERE id=?
  `),
  listDsQueue: db.prepare(`
    SELECT * FROM ds_queue
    WHERE (? IS NULL OR status=?)
    ORDER BY created_at DESC
    LIMIT ?
  `),
  listDsQueueActive: db.prepare(`
    SELECT * FROM ds_queue
    WHERE status != 'found'
    ORDER BY status ASC, created_at DESC
    LIMIT ?
  `),
  resetDsQueueErrors: db.prepare(`
    UPDATE ds_queue SET next_retry_at=datetime('now')
    WHERE status='error'
  `),
  resetDsQueueFoundItem: db.prepare(`
    UPDATE ds_queue
    SET status='pending', found_path=NULL, attempts=0,
        next_retry_at=datetime('now'), error_msg=NULL
    WHERE id=?
  `),
  // Per-manufacturer stats + enabled status (joined)
  listDsFinderManufacturers: db.prepare(`
    SELECT
      q.manufacturer,
      COALESCE(s.enabled, 1) AS enabled,
      SUM(CASE WHEN q.status='found'     THEN 1 ELSE 0 END) AS found,
      SUM(CASE WHEN q.status='pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN q.status='not_found' THEN 1 ELSE 0 END) AS not_found,
      SUM(CASE WHEN q.status='error'     THEN 1 ELSE 0 END) AS error,
      COUNT(*) AS total
    FROM ds_queue q
    LEFT JOIN ds_finder_settings s ON LOWER(s.manufacturer) = LOWER(q.manufacturer)
    GROUP BY q.manufacturer
    ORDER BY total DESC
  `),
  setDsFinderSetting: db.prepare(`
    INSERT INTO ds_finder_settings (manufacturer, enabled, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(manufacturer) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at
  `),

  // Requisitions
  listRequisitions: db.prepare(`
    SELECT id, req_number, supplier, requester, show_prices, status,
           created_at, updated_at, created_by, items_json
    FROM requisitions
    ORDER BY created_at DESC
  `),
  getRequisition: db.prepare('SELECT * FROM requisitions WHERE id = ?'),
  updateRequisitionStatus: db.prepare(`UPDATE requisitions SET status=?, updated_at=datetime('now') WHERE id=?`),
  maxReqNumberGlobal: db.prepare(
    // Handles both old format (REQ-YYYY-NNNN) and new plain format (NNNN)
    `SELECT MAX(CAST(
       CASE WHEN req_number GLOB 'REQ-????-*'
            THEN substr(req_number, 10)
            ELSE req_number
       END AS INTEGER)) AS m
     FROM requisitions`
  ),
  insertRequisition: db.prepare(`INSERT INTO requisitions
    (id, req_number, supplier, requester, notes, items_json, show_prices, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateRequisition: db.prepare(`UPDATE requisitions SET
    supplier    = ?,
    requester   = ?,
    notes       = ?,
    items_json  = ?,
    show_prices = ?,
    updated_at  = datetime('now')
    WHERE id = ?`),
  deleteRequisition: db.prepare('DELETE FROM requisitions WHERE id = ?'),

  // User join requests
  createUserRequest: db.prepare(`INSERT INTO user_requests
    (first_name, last_name, email, phone, role_title, division) VALUES (?, ?, ?, ?, ?, ?)`),
  listUserRequests:     db.prepare('SELECT * FROM user_requests ORDER BY created_at DESC'),
  listPendingUserRequests: db.prepare("SELECT * FROM user_requests WHERE status='pending' ORDER BY created_at DESC"),
  getUserRequest:       db.prepare('SELECT * FROM user_requests WHERE id = ?'),
  approveUserRequest:   db.prepare(`UPDATE user_requests
    SET status='approved', reviewed_at=datetime('now'), reviewed_by_username=? WHERE id=?`),
  rejectUserRequest:    db.prepare(`UPDATE user_requests
    SET status='rejected', reviewed_at=datetime('now'), reviewed_by_username=?, rejection_note=? WHERE id=?`),
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

  // DS Finder queue
  createDsQueueItem: (model, manufacturer, source) =>
    stmts.createDsQueueItem.run(model, manufacturer, source || 'pricelist'),
  getDsQueueStats:    ()            => stmts.getDsQueueStats.get(),
  listDsQueuePending: (limit = 50)  => stmts.listDsQueuePending.all(limit),
  markDsQueueFound:   (id, p)       => stmts.markDsQueueFound.run(p, id),
  markDsQueueNotFound:(id)          => stmts.markDsQueueNotFound.run(id),
  markDsQueueError:   (id, msg, nextRetryAt) => stmts.markDsQueueError.run(msg || null, nextRetryAt, id),
  listDsQueue: (status = null, limit = 200) =>
    stmts.listDsQueue.all(status, status, limit),
  listDsFinderManufacturers: () => stmts.listDsFinderManufacturers.all(),
  setDsFinderSetting: (manufacturer, enabled) =>
    stmts.setDsFinderSetting.run(manufacturer, enabled ? 1 : 0),
  resetDsQueueErrors:    ()    => stmts.resetDsQueueErrors.run(),
  listDsQueueActive:     (limit = 500) => stmts.listDsQueueActive.all(limit),
  resetDsQueueFoundItem: (id)  => stmts.resetDsQueueFoundItem.run(id),

  // Requisitions
  listRequisitions: () => stmts.listRequisitions.all(),
  getRequisition:   (id) => stmts.getRequisition.get(id),
  nextReqNumber: () => {
    const row = stmts.maxReqNumberGlobal.get();
    const seq = (row?.m || 0) + 1;
    return String(seq).padStart(4, '0');
  },
  createRequisition: ({ id, reqNumber, supplier, requester, notes, itemsJson, showPrices, status, createdBy }) =>
    stmts.insertRequisition.run(
      id, reqNumber,
      supplier || null, requester || null, notes || null,
      itemsJson || '[]', showPrices ? 1 : 0,
      status || 'draft',
      createdBy || null
    ),
  updateRequisitionStatus: (id, status) => stmts.updateRequisitionStatus.run(status, id),
  updateRequisition: (id, { supplier, requester, notes, itemsJson, showPrices }) =>
    stmts.updateRequisition.run(
      supplier || null, requester || null, notes || null,
      itemsJson || '[]', showPrices ? 1 : 0,
      id
    ),
  deleteRequisition: (id) => stmts.deleteRequisition.run(id),

  // User join requests
  createUserRequest:   (firstName, lastName, email, phone, roleTitle, division) =>
    stmts.createUserRequest.run(firstName, lastName, email, phone, roleTitle, division),
  listUserRequests:    ()  => stmts.listUserRequests.all(),
  listPendingUserRequests: () => stmts.listPendingUserRequests.all(),
  getUserRequest:      (id) => stmts.getUserRequest.get(id),
  approveUserRequest:  (id, byUsername) => stmts.approveUserRequest.run(byUsername, id),
  rejectUserRequest:   (id, byUsername, note) => stmts.rejectUserRequest.run(byUsername, note || null, id),
};
