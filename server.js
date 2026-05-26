require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');
const multer       = require('multer');
const { v4: uuidv4 } = require('uuid');

const db      = require('./db');
const docpack = require('./docpack');

const app  = express();
const PORT = process.env.PORT || 3000;

// L1 — In production we REFUSE to boot with the default dev secret. Forging
// admin JWTs is trivial if attacker knows the fallback string.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[fatal] JWT_SECRET env var is required in production.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DS_PATH    = path.resolve(process.env.DS_PATH    || path.join(__dirname, 'ds'));
const DS_FALLBACK = path.join(__dirname, 'ds'); // git-committed PDFs — used when DS_PATH is empty
const STATIC_DIR = process.env.STATIC_DIR || __dirname;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
      fontSrc:    ["'self'", 'fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
      frameSrc:   ["'self'"],   // allow same-origin iframes (PDF preview)
      connectSrc: ["'self'"],
    }
  }
}));
app.use(express.json({ limit: '10mb' }));  // warehouse imports can be ~500KB+
app.use(cookieParser());
app.set('trust proxy', 1);

// ── Helpers ───────────────────────────────────────────────────────────────────

function validatePassword(pw) {
  if (!pw || pw.length < 8)  return 'הסיסמה חייבת להכיל לפחות 8 תווים';
  if (!/[A-Z]/.test(pw))     return 'הסיסמה חייבת להכיל אות גדולה אחת לפחות';
  if (!/[a-z]/.test(pw))     return 'הסיסמה חייבת להכיל אות קטנה אחת לפחות';
  if (!/[0-9]/.test(pw))     return 'הסיסמה חייבת להכיל ספרה אחת לפחות';
  return null; // valid
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  const payload = verifyToken(token);
  if (!payload) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login');
  }
  const user = db.getUserById(payload.id);
  if (!user || !user.active) {
    res.clearCookie('token');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Account disabled' });
    return res.redirect('/login');
  }
  req.user = { id: user.id, username: user.username, role: user.role };
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
      return res.status(403).send('<h1>403 Forbidden</h1>');
    }
    next();
  });
}

// H2 — Server-enforced section check (the client-side hiding of tabs is not
// enough on its own; an authenticated viewer could otherwise call any /api
// endpoint directly). Admins always pass. Viewers must have the requested
// section in their `sections` array.
function requireSection(name) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (req.user.role === 'admin') return next();
    const u = db.getUserById(req.user.id);
    let secs = [];
    try { secs = u && u.sections ? JSON.parse(u.sections) : []; } catch {}
    if (!Array.isArray(secs) || !secs.includes(name)) {
      return res.status(403).json({ error: 'Section not allowed' });
    }
    return next();
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  const token = req.cookies?.token;
  if (verifyToken(token)) return res.redirect('/');
  res.sendFile(path.join(STATIC_DIR, 'login.html'));
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.getUserByUsername(username);

  // Account locked after 5 failed attempts
  if (user && user.login_attempts >= 5) {
    db.logAudit(user.id, user.username, 'login_fail', 'Account locked', ip, ua);
    return res.status(401).json({ error: 'החשבון חסום עקב ניסיונות כניסה שגויים. פנה למנהל מערכת לשחרור' });
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    if (user) {
      db.incrementLoginAttempts(user.id);
      const attempts = user.login_attempts + 1;
      if (attempts >= 5) {
        db.logAudit(user.id, user.username, 'login_fail', 'Account locked after too many attempts', ip, ua);
        return res.status(401).json({ error: 'החשבון חסום עקב ניסיונות כניסה שגויים. פנה למנהל מערכת לשחרור' });
      }
      const remaining = 5 - attempts;
      db.logAudit(user.id, user.username, 'login_fail', `Wrong credentials (${attempts}/5 attempts)`, ip, ua);
      return res.status(401).json({ error: `שם משתמש או סיסמה שגויים (${remaining} ניסיונות נותרו לפני חסימה)` });
    }
    db.logAudit(null, username, 'login_fail', 'Wrong credentials', ip, ua);
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  }

  if (!user.active) {
    db.logAudit(user.id, user.username, 'login_fail', 'Account disabled', ip, ua);
    return res.status(401).json({ error: 'Account is disabled' });
  }

  // Successful login — reset attempt counter
  db.resetLoginAttempts(user.id);
  db.updateLastLogin(user.id);
  db.logAudit(user.id, user.username, 'login', null, ip, ua);

  const token = signToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000,   // 8 hours
  });
  res.json({ ok: true, role: user.role, must_change_password: !!user.must_change_password });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  db.logAudit(req.user.id, req.user.username, 'logout', null, ip, ua);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // sections: null = all access (admin), array = specific allowed views (viewer)
  let sections = null;
  if (user.role !== 'admin') {
    sections = user.sections ? JSON.parse(user.sections) : [];
  }
  res.json({ id: user.id, username: user.username, role: user.role, sections });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.getUserById(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (currentPassword === newPassword)
    return res.status(400).json({ error: 'הסיסמה החדשה זהה לישנה' });
  db.setPassword(user.id, newPassword);
  db.setMustChangePassword(user.id, 0);
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  db.logAudit(user.id, user.username, 'change_password', null, ip, ua);
  res.json({ ok: true });
});

