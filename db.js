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

  -- BOQ: Component template library (כתב כמויות — תבניות רכיבי עלות) --
  CREATE TABLE IF NOT EXISTS boq_component_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    keywords_json   TEXT    NOT NULL DEFAULT '[]',
    components_json TEXT    NOT NULL DEFAULT '[]',
    is_system       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- BOQ: Projects --
  CREATE TABLE IF NOT EXISTS boq_projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    site        TEXT,
    status      TEXT    NOT NULL DEFAULT 'draft',
    currency    TEXT    NOT NULL DEFAULT 'ILS',
    notes       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_boq_projects_updated ON boq_projects(updated_at DESC);

  -- BOQ: Line items (סעיפים) --
  CREATE TABLE IF NOT EXISTS boq_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     INTEGER NOT NULL REFERENCES boq_projects(id) ON DELETE CASCADE,
    item_number    TEXT,
    parent_number  TEXT,
    description    TEXT    NOT NULL,
    unit           TEXT,
    quantity       REAL    NOT NULL DEFAULT 0,
    is_rfq         INTEGER NOT NULL DEFAULT 0,
    rfq_vendor     TEXT,
    rfq_notes      TEXT,
    rfq_price_ils  REAL,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    is_section     INTEGER NOT NULL DEFAULT 0,
    template_id    INTEGER REFERENCES boq_component_templates(id) ON DELETE SET NULL,
    notes          TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_boq_items_project ON boq_items(project_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_boq_items_number  ON boq_items(project_id, item_number);

  -- BOQ: Cost components (רכיבי עלות) --
  CREATE TABLE IF NOT EXISTS boq_components (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id          INTEGER NOT NULL REFERENCES boq_items(id) ON DELETE CASCADE,
    component_key    TEXT    NOT NULL,
    label            TEXT    NOT NULL,
    unit_price       REAL    NOT NULL DEFAULT 0,
    currency         TEXT    NOT NULL DEFAULT 'ILS',
    quantity         REAL    NOT NULL DEFAULT 1,
    quantity_formula TEXT,
    sort_order       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_boq_components_item ON boq_components(item_id, sort_order);

  -- Budget Control (בקרה תקציבית) --
  CREATE TABLE IF NOT EXISTS budget_projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    site        TEXT,
    status      TEXT    NOT NULL DEFAULT 'active',
    file_name   TEXT,
    notes       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_budget_projects_updated ON budget_projects(updated_at DESC);

  CREATE TABLE IF NOT EXISTS budget_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          INTEGER NOT NULL REFERENCES budget_projects(id) ON DELETE CASCADE,
    item_number         TEXT,
    description         TEXT    NOT NULL,
    unit                TEXT,
    quantity            REAL    NOT NULL DEFAULT 0,
    contract_unit_price REAL,
    contract_total      REAL    NOT NULL DEFAULT 0,
    item_cost           REAL    NOT NULL DEFAULT 0,
    total_cost          REAL    NOT NULL DEFAULT 0,
    manufacturer        TEXT,
    model               TEXT,
    sku                 TEXT,
    notes               TEXT,
    is_section          INTEGER NOT NULL DEFAULT 0,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_budget_items_project ON budget_items(project_id, sort_order);

  -- Incoming purchase orders (הזמנות נכנסות) --
  CREATE TABLE IF NOT EXISTS order_cities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    notes      TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    city_id         INTEGER NOT NULL REFERENCES order_cities(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    client          TEXT,
    contract_number TEXT,
    notes           TEXT,
    status          TEXT    NOT NULL DEFAULT 'active',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by      TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id            INTEGER NOT NULL REFERENCES order_projects(id) ON DELETE CASCADE,
    order_number          TEXT,
    order_date            TEXT,
    ordering_entity       TEXT,
    description           TEXT,
    amount_pre_vat        REAL,
    currency              TEXT    NOT NULL DEFAULT 'ILS',
    is_invoiced           INTEGER NOT NULL DEFAULT 0,
    invoice_date          TEXT,
    invoice_number        TEXT,
    invoice_file_path     TEXT,
    invoice_original_name TEXT,
    pdf_path              TEXT,
    pdf_original_name     TEXT,
    notes                 TEXT,
    raw_extracted         TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id, created_at DESC);
`);

// ── Migrations for Drop 2B (extra columns on doc_pack_files) ──
// Each in its own try/catch since ALTER TABLE ADD COLUMN throws if it already exists.
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN visibility TEXT NOT NULL DEFAULT 'client'"); } catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN note TEXT"); }                                catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN contributor TEXT"); }                         catch (_) {}
try { db.exec("ALTER TABLE doc_pack_files ADD COLUMN external_path TEXT"); }                       catch (_) {}
// Orders module migrations
try { db.exec("ALTER TABLE orders ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]'"); }            catch (_) {}

// Migration: is_template flag on doc_packs — lets a pack act as a reusable
// skeleton (project-specific content stripped) that new projects clone from.
try { db.exec("ALTER TABLE doc_packs ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0"); } catch (_) {}

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

// Migration: add TOTP 2FA columns
try { db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN totp_backup_codes TEXT"); } catch(e) {}

// Migration: add status column to requisitions (draft/pending/approved/done)
try {
  db.exec("ALTER TABLE requisitions ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
} catch(e) { /* column already exists — skip */ }

// Migration: add status column to doc_packs (draft/planning/execution/as-made/archived)
try {
  db.exec("ALTER TABLE doc_packs ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
} catch(e) { /* column already exists — skip */ }

// Migration: add contract_unit_price to boq_items
try { db.exec("ALTER TABLE boq_items ADD COLUMN contract_unit_price REAL"); } catch(e) {}
// Migration: add city to boq_component_templates (city-specific template filtering)
try { db.exec("ALTER TABLE boq_component_templates ADD COLUMN city TEXT"); } catch(e) {}
// Migration: add manufacturer + model to boq_items (Netanya / extended format)
try { db.exec("ALTER TABLE boq_items ADD COLUMN manufacturer TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE boq_items ADD COLUMN model        TEXT"); } catch(e) {}

// Migration: billing/payment certificate fields
try { db.exec("ALTER TABLE boq_projects ADD COLUMN order_id INTEGER"); }           catch(e) {}
try { db.exec("ALTER TABLE boq_projects ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none'"); } catch(e) {}
try { db.exec("ALTER TABLE boq_projects ADD COLUMN billing_date TEXT"); }           catch(e) {}
try { db.exec("ALTER TABLE boq_projects ADD COLUMN billing_notes TEXT"); }          catch(e) {}
try { db.exec("ALTER TABLE boq_items ADD COLUMN executed_qty REAL"); }              catch(e) {}
try { db.exec("ALTER TABLE boq_items ADD COLUMN billing_item_notes TEXT"); }        catch(e) {}
try { db.exec("ALTER TABLE boq_projects ADD COLUMN billing_is_partial INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE boq_projects ADD COLUMN project_number TEXT"); } catch(e) {}

// Migration: billing phases (חשבון 2, 3, ...)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boq_billing_phases (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL REFERENCES boq_projects(id) ON DELETE CASCADE,
      phase_num      INTEGER NOT NULL DEFAULT 2,
      billing_status TEXT    NOT NULL DEFAULT 'none',
      billing_date   TEXT,
      billing_notes  TEXT,
      is_partial     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS boq_billing_phase_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      phase_id     INTEGER NOT NULL REFERENCES boq_billing_phases(id) ON DELETE CASCADE,
      item_id      INTEGER NOT NULL,
      executed_qty REAL,
      notes        TEXT,
      UNIQUE(phase_id, item_id)
    );
  `);
} catch(e) {}