// ── Audit event from client ───────────────────────────────────────────────────

app.post('/api/audit/event', requireAuth, (req, res) => {
  const { action, detail } = req.body;
  const allowed = ['view_ds', 'search', 'edit', 'export'];
  if (!allowed.includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  db.logAudit(req.user.id, req.user.username, action, detail, ip, ua);
  res.json({ ok: true });
});

// ── User management (admin only) ──────────────────────────────────────────────

app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.listUsers());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role = 'viewer' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const result = db.createUser(username, password, role);
    db.logAudit(req.user.id, req.user.username, 'create_user', `Created user: ${username} (${role})`, getClientIp(req), '');
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { active, role } = req.body;
  if (active !== undefined) {
    db.setActive(id, active);
    db.logAudit(req.user.id, req.user.username, 'update_user', `Set active=${active} for user id=${id}`, getClientIp(req), '');
  }
  if (role !== undefined) {
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.setRole(id, role);
    db.logAudit(req.user.id, req.user.username, 'update_user', `Set role=${role} for user id=${id}`, getClientIp(req), '');
  }
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { password } = req.body;
  const pwErr2 = validatePassword(password);
  if (pwErr2) return res.status(400).json({ error: pwErr2 });
  db.setPassword(id, password);
  db.setMustChangePassword(id, 1);
  db.logAudit(req.user.id, req.user.username, 'reset_password', `Reset password for user id=${id}`, getClientIp(req), '');
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id)
    return res.status(400).json({ error: 'לא ניתן למחוק את המשתמש שלך' });
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'משתמש לא נמצא' });
  if (target.role === 'admin' && db.countAdmins() <= 1)
    return res.status(400).json({ error: 'לא ניתן למחוק את מנהל המערכת האחרון' });
  db.deleteUser(id);
  db.logAudit(req.user.id, req.user.username, 'delete_user', `Deleted user: ${target.username}`, getClientIp(req), '');
  res.json({ ok: true });
});

app.post('/api/users/:id/unlock', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'משתמש לא נמצא' });
  db.resetLoginAttempts(id);
  db.logAudit(req.user.id, req.user.username, 'unlock_user', `Unlocked user: ${target.username}`, getClientIp(req), '');
  res.json({ ok: true });
});

app.put('/api/users/:id/sections', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { sections } = req.body;
  const valid = ['list', 'kanban', 'catalog', 'pricelist', 'warehouse', 'docpack'];
  if (!Array.isArray(sections) || sections.some(s => !valid.includes(s)))
    return res.status(400).json({ error: 'Invalid sections value' });
  db.setSections(id, sections);
  db.logAudit(req.user.id, req.user.username, 'update_user',
    `Set sections for user id=${id}: [${sections.join(',')}]`, getClientIp(req), '');
  res.json({ ok: true });
});

// ── Warehouse inventory (shared across all users) ────────────────────────────

app.get('/api/warehouse', requireAuth, (req, res) => {
  const row = db.getWarehouse();
  let items = [];
  try { items = row ? JSON.parse(row.data) : []; } catch { items = []; }
  res.json({
    items,
    importedAt: row?.imported_at || null,
    count:      row?.count       || 0,
  });
});

app.put('/api/warehouse', requireAdmin, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items))
    return res.status(400).json({ error: 'items must be an array' });
  db.setWarehouse(JSON.stringify(items), items.length);
  db.logAudit(req.user.id, req.user.username, 'warehouse_import',
    `Imported ${items.length} warehouse items`, getClientIp(req), '');
  res.json({ ok: true, count: items.length });
});

// ── Doc packs (תיק תיעוד) ─────────────────────────────────────────────────────

// Multer for file uploads — destination = a staging dir, we move files post-validation.
const DOC_UPLOAD_STAGING = path.join(docpack.UPLOADS_DIR, '_staging');
if (!fs.existsSync(DOC_UPLOAD_STAGING)) fs.mkdirSync(DOC_UPLOAD_STAGING, { recursive: true });

// Allowed extensions — combined with mime-type sniffing on each upload.
// SVG intentionally NOT allowed: SVG can carry <script> and our CSP allows
// 'unsafe-inline' for first-party scripts, so a stored SVG opened directly
// from /api/docpacks/:id/files/:fileId would execute in the app origin and
// steal admin sessions. (M3 from the security review.)
const ALLOWED_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|mp4|mov|m4v|avi|mkv|webm|pdf|xlsx?|csv|docx?|pptx?|txt|zip)$/i;
const ALLOWED_KINDS = [
  'photo', 'diagram', 'network_diagram', 'site_plan',
  'video', 'pdf', 'excel', 'quote_contractor', 'quote_supplier',
  'datasheet', 'general',
];
// Default visibility per kind. Internal artifacts (quotes, drafts) never reach
// the client deliverable; they stay in the project workspace only.
const KIND_DEFAULT_VISIBILITY = {
  quote_contractor: 'internal',
  quote_supplier:   'internal',
  excel:            'internal',  // working files usually
  general:          'internal',
  // everything else → 'client' (photos, diagrams, datasheets, pdf, video)
};
const PER_PACK_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const PER_FILE_MAX_BYTES   = 200 * 1024 * 1024;      // 200MB

// H3 — /api/docpacks/:id/generate is expensive (pdf-to-img renders up to
// 50 pages, builds a docx, writes temp PNGs). Cap at 6/min PER USER so
// a logged-in viewer can't saturate CPU / disk.
const generateRateLimiter = rateLimit({
  windowMs: 60 * 1000, max: 6,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) ? `u:${req.user.id}` : req.ip,
  message: { error: 'יותר מדי בקשות ייצוא. נסה שוב בעוד דקה.' },
});

const docPackUpload = multer({
  dest: DOC_UPLOAD_STAGING,
  limits: { fileSize: PER_FILE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    // Reject SVG explicitly regardless of declared mime — see M3 comment above.
    if (/\.svg$/i.test(file.originalname || '') || /svg/i.test(file.mimetype || '')) {
      return cb(new Error('SVG אסור — אנא העלה PNG/JPG'));
    }
    // Accept by extension AND by mime type — both signals must be reasonable.
    const okExt  = ALLOWED_EXT.test(file.originalname || '');
    const okMime = /^(image|video)\//i.test(file.mimetype || '') ||
                   /pdf|excel|spreadsheet|word|presentation|zip|csv|octet-stream/i.test(file.mimetype || '');
    if (okExt || okMime) return cb(null, true);
    cb(new Error('סוג קובץ אסור: ' + (file.originalname || file.mimetype)));
  },
});

function sanitizeFilename(name) {
  // Strip path traversal; the result is used as the export-bundle filename.
  const base = String(name || 'תיק תיעוד').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return base || 'תיק תיעוד';
}

function defaultVisibilityForKind(kind) {
  return KIND_DEFAULT_VISIBILITY[kind] || 'client';
}