// Migration: order_invoices — multiple invoices per order
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_invoices (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      invoice_number   TEXT,
      invoice_date     TEXT,
      description      TEXT,
      amount_pre_vat   REAL,
      amount_with_vat  REAL,
      file_path        TEXT,
      original_name    TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_order_invoices_order ON order_invoices(order_id);
  `);
} catch(e) {}

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

  // TOTP 2FA
  setUserTotpSecret:  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?'),
  enableUserTotp:     db.prepare('UPDATE users SET totp_enabled = 1, totp_backup_codes = ? WHERE id = ?'),
  disableUserTotp:    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE id = ?'),
  updateUserBackupCodes: db.prepare('UPDATE users SET totp_backup_codes = ? WHERE id = ?'),
  listUsersWithTotp:  db.prepare('SELECT id,username,role,active,created_at,last_login,must_change_password,login_attempts,sections,totp_enabled FROM users ORDER BY created_at DESC'),

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
  listDocPacks:   db.prepare('SELECT id, name, type, status, is_template, created_at, updated_at, created_by_username FROM doc_packs ORDER BY updated_at DESC'),
  getDocPack:     db.prepare('SELECT * FROM doc_packs WHERE id = ?'),
  createDocPack:  db.prepare("INSERT INTO doc_packs (name, type, data, created_by_id, created_by_username, is_template) VALUES (?, ?, ?, ?, ?, ?)"),
  updateDocPack:  db.prepare("UPDATE doc_packs SET name = ?, data = ?, status = COALESCE(?, status), updated_at = datetime('now') WHERE id = ?"),
  setDocPackTemplate: db.prepare("UPDATE doc_packs SET is_template = ?, updated_at = datetime('now') WHERE id = ?"),
  deleteDocPack:  db.prepare('DELETE FROM doc_packs WHERE id = ?'),
  // Files
  addDocPackFile: db.prepare(`INSERT INTO doc_pack_files
    (pack_id, kind, filename, original_name, mime, size, caption, sort_order, visibility, note, contributor, external_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  listDocPackFiles:  db.prepare('SELECT * FROM doc_pack_files WHERE pack_id = ? ORDER BY sort_order ASC, id ASC'),
  listDocPackFilesByDate: db.prepare('SELECT * FROM doc_pack_files WHERE pack_id = ? ORDER BY created_at DESC, id DESC'),
  getDocPackFile:    db.prepare('SELECT * FROM doc_pack_files WHERE id = ?'),
  deleteDocPackFile: db.prepare('DELETE FROM doc_pack_files WHERE id = ?'),
  updateDocPackFileExternalPath: db.prepare('UPDATE doc_pack_files SET external_path = ? WHERE id = ?'),
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

  // BOQ Billing Phases
  listBoqBillingPhases:      db.prepare('SELECT * FROM boq_billing_phases WHERE project_id=? ORDER BY phase_num ASC'),
  getBoqBillingPhase:        db.prepare('SELECT * FROM boq_billing_phases WHERE id=?'),
  createBoqBillingPhase:     db.prepare("INSERT INTO boq_billing_phases (project_id,phase_num,billing_status,billing_date,billing_notes,is_partial) VALUES (?,?,?,?,?,?)"),
  updateBoqBillingPhase:     db.prepare("UPDATE boq_billing_phases SET billing_status=?,billing_date=?,billing_notes=?,is_partial=?,updated_at=datetime('now') WHERE id=?"),
  deleteBoqBillingPhase:     db.prepare('DELETE FROM boq_billing_phases WHERE id=?'),
  listBoqBillingPhaseItems:  db.prepare('SELECT * FROM boq_billing_phase_items WHERE phase_id=?'),
  upsertBoqBillingPhaseItem: db.prepare(`INSERT INTO boq_billing_phase_items (phase_id,item_id,executed_qty,notes)
    VALUES (?,?,?,?) ON CONFLICT(phase_id,item_id) DO UPDATE SET executed_qty=excluded.executed_qty,notes=excluded.notes`),
  deleteBoqBillingPhaseItems:db.prepare('DELETE FROM boq_billing_phase_items WHERE phase_id=?'),

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

  // BOQ: Component templates
  listBoqTemplates:   db.prepare('SELECT * FROM boq_component_templates ORDER BY is_system DESC, name ASC'),
  getBoqTemplate:       db.prepare('SELECT * FROM boq_component_templates WHERE id = ?'),
  getBoqTemplateByName: db.prepare('SELECT * FROM boq_component_templates WHERE name = ?'),
  createBoqTemplate:    db.prepare('INSERT INTO boq_component_templates (name, keywords_json, components_json, is_system, city) VALUES (?,?,?,?,?)'),
  updateBoqTemplate:    db.prepare("UPDATE boq_component_templates SET name=?, keywords_json=?, components_json=?, city=?, updated_at=datetime('now') WHERE id=?"),
  deleteBoqTemplate:  db.prepare('DELETE FROM boq_component_templates WHERE id = ? AND is_system = 0'),
  countBoqTemplates:  db.prepare('SELECT COUNT(*) AS n FROM boq_component_templates'),

  // BOQ: Projects
  listBoqProjects:    db.prepare('SELECT id,name,project_number,description,site,status,currency,notes,created_at,updated_at,created_by,order_id,billing_status,billing_is_partial FROM boq_projects ORDER BY updated_at DESC'),
  getBoqProjectByOrderId: db.prepare('SELECT id, name FROM boq_projects WHERE order_id = ? LIMIT 1'),
  getBoqProject:      db.prepare('SELECT * FROM boq_projects WHERE id = ?'),
  createBoqProject:   db.prepare("INSERT INTO boq_projects (name,description,site,status,currency,notes,created_by) VALUES (?,?,?,?,?,?,?)"),
  updateBoqProject:   db.prepare("UPDATE boq_projects SET name=?,project_number=?,description=?,site=?,status=?,currency=?,notes=?,updated_at=datetime('now') WHERE id=?"),
  updateBoqBilling:   db.prepare("UPDATE boq_projects SET order_id=?,billing_status=?,billing_date=?,billing_notes=?,billing_is_partial=?,updated_at=datetime('now') WHERE id=?"),
  deleteBoqProject:   db.prepare('DELETE FROM boq_projects WHERE id = ?'),

  // BOQ: Items
  listBoqItems:       db.prepare('SELECT * FROM boq_items WHERE project_id = ? ORDER BY sort_order ASC, id ASC'),
  getBoqItem:         db.prepare('SELECT * FROM boq_items WHERE id = ?'),
  createBoqItem:      db.prepare(`INSERT INTO boq_items
    (project_id,item_number,parent_number,description,unit,quantity,is_rfq,rfq_vendor,rfq_notes,sort_order,is_section,template_id,notes,contract_unit_price,manufacturer,model)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateBoqItem:      db.prepare(`UPDATE boq_items SET
    item_number=?,parent_number=?,description=?,unit=?,quantity=?,
    is_rfq=?,rfq_vendor=?,rfq_notes=?,rfq_price_ils=?,is_section=?,notes=?,contract_unit_price=?,
    manufacturer=?,model=?,
    updated_at=datetime('now') WHERE id=?`),
  updateBoqItemBilling:       db.prepare("UPDATE boq_items SET executed_qty=?,billing_item_notes=?,updated_at=datetime('now') WHERE id=?"),
  updateBoqItemContractPrice: db.prepare("UPDATE boq_items SET contract_unit_price=?,updated_at=datetime('now') WHERE id=?"),
  updateBoqItemRfqPrice: db.prepare("UPDATE boq_items SET rfq_price_ils=?,updated_at=datetime('now') WHERE id=?"),
  updateBoqItemTemplate:  db.prepare("UPDATE boq_items SET template_id=?,updated_at=datetime('now') WHERE id=?"),
  deleteBoqItem:           db.prepare('DELETE FROM boq_items WHERE id = ?'),
  deleteAllBoqItemsByProject: db.prepare('DELETE FROM boq_items WHERE project_id = ?'),
  reorderBoqItem:          db.prepare('UPDATE boq_items SET sort_order=? WHERE id=?'),
  countBoqItems:           db.prepare('SELECT COUNT(*) AS n FROM boq_items WHERE project_id = ?'),

  // BOQ: Components
  listBoqComponents:             db.prepare('SELECT * FROM boq_components WHERE item_id = ? ORDER BY sort_order ASC'),
  listBoqComponentsByProject:    db.prepare(`
    SELECT c.* FROM boq_components c
    JOIN boq_items i ON i.id = c.item_id
    WHERE i.project_id = ?
    ORDER BY i.sort_order ASC, c.sort_order ASC
  `),
  createBoqComponent:  db.prepare(`INSERT INTO boq_components
    (item_id,component_key,label,unit_price,currency,quantity,quantity_formula,sort_order)
    VALUES (?,?,?,?,?,?,?,?)`),
  updateBoqComponent:  db.prepare(`UPDATE boq_components SET
    component_key=?,label=?,unit_price=?,currency=?,quantity=?,quantity_formula=?,sort_order=?
    WHERE id=?`),
  deleteBoqComponent:          db.prepare('DELETE FROM boq_components WHERE id = ?'),
  deleteBoqComponentsByItem:   db.prepare('DELETE FROM boq_components WHERE item_id = ?'),

  // Budget Control
  listBudgetProjects:   db.prepare('SELECT * FROM budget_projects ORDER BY updated_at DESC'),
  getBudgetProject:     db.prepare('SELECT * FROM budget_projects WHERE id = ?'),
  createBudgetProject:  db.prepare("INSERT INTO budget_projects (name,site,status,file_name,notes,created_by) VALUES (?,?,?,?,?,?)"),
  updateBudgetProject:  db.prepare("UPDATE budget_projects SET name=?,site=?,notes=?,updated_at=datetime('now') WHERE id=?"),
  deleteBudgetProject:  db.prepare('DELETE FROM budget_projects WHERE id = ?'),

  listBudgetItems:      db.prepare('SELECT * FROM budget_items WHERE project_id = ? ORDER BY sort_order ASC, id ASC'),
  createBudgetItem:     db.prepare(`INSERT INTO budget_items
    (project_id,item_number,description,unit,quantity,contract_unit_price,contract_total,
     item_cost,total_cost,manufacturer,model,sku,notes,is_section,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateBudgetItem:     db.prepare(`UPDATE budget_items SET
    item_number=?,description=?,unit=?,quantity=?,contract_unit_price=?,contract_total=?,
    item_cost=?,total_cost=?,manufacturer=?,model=?,sku=?,notes=?
    WHERE id=?`),
  deleteBudgetItem:     db.prepare('DELETE FROM budget_items WHERE id = ?'),
  deleteBudgetItemsByProject: db.prepare('DELETE FROM budget_items WHERE project_id = ?'),
  countBudgetItems:     db.prepare('SELECT COUNT(*) AS n FROM budget_items WHERE project_id = ?'),

  // Orders
  listOrderCities:      db.prepare('SELECT * FROM order_cities ORDER BY name ASC'),
  createOrderCity:      db.prepare("INSERT INTO order_cities (name, notes) VALUES (?, ?)"),
  deleteOrderCity:      db.prepare('DELETE FROM order_cities WHERE id = ?'),
  getOrderCity:         db.prepare('SELECT * FROM order_cities WHERE id = ?'),

  listOrderProjects:    db.prepare('SELECT * FROM order_projects WHERE city_id = ? ORDER BY name ASC'),
  getOrderProject:      db.prepare('SELECT * FROM order_projects WHERE id = ?'),
  createOrderProject:   db.prepare("INSERT INTO order_projects (city_id, name, client, contract_number, notes, created_by) VALUES (?,?,?,?,?,?)"),
  updateOrderProject:   db.prepare("UPDATE order_projects SET name=?,client=?,contract_number=?,notes=?,updated_at=datetime('now') WHERE id=?"),
  deleteOrderProject:   db.prepare('DELETE FROM order_projects WHERE id = ?'),

  getAllOrders:         db.prepare(`SELECT o.id, o.order_number, o.ordering_entity, o.description, o.amount_pre_vat, o.order_date, o.currency, o.project_id, o.pdf_path, p.name AS project_name, c.name AS city_name
    FROM orders o
    LEFT JOIN order_projects p ON p.id = o.project_id
    LEFT JOIN order_cities c ON c.id = p.city_id
    ORDER BY o.created_at DESC`),
  listOrders:           db.prepare('SELECT * FROM orders WHERE project_id = ? ORDER BY created_at DESC'),
  getOrder:             db.prepare('SELECT * FROM orders WHERE id = ?'),
  findOrderByNumber:    db.prepare('SELECT id, order_number, project_id FROM orders WHERE order_number = ? LIMIT 1'),
  createOrder:          db.prepare(`INSERT INTO orders
    (project_id, order_number, order_date, ordering_entity, description,
     amount_pre_vat, currency, pdf_path, pdf_original_name, notes, raw_extracted, items_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateOrder:          db.prepare(`UPDATE orders SET
    order_number=?, order_date=?, ordering_entity=?, description=?,
    amount_pre_vat=?, is_invoiced=?, invoice_date=?, invoice_number=?,
    notes=?, updated_at=datetime('now') WHERE id=?`),
  updateOrderInvoice:   db.prepare(`UPDATE orders SET
    invoice_file_path=?, invoice_original_name=?, invoice_date=?, invoice_number=?,
    is_invoiced=1, updated_at=datetime('now') WHERE id=?`),
  deleteOrder:          db.prepare('DELETE FROM orders WHERE id = ?'),

  // order_invoices (multi-invoice per order)
  listOrderInvoices:   db.prepare('SELECT * FROM order_invoices WHERE order_id = ? ORDER BY created_at ASC'),
  getOrderInvoice:     db.prepare('SELECT * FROM order_invoices WHERE id = ?'),
  createOrderInvoice:  db.prepare(`INSERT INTO order_invoices
    (order_id, invoice_number, invoice_date, description, amount_pre_vat, amount_with_vat, file_path, original_name)
    VALUES (?,?,?,?,?,?,?,?)`),
  deleteOrderInvoice:  db.prepare('DELETE FROM order_invoices WHERE id = ?'),
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

  // TOTP 2FA
  setUserTotpSecret:  (id, secret) => stmts.setUserTotpSecret.run(secret, id),
  enableUserTotp:     (id, backupCodesJson) => stmts.enableUserTotp.run(backupCodesJson, id),
  disableUserTotp:    (id) => stmts.disableUserTotp.run(id),
  updateUserBackupCodes: (id, codesJson) => stmts.updateUserBackupCodes.run(codesJson, id),
  listUsersWithTotp:  () => stmts.listUsersWithTotp.all(),

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
  createDocPack: (name, type, dataJson, userId, username, isTemplate = 0) =>
    stmts.createDocPack.run(name, type || 'cctv', dataJson || '{}', userId || null, username || null, isTemplate ? 1 : 0),
  updateDocPack: (id, name, dataJson, status) => stmts.updateDocPack.run(name, dataJson, status || null, id),
  setDocPackTemplate: (id, isTemplate) => stmts.setDocPackTemplate.run(isTemplate ? 1 : 0, id),
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
  updateDocPackFileExternalPath: (id, p) => stmts.updateDocPackFileExternalPath.run(p, id),
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

  // BOQ: Billing Phases
  listBoqBillingPhases:  (projectId) => stmts.listBoqBillingPhases.all(projectId),
  getBoqBillingPhase:    (id)        => stmts.getBoqBillingPhase.get(id),
  createBoqBillingPhase: (projectId, phaseNum, status, date, notes, isPartial) =>
    stmts.createBoqBillingPhase.run(projectId, phaseNum, status||'none', date||null, notes||null, isPartial?1:0),
  updateBoqBillingPhase: (id, { billingStatus, billingDate, billingNotes, isPartial }) =>
    stmts.updateBoqBillingPhase.run(billingStatus||'none', billingDate||null, billingNotes||null, isPartial?1:0, id),
  deleteBoqBillingPhase: (id) => stmts.deleteBoqBillingPhase.run(id),
  listBoqBillingPhaseItems:   (phaseId) => stmts.listBoqBillingPhaseItems.all(phaseId),
  saveBoqBillingPhaseItems: (phaseId, items) => {
    stmts.deleteBoqBillingPhaseItems.run(phaseId);
    for (const it of items)
      stmts.upsertBoqBillingPhaseItem.run(phaseId, it.item_id, it.executed_qty ?? null, it.notes || null);
  },

  // BOQ: Component templates
  listBoqTemplates:  () => stmts.listBoqTemplates.all(),
  getBoqTemplate:       (id)   => stmts.getBoqTemplate.get(id),
  getBoqTemplateByName: (name) => stmts.getBoqTemplateByName.get(name),
  createBoqTemplate: ({ name, keywordsJson, componentsJson, isSystem, city }) =>
    stmts.createBoqTemplate.run(name, keywordsJson || '[]', componentsJson || '[]', isSystem ? 1 : 0, city || null),
  updateBoqTemplate: (id, { name, keywordsJson, componentsJson, city }) =>
    stmts.updateBoqTemplate.run(name, keywordsJson || '[]', componentsJson || '[]', city || null, id),
  deleteBoqTemplate: (id) => stmts.deleteBoqTemplate.run(id),
  countBoqTemplates: () => stmts.countBoqTemplates.get().n,

  // BOQ: Projects
  listBoqProjects:   () => stmts.listBoqProjects.all(),
  getBoqProjectByOrderId: (orderId) => stmts.getBoqProjectByOrderId.get(orderId),
  getBoqProject:     (id) => stmts.getBoqProject.get(id),
  createBoqProject:  ({ name, description, site, status, currency, notes, createdBy }) =>
    stmts.createBoqProject.run(name, description || null, site || null, status || 'draft', currency || 'ILS', notes || null, createdBy || null),
  updateBoqProject:  (id, { name, projectNumber, description, site, status, currency, notes }) =>
    stmts.updateBoqProject.run(name, projectNumber || null, description || null, site || null, status || 'draft', currency || 'ILS', notes || null, id),
  updateBoqBilling:  (id, { orderId, billingStatus, billingDate, billingNotes, billingIsPartial }) =>
    stmts.updateBoqBilling.run(orderId || null, billingStatus || 'none', billingDate || null, billingNotes || null, billingIsPartial ? 1 : 0, id),
  deleteBoqProject:  (id) => stmts.deleteBoqProject.run(id),

  // BOQ: Items
  listBoqItems:   (projectId) => stmts.listBoqItems.all(projectId),
  getBoqItem:     (id) => stmts.getBoqItem.get(id),
  createBoqItem:  (opts) => stmts.createBoqItem.run(
    opts.projectId, opts.itemNumber || null, opts.parentNumber || null,
    opts.description, opts.unit || null, opts.quantity || 0,
    opts.isRfq ? 1 : 0, opts.rfqVendor || null, opts.rfqNotes || null,
    opts.sortOrder || 0, opts.isSection ? 1 : 0, opts.templateId || null, opts.notes || null,
    opts.contractUnitPrice != null ? opts.contractUnitPrice : null,
    opts.manufacturer || null, opts.model || null
  ),
  updateBoqItem:  (id, opts) => stmts.updateBoqItem.run(
    opts.itemNumber || null, opts.parentNumber || null, opts.description,
    opts.unit || null, opts.quantity || 0,
    opts.isRfq ? 1 : 0, opts.rfqVendor || null, opts.rfqNotes || null,
    opts.rfqPriceIls != null ? opts.rfqPriceIls : null,
    opts.isSection ? 1 : 0, opts.notes || null,
    opts.contractUnitPrice != null ? opts.contractUnitPrice : null,
    opts.manufacturer || null, opts.model || null,
    id
  ),
  updateBoqItemBilling:       (id, { executedQty, billingNotes }) => stmts.updateBoqItemBilling.run(executedQty != null ? executedQty : null, billingNotes || null, id),
  updateBoqItemContractPrice: (id, price) => stmts.updateBoqItemContractPrice.run(price != null ? price : null, id),
  updateBoqItemRfqPrice:  (id, priceIls) => stmts.updateBoqItemRfqPrice.run(priceIls, id),
  updateBoqItemTemplate:  (id, templateId) => stmts.updateBoqItemTemplate.run(templateId || null, id),
  deleteBoqItem:  (id) => stmts.deleteBoqItem.run(id),
  deleteAllBoqItemsByProject: (projectId) => stmts.deleteAllBoqItemsByProject.run(projectId),
  reorderBoqItems: (pairs) => {
    const tx = db.transaction((pairs) => {
      for (const p of pairs) stmts.reorderBoqItem.run(p.sortOrder, p.id);
    });
    return tx(pairs);
  },
  countBoqItems:  (projectId) => stmts.countBoqItems.get(projectId).n,

  // BOQ: Components
  listBoqComponents:          (itemId)    => stmts.listBoqComponents.all(itemId),
  listBoqComponentsByProject: (projectId) => stmts.listBoqComponentsByProject.all(projectId),
  createBoqComponent: (opts) => stmts.createBoqComponent.run(
    opts.itemId, opts.componentKey || 'custom', opts.label,
    opts.unitPrice || 0, opts.currency || 'ILS', opts.quantity || 1,
    opts.quantityFormula || null, opts.sortOrder || 0
  ),
  updateBoqComponent: (id, opts) => stmts.updateBoqComponent.run(
    opts.componentKey || 'custom', opts.label,
    opts.unitPrice || 0, opts.currency || 'ILS', opts.quantity || 1,
    opts.quantityFormula || null, opts.sortOrder || 0, id
  ),
  deleteBoqComponent:         (id)        => stmts.deleteBoqComponent.run(id),
  deleteBoqComponentsByItem:  (itemId)    => stmts.deleteBoqComponentsByItem.run(itemId),

  // Budget Control
  listBudgetProjects:  ()   => stmts.listBudgetProjects.all(),
  getBudgetProject:    (id) => stmts.getBudgetProject.get(id),
  createBudgetProject: ({ name, site, fileName, notes, createdBy }) =>
    stmts.createBudgetProject.run(name, site || null, 'active', fileName || null, notes || null, createdBy || null),
  updateBudgetProject: (id, { name, site, notes }) =>
    stmts.updateBudgetProject.run(name, site || null, notes || null, id),
  deleteBudgetProject: (id) => stmts.deleteBudgetProject.run(id),

  listBudgetItems:  (projectId) => stmts.listBudgetItems.all(projectId),
  createBudgetItem: (opts) => stmts.createBudgetItem.run(
    opts.projectId, opts.itemNumber || null, opts.description,
    opts.unit || null, opts.quantity || 0,
    opts.contractUnitPrice != null ? opts.contractUnitPrice : null,
    opts.contractTotal || 0, opts.itemCost || 0, opts.totalCost || 0,
    opts.manufacturer || null, opts.model || null, opts.sku || null,
    opts.notes || null, opts.isSection ? 1 : 0, opts.sortOrder || 0
  ),
  updateBudgetItem: (id, opts) => stmts.updateBudgetItem.run(
    opts.itemNumber || null, opts.description,
    opts.unit || null, opts.quantity || 0,
    opts.contractUnitPrice != null ? opts.contractUnitPrice : null,
    opts.contractTotal || 0, opts.itemCost || 0, opts.totalCost || 0,
    opts.manufacturer || null, opts.model || null, opts.sku || null,
    opts.notes || null, id
  ),
  deleteBudgetItem:           (id)        => stmts.deleteBudgetItem.run(id),
  deleteBudgetItemsByProject: (projectId) => stmts.deleteBudgetItemsByProject.run(projectId),
  countBudgetItems:           (projectId) => stmts.countBudgetItems.get(projectId).n,

  // Orders
  listOrderCities:    ()       => stmts.listOrderCities.all(),
  getOrderCity:       (id)     => stmts.getOrderCity.get(id),
  createOrderCity:    (name, notes) => stmts.createOrderCity.run(name, notes || null),
  deleteOrderCity:    (id)     => stmts.deleteOrderCity.run(id),

  listOrderProjects:  (cityId) => stmts.listOrderProjects.all(cityId),
  getOrderProject:    (id)     => stmts.getOrderProject.get(id),
  createOrderProject: ({ cityId, name, client, contractNumber, notes, createdBy }) =>
    stmts.createOrderProject.run(cityId, name, client||null, contractNumber||null, notes||null, createdBy||null),
  updateOrderProject: (id, { name, client, contractNumber, notes }) =>
    stmts.updateOrderProject.run(name, client||null, contractNumber||null, notes||null, id),
  deleteOrderProject: (id) => stmts.deleteOrderProject.run(id),

  getAllOrders:        ()          => stmts.getAllOrders.all(),
  listOrders:         (projectId) => stmts.listOrders.all(projectId),
  getOrder:           (id)        => stmts.getOrder.get(id),
  findOrderByNumber:  (num)       => stmts.findOrderByNumber.get(num),
  createOrder:  ({ projectId, orderNumber, orderDate, orderingEntity, description,
                   amountPreVat, currency, pdfPath, pdfOriginalName, notes, rawExtracted, itemsJson }) =>
    stmts.createOrder.run(projectId, orderNumber||null, orderDate||null, orderingEntity||null,
      description||null, amountPreVat!=null?amountPreVat:null, currency||'ILS',
      pdfPath||null, pdfOriginalName||null, notes||null, rawExtracted||null, itemsJson||'[]'),
  updateOrder:  (id, { orderNumber, orderDate, orderingEntity, description,
                       amountPreVat, isInvoiced, invoiceDate, invoiceNumber, notes }) =>
    stmts.updateOrder.run(orderNumber||null, orderDate||null, orderingEntity||null,
      description||null, amountPreVat!=null?amountPreVat:null, isInvoiced?1:0,
      invoiceDate||null, invoiceNumber||null, notes||null, id),
  updateOrderInvoice: (id, { invoiceFilePath, invoiceOriginalName, invoiceDate, invoiceNumber }) =>
    stmts.updateOrderInvoice.run(invoiceFilePath||null, invoiceOriginalName||null,
      invoiceDate||null, invoiceNumber||null, id),
  deleteOrder:  (id) => stmts.deleteOrder.run(id),

  // order_invoices
  listOrderInvoices:  (orderId) => stmts.listOrderInvoices.all(orderId),
  getOrderInvoice:    (id)      => stmts.getOrderInvoice.get(id),
  createOrderInvoice: ({ orderId, invoiceNumber, invoiceDate, description, amountPreVat, amountWithVat, filePath, originalName }) =>
    stmts.createOrderInvoice.run(orderId, invoiceNumber||null, invoiceDate||null, description||null,
      amountPreVat!=null?amountPreVat:null, amountWithVat!=null?amountWithVat:null,
      filePath||null, originalName||null),
  deleteOrderInvoice: (id) => stmts.deleteOrderInvoice.run(id),
};