function _sanitizeContributorName(raw) {
  let s = String(raw || 'משתתף');
  // Drop control chars (incl. CR/LF) and HTML-significant chars (<>"'&`)
  s = s.replace(/[\x00-\x1f\x7f<>"'`&]/g, '');
  s = s.trim().slice(0, 60);
  return s || 'משתתף';
}

function publicFileShape(f) {
  // Shape sent to clients (admin dashboard + share page).
  return {
    id:            f.id,
    kind:          f.kind,
    original_name: f.original_name,
    mime:          f.mime,
    size:          f.size,
    caption:       f.caption,
    note:          f.note || '',
    visibility:    f.visibility || 'client',
    contributor:   f.contributor || '',
    sort_order:    f.sort_order,
    created_at:    f.created_at,
    is_linked:     !!f.external_path && !f.filename,
  };
}

app.get('/api/docpacks', requireSection('docpack'), (req, res) => {
  res.json({ packs: db.listDocPacks() });
});

app.post('/api/docpacks', requireAdmin, (req, res) => {
  const { name, type } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required' });
  const r = db.createDocPack(name.trim(), type || 'cctv', '{}', req.user.id, req.user.username);
  db.logAudit(req.user.id, req.user.username, 'docpack_create',
    `Created doc pack: ${name.trim()}`, getClientIp(req), '');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.get('/api/docpacks/:id', requireSection('docpack'), (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  // Timeline view: newest-first
  const files = db.listDocPackFilesByDate(id).map(publicFileShape);
  let data = {};
  try { data = JSON.parse(pack.data || '{}'); } catch { data = {}; }
  const usedBytes = db.sumDocPackFileSize(id);
  res.json({
    pack: {
      id: pack.id, name: pack.name, type: pack.type, data,
      created_at: pack.created_at, updated_at: pack.updated_at,
      created_by_username: pack.created_by_username,
    },
    files,
    quota: { used: usedBytes, max: PER_PACK_QUOTA_BYTES },
  });
});

app.put('/api/docpacks/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  const { name, data } = req.body || {};
  const finalName = (name && typeof name === 'string' && name.trim()) ? name.trim() : pack.name;
  let dataJson = '{}';
  if (data && typeof data === 'object') {
    try { dataJson = JSON.stringify(data); } catch { return res.status(400).json({ error: 'invalid data' }); }
  } else if (typeof data === 'string') {
    dataJson = data;
  }
  db.updateDocPack(id, finalName, dataJson);
  res.json({ ok: true });
});

app.delete('/api/docpacks/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  // Delete uploaded files from disk (skip linked datasheets — they live under /data/ds)
  const files = db.listDocPackFiles(id);
  for (const f of files) {
    if (!f.filename) continue; // linked-only (external_path), nothing to remove
    const p = docpack.fileDiskPath(id, f.filename);
    try { fs.unlinkSync(p); } catch {/* missing file is fine */}
  }
  try { fs.rmdirSync(docpack.packDir(id)); } catch {/* dir non-empty or missing — fine */}
  db.deleteDocPack(id); // ON DELETE CASCADE removes rows in doc_pack_files
  db.logAudit(req.user.id, req.user.username, 'docpack_delete',
    `Deleted doc pack: ${pack.name}`, getClientIp(req), '');
  res.json({ ok: true });
});

// ── Shared helpers for file uploads (admin + share-link routes) ──

// multer reports `originalname` decoded as latin1, but browsers send the filename
// as UTF-8 bytes in the multipart header. Hebrew filenames come through as
// mojibake unless we re-decode. This is a well-known multer quirk.
function fixUtf8Filename(name) {
  if (!name) return name;
  try { return Buffer.from(name, 'latin1').toString('utf8'); }
  catch { return name; }
}

async function _ingestUploadedFile(packId, req, contributor) {
  const pack = db.getDocPack(packId);
  if (!pack) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    const e = new Error('Pack not found'); e.status = 404; throw e;
  }
  if (!req.file) { const e = new Error('no file uploaded'); e.status = 400; throw e; }
  // Repair Hebrew (or any non-ASCII) filename
  req.file.originalname = fixUtf8Filename(req.file.originalname);

  // Per-pack disk quota
  const used = db.sumDocPackFileSize(packId);
  if (used + req.file.size > PER_PACK_QUOTA_BYTES) {
    try { fs.unlinkSync(req.file.path); } catch {}
    const e = new Error(`חרגת ממכסת הדיסק לפרויקט (${(PER_PACK_QUOTA_BYTES/1024/1024/1024).toFixed(1)}GB)`);
    e.status = 413; throw e;
  }

  const kind = ALLOWED_KINDS.includes(req.body.kind) ? req.body.kind : 'general';
  const visibility = ['client','internal'].includes(req.body.visibility)
    ? req.body.visibility
    : defaultVisibilityForKind(kind);

  const extMatch = (req.file.originalname || '').match(/\.([a-z0-9]{2,5})$/i);
  const ext = (extMatch ? extMatch[1] : 'bin').toLowerCase();
  const newName = `${uuidv4()}.${ext}`;
  const destPath = docpack.fileDiskPath(packId, newName);
  try { fs.renameSync(req.file.path, destPath); }
  catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    const err = new Error('failed to move uploaded file: ' + e.message); err.status = 500; throw err;
  }

  const sortOrder = Date.now() % 1_000_000;
  const r = db.addDocPackFile({
    packId, kind,
    filename: newName,
    originalName: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
    caption: req.body.caption || '',
    note: req.body.note || '',
    visibility,
    contributor,
    sortOrder,
  });
  db.updateDocPack(packId, pack.name, pack.data); // touch updated_at
  const row = db.getDocPackFile(r.lastInsertRowid);
  return publicFileShape(row);
}

app.post('/api/docpacks/:id/files', requireAdmin, docPackUpload.single('file'), async (req, res) => {
  try {
    const file = await _ingestUploadedFile(parseInt(req.params.id), req, req.user.username);
    res.json({ ok: true, file });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Resolve a doc-pack file by trying multiple historical upload locations.
// Earlier deploys without DOC_PACK_UPLOADS_DIR landed files under
// <app>/data/doc_packs (ephemeral). Newer deploys use /data/doc_packs
// (persistent). For backward compat we try several paths.
function _resolveDocPackFilePath(packId, f) {
  if (!f) return null;
  if (f.external_path && fs.existsSync(f.external_path)) return f.external_path;
  if (!f.filename) return null;
  const candidates = [
    docpack.fileDiskPath(packId, f.filename),
    path.join('/data/doc_packs', String(packId), f.filename),
    path.join(__dirname, 'data', 'doc_packs', String(packId), f.filename),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Admin-only diagnostic: returns the resolved disk path for each file in a pack
// and whether it exists. Use to debug "upload appears in timeline but preview blank".
// MUST be declared BEFORE the catch-all :fileId route below — Express matches
// in registration order and `:fileId` would otherwise eat `_diag` as a parameter.
// M2 — paths are redacted so a compromised admin session learns less about
// the host filesystem layout than the raw paths would expose.
const _APP_DIR_REDACTED = '<APP>';
function _redactPath(p) {
  if (!p) return p;
  return String(p)
    .replace(__dirname, _APP_DIR_REDACTED)
    .replace(/^\/opt\/render\/project\/src/, _APP_DIR_REDACTED);
}
app.get('/api/docpacks/:id/files/_diag', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'pack not found' });
  const files = db.listDocPackFiles(id);
  res.json({
    UPLOADS_DIR: _redactPath(docpack.UPLOADS_DIR),
    DOC_PACK_UPLOADS_DIR_env: process.env.DOC_PACK_UPLOADS_DIR ? '(set)' : '(unset)',
    files: files.map(f => ({
      id: f.id,
      kind: f.kind,
      filename: f.filename,
      external_path: _redactPath(f.external_path),
      resolved: _redactPath(_resolveDocPackFilePath(id, f)),
      exists: !!_resolveDocPackFilePath(id, f),
    })),
  });
});

app.get('/api/docpacks/:id/files/:fileId', requireSection('docpack'), (req, res) => {
  const id = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  const f = db.getDocPackFile(fileId);
  if (!f || f.pack_id !== id) return res.status(404).send('Not found');
  const p = _resolveDocPackFilePath(id, f);
  if (!p) {
    console.warn(`[docpack] file missing on disk: pack=${id} file=${fileId} name=${f.filename}`);
    return res.status(404).send('Missing on disk');
  }
  // Defense-in-depth: any non-image content gets X-Content-Type-Options and
  // a tight CSP via response header. Prevents stored-XSS even if a bad file
  // slipped past the upload filter.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.sendFile(p);
});

app.delete('/api/docpacks/:id/files/:fileId', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  const f = db.getDocPackFile(fileId);
  if (!f || f.pack_id !== id) return res.status(404).json({ error: 'Not found' });
  // Skip external_path — those PDFs are shared from /data/ds
  if (f.filename) try { fs.unlinkSync(docpack.fileDiskPath(id, f.filename)); } catch {}
  db.deleteDocPackFile(fileId);
  res.json({ ok: true });
});

app.patch('/api/docpacks/:id/files/:fileId', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  const f = db.getDocPackFile(fileId);
  if (!f || f.pack_id !== id) return res.status(404).json({ error: 'Not found' });
  const fields = {};
  if (req.body?.caption    !== undefined) fields.caption    = req.body.caption;
  if (req.body?.sort_order !== undefined) fields.sortOrder  = req.body.sort_order;
  if (req.body?.visibility !== undefined && ['client','internal'].includes(req.body.visibility))
                                          fields.visibility = req.body.visibility;
  if (req.body?.note       !== undefined) fields.note       = req.body.note;
  if (req.body?.kind       !== undefined && ALLOWED_KINDS.includes(req.body.kind))
                                          fields.kind       = req.body.kind;
  db.updateDocPackFileMeta(fileId, fields);
  res.json({ ok: true });
});

// ── Datasheet search (autocomplete for equipment "model" inputs) ──
app.get('/api/datasheets/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ matches: [] });
  const cat = ['cameras','backhauls','switches'].includes(req.query.cat) ? req.query.cat : null;
  res.json({ matches: docpack.searchDatasheets(q, 10, cat) });
});

// Admin can force a re-index after adding new PDFs under /data/ds
app.post('/api/datasheets/reindex', requireAdmin, (req, res) => {
  const n = docpack.buildDatasheetIndex();
  res.json({ ok: true, count: n });
});

// ── Equipment entry with auto-datasheet attach ──
function _appendEquipment(packId, payload, contributor) {
  const pack = db.getDocPack(packId);
  if (!pack) { const e = new Error('Pack not found'); e.status = 404; throw e; }
  const { table, row } = payload || {};
  if (!['cameras','backhauls','switches'].includes(table)) {
    const e = new Error('table must be one of cameras|backhauls|switches'); e.status = 400; throw e;
  }
  if (!row || typeof row !== 'object') {
    const e = new Error('row object is required'); e.status = 400; throw e;
  }

  // L6 — Whitelist row fields per-table so a hostile share-link contributor
  // cannot pump arbitrary keys + values into the pack.data JSON (DB bloat or
  // future XSS sink). Each field is also clipped to 200 chars.
  const ROW_FIELDS = {
    cameras:   ['idx','cabinet','name','model','port','ip','location'],
    backhauls: ['idx','type','mpn','vendor','location','ip'],
    switches:  ['idx','name','mpn','vendor','ip'],
  };
  const clean = {};
  for (const k of ROW_FIELDS[table]) {
    if (row[k] === undefined || row[k] === null) continue;
    clean[k] = String(row[k]).slice(0, 200);
  }

  let data = {};
  try { data = JSON.parse(pack.data || '{}'); } catch {}
  if (!Array.isArray(data[table])) data[table] = [];
  const enriched = { ...clean, _contributor: contributor || '' };
  data[table].push(enriched);
  db.updateDocPack(packId, pack.name, JSON.stringify(data));

  // Auto-attach datasheet if we can identify the model
  const model = clean.model || clean.mpn || clean.name;
  let attachedFile = null;
  if (model) {
    const ds = docpack.lookupDatasheet(model);
    if (ds) {
      // Don't dupe: check if this external_path is already attached to this pack
      const existing = db.listDocPackFiles(packId)
        .find(f => f.external_path === ds.absPath);
      if (!existing) {
        const r = db.addDocPackFile({
          packId,
          kind: 'datasheet',
          filename: null,
          originalName: ds.original + '.pdf',
          mime: 'application/pdf',
          size: (() => { try { return fs.statSync(ds.absPath).size; } catch { return 0; } })(),
          caption: ds.mfr,
          note: `דף מוצר עבור ${model}`,
          visibility: 'client',
          contributor: contributor || '',
          sortOrder: Date.now() % 1_000_000,
          externalPath: ds.absPath,
        });
        attachedFile = publicFileShape(db.getDocPackFile(r.lastInsertRowid));
      } else {
        attachedFile = publicFileShape(existing);
      }
    }
  }

  return { table, row: enriched, attached_datasheet: attachedFile, data };
}

app.post('/api/docpacks/:id/equipment', requireAdmin, (req, res) => {
  try {
    const r = _appendEquipment(parseInt(req.params.id), req.body || {}, req.user.username);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Idempotent: attach a datasheet PDF to a pack by model lookup, WITHOUT
// touching the equipment lists. Used when the admin edits a model field
// inline in the equipment table (the row already exists; we just need to
// make sure the matching datasheet is in the appendix).
app.post('/api/docpacks/:id/datasheets/attach', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  const model = String(req.body?.model || '').trim();
  if (!model) return res.status(400).json({ error: 'model is required' });

  const ds = docpack.lookupDatasheet(model);
  if (!ds) return res.json({ ok: true, found: false });

  const existing = db.listDocPackFiles(id).find(f => f.external_path === ds.absPath);
  if (existing) {
    return res.json({ ok: true, found: true, attached: false, file: publicFileShape(existing) });
  }

  const r = db.addDocPackFile({
    packId: id,
    kind: 'datasheet',
    filename: null,
    originalName: ds.original + '.pdf',
    mime: 'application/pdf',
    size: (() => { try { return fs.statSync(ds.absPath).size; } catch { return 0; } })(),
    caption: ds.mfr,
    note: `דף מוצר עבור ${model}`,
    visibility: 'client',
    contributor: req.user.username,
    sortOrder: Date.now() % 1_000_000,
    externalPath: ds.absPath,
  });
  db.updateDocPack(id, pack.name, pack.data);
  res.json({ ok: true, found: true, attached: true, file: publicFileShape(db.getDocPackFile(r.lastInsertRowid)) });
});

app.post('/api/docpacks/:id/generate', requireSection('docpack'), generateRateLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });

  // ── Phase 1: sweep + attach datasheets (defensive — never fail the whole
  // export just because the sweep encountered a bad row) ──
  try {
    const swept = docpack.sweepAndAttachDatasheets(id, req.user.username);
    if (swept > 0) console.log(`[docpack] export-sweep attached ${swept} datasheet(s) to pack ${id}`);
  } catch (e) {
    console.warn('[docpack] sweep skipped due to error:', e.message, e.stack);
  }

  // ── Phase 2: render the docx — failures here should return JSON to the client ──
  let buf;
  try {
    buf = await docpack.generateDocPack(id);
  } catch (e) {
    console.error('[docpack] generate failed:', e.message);
    console.error(e.stack);
    // Include the error properties from docxtemplater if present
    let detail = e.message || 'Generation failed';
    if (e.properties && e.properties.errors) {
      const subErrs = e.properties.errors.slice(0, 3).map(x => x.message || String(x)).join(' | ');
      detail = `${detail} — sub-errors: ${subErrs}`;
    }
    return res.status(500).json({ error: detail });
  }

  try {
    const filename = sanitizeFilename(pack.name) + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition',
      `attachment; filename="docpack.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', buf.length);
    db.logAudit(req.user.id, req.user.username, 'export',
      `docpack:${pack.name}`, getClientIp(req), '');
    res.end(buf);
  } catch (e) {
    console.error('[docpack] send failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to send docx: ' + e.message });
  }
});

// ── Share tokens (admin) ──

function _genToken() {
  return require('crypto').randomBytes(24).toString('hex');
}

app.post('/api/docpacks/:id/shares', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  const token = _genToken();
  const expiresAt = req.body?.expires_at || null;
  db.createDocPackShare(id, token, req.user.username, expiresAt);
  db.logAudit(req.user.id, req.user.username, 'docpack_share_create',
    `Created share link for doc pack: ${pack.name}`, getClientIp(req), '');
  res.json({ ok: true, token, url: `/public/docpack/${token}` });
});

app.get('/api/docpacks/:id/shares', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  res.json({ shares: db.listDocPackShares(id) });
});

app.delete('/api/docpacks/:id/shares/:shareId', requireAdmin, (req, res) => {
  const shareId = parseInt(req.params.shareId);
  db.revokeDocPackShare(shareId);
  db.logAudit(req.user.id, req.user.username, 'docpack_share_revoke',
    `Revoked share link id=${shareId} for pack id=${req.params.id}`, getClientIp(req), '');
  res.json({ ok: true });
});

// ── Public share-link routes (no auth, token-validated) ──

function _validateShare(token) {
  const row = db.getDocPackShareByToken(token);
  if (!row) return { error: 'invalid', status: 404 };
  if (row.revoked_at) return { error: 'revoked', status: 410 };
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return { error: 'expired', status: 410 };
  const pack = db.getDocPack(row.pack_id);
  if (!pack) return { error: 'pack missing', status: 410 };
  db.touchDocPackShare(row.id);
  return { row, pack };
}

const shareUploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, // 60 uploads/min per IP
  standardHeaders: true, legacyHeaders: false,
});

app.get('/api/share/:token', shareUploadLimiter, (req, res) => {
  const v = _validateShare(req.params.token);
  if (v.error) return res.status(v.status).json({ error: v.error });
  let data = {};
  try { data = JSON.parse(v.pack.data || '{}'); } catch {}
  // Only client-visible files surface in the share view
  const files = db.listDocPackFilesByDate(v.pack.id)
    .filter(f => (f.visibility || 'client') === 'client')
    .map(publicFileShape);
  res.json({
    pack: {
      id: v.pack.id, name: v.pack.name, type: v.pack.type,
      data: { cameras: data.cameras || [], backhauls: data.backhauls || [], switches: data.switches || [] },
    },
    files,
  });
});

app.post('/api/share/:token/equipment', shareUploadLimiter, (req, res) => {
  const v = _validateShare(req.params.token);
  if (v.error) return res.status(v.status).json({ error: v.error });
  // H1 — strip HTML / control / quote chars at WRITE time. The name is stored
  // in many places (contributor field, _contributor in row JSON, audit detail)
  // and we cannot rely on every future render path remembering to escape it.
  const name = _sanitizeContributorName(req.header('X-Contributor-Name'));
  const contributor = `share:${v.row.id}:${name}`;
  try {
    const r = _appendEquipment(v.pack.id, req.body || {}, contributor);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/share/:token/files', shareUploadLimiter, docPackUpload.single('file'), async (req, res) => {
  const v = _validateShare(req.params.token);
  if (v.error) { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} return res.status(v.status).json({ error: v.error }); }
  // H1 — strip HTML / control / quote chars at WRITE time. The name is stored
  // in many places (contributor field, _contributor in row JSON, audit detail)
  // and we cannot rely on every future render path remembering to escape it.
  const name = _sanitizeContributorName(req.header('X-Contributor-Name'));
  const contributor = `share:${v.row.id}:${name}`;
  try {
    const file = await _ingestUploadedFile(v.pack.id, req, contributor);
    res.json({ ok: true, file });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/share/:token/datasheets/search', shareUploadLimiter, (req, res) => {
  const v = _validateShare(req.params.token);
  if (v.error) return res.status(v.status).json({ error: v.error });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ matches: [] });
  const cat = ['cameras','backhauls','switches'].includes(req.query.cat) ? req.query.cat : null;
  res.json({ matches: docpack.searchDatasheets(q, 10, cat) });
});

app.get('/api/share/:token/files/:fileId', shareUploadLimiter, (req, res) => {
  const v = _validateShare(req.params.token);
  if (v.error) return res.status(v.status).send('Not found');
  const f = db.getDocPackFile(parseInt(req.params.fileId));
  if (!f || f.pack_id !== v.pack.id) return res.status(404).send('Not found');
  if ((f.visibility || 'client') !== 'client') return res.status(403).send('Forbidden');
  const p = f.filename ? docpack.fileDiskPath(f.pack_id, f.filename) : f.external_path;
  if (!p || !fs.existsSync(p)) return res.status(404).send('Missing on disk');
  res.sendFile(p);
});

// Serve the contractor-facing HTML page (token rendered into it)
app.get('/public/docpack/:token', (req, res) => {
  const v = _validateShare(req.params.token);
  // Even on error, still serve the page; it'll show a friendly "invalid link" state via API call.
  const sharePath = path.join(__dirname, 'share.html');
  if (!fs.existsSync(sharePath)) return res.status(500).send('share.html missing');
  let html = fs.readFileSync(sharePath, 'utf8');
  html = html.replace(/\{\{TOKEN\}\}/g, req.params.token);
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// ── Exchange rates (Bank of Israel) ──────────────────────────────────────────

let _ratesCache = null, _ratesFetchedAt = 0;

app.get('/api/rates', requireAuth, async (req, res) => {
  if (_ratesCache && Date.now() - _ratesFetchedAt < 60 * 60 * 1000) {
    return res.json(_ratesCache);
  }
  try {
    const r = await fetch('https://boi.org.il/PublicApi/GetExchangeRates');
    const j = await r.json();
    const rates = {};
    for (const item of (j.exchangeRates || [])) {
      if (['USD', 'EUR'].includes(item.key)) {
        rates[item.key] = item.currentExchangeRate;
      }
    }
    if (Object.keys(rates).length) {
      _ratesCache = rates;
      _ratesFetchedAt = Date.now();
    }
    res.json(rates);
  } catch (e) {
    console.error('[rates]', e.message);
    if (_ratesCache) return res.json(_ratesCache); // serve stale cache on error
    res.status(502).json({ error: 'rates unavailable' });
  }
});

// ── Audit log (admin only) ────────────────────────────────────────────────────

app.get('/api/audit', requireAdmin, (req, res) => {
  const { username, action, from, to, limit = 100, offset = 0 } = req.query;
  const result = db.listAudit({
    username: username || null,
    action:   action   || null,
    from:     from     || null,
    to:       to       || null,
    limit:    Math.min(parseInt(limit) || 100, 500),
    offset:   parseInt(offset) || 0,
  });
  res.json(result);
});

// ── Static files (auth protected) ────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'dashboard.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'admin.html'));
});

// Serve PDFs — auth required
app.get('/ds/*', requireAuth, (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  // Prevent path traversal
  const relPath = req.params[0];
  if (relPath.includes('..') || relPath.includes('\0')) {
    return res.status(400).send('Invalid path');
  }

  let filePath = path.join(DS_PATH, relPath);

  // Ensure file is inside DS_PATH
  if (!filePath.startsWith(DS_PATH)) return res.status(400).send('Invalid path');

  // If not found in DS_PATH, fall back to the git-committed ./ds/ folder
  if (!fs.existsSync(filePath)) {
    const fallback = path.join(DS_FALLBACK, relPath);
    if (DS_FALLBACK !== DS_PATH && fallback.startsWith(DS_FALLBACK) && fs.existsSync(fallback)) {
      filePath = fallback;
    } else {
      return res.status(404).send('Not found');
    }
  }

  // Log only PDF opens
  if (filePath.endsWith('.pdf')) {
    db.logAudit(req.user.id, req.user.username, 'view_ds', relPath, ip, ua);
  }

  res.sendFile(filePath);
});

// Static assets (logo, etc.) — auth required
app.use(requireAuth, express.static(STATIC_DIR, {
  index: false,
  dotfiles: 'deny',
  extensions: ['png', 'jpg', 'ico', 'svg'],
}));

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Process-level safety ──────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);
  console.log(`[server] DS_PATH: ${DS_PATH}`);
  console.log(`[server] DB_PATH: ${process.env.DB_PATH || 'data/db.sqlite'}`);
  try { docpack.dryRenderAllTemplates(); } catch (e) { console.error('[docpack] dry-render error:', e.message); }
});
