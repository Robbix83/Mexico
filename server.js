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

const docPackUpload = multer({
  dest: DOC_UPLOAD_STAGING,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files allowed (jpg/png/webp/gif)'));
  },
});

function sanitizeFilename(name) {
  // Strip path traversal, keep extension; default to .docx for the export filename
  const base = String(name || 'תיק תיעוד').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return base || 'תיק תיעוד';
}

app.get('/api/docpacks', requireAuth, (req, res) => {
  res.json({ packs: db.listDocPacks() });
});

app.post('/api/docpacks', requireAdmin, (req, res) => {
  const { name, type } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required' });
  const r = db.createDocPack(name.trim(), type || 'cctv', '{}', req.user.id, req.user.username);
  db.logAudit(req.user.id, req.user.username, 'create_user',
    `Created doc pack: ${name.trim()}`, getClientIp(req), '');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.get('/api/docpacks/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  const files = db.listDocPackFiles(id).map(f => ({
    id: f.id, kind: f.kind, original_name: f.original_name, mime: f.mime,
    size: f.size, caption: f.caption, sort_order: f.sort_order,
  }));
  let data = {};
  try { data = JSON.parse(pack.data || '{}'); } catch { data = {}; }
  res.json({
    pack: {
      id: pack.id, name: pack.name, type: pack.type, data,
      created_at: pack.created_at, updated_at: pack.updated_at,
      created_by_username: pack.created_by_username,
    },
    files,
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
  // Delete files from disk first
  const files = db.listDocPackFiles(id);
  for (const f of files) {
    const p = docpack.fileDiskPath(id, f.filename);
    try { fs.unlinkSync(p); } catch {/* missing file is fine */}
  }
  try { fs.rmdirSync(docpack.packDir(id)); } catch {/* dir non-empty or missing — fine */}
  db.deleteDocPack(id); // ON DELETE CASCADE removes rows in doc_pack_files
  db.logAudit(req.user.id, req.user.username, 'delete_user',
    `Deleted doc pack: ${pack.name}`, getClientIp(req), '');
  res.json({ ok: true });
});

app.post('/api/docpacks/:id/files', requireAdmin, docPackUpload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} return res.status(404).json({ error: 'Pack not found' }); }
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  const kind = ['photo','diagram','network_diagram','site_plan'].includes(req.body.kind) ? req.body.kind : 'photo';
  const ext = (req.file.originalname.match(/\.([a-z0-9]{2,5})$/i) || [, 'jpg'])[1].toLowerCase();
  const newName = `${uuidv4()}.${ext}`;
  const destPath = docpack.fileDiskPath(id, newName);
  try {
    fs.renameSync(req.file.path, destPath);
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: 'failed to move uploaded file: ' + e.message });
  }
  const sortOrder = Date.now() % 1000000;
  const r = db.addDocPackFile(id, kind, newName, req.file.originalname, req.file.mimetype, req.file.size, req.body.caption || '', sortOrder);
  // touch pack updated_at
  db.updateDocPack(id, pack.name, pack.data);
  res.json({ ok: true, file: { id: r.lastInsertRowid, kind, filename: newName, original_name: req.file.originalname, size: req.file.size, mime: req.file.mimetype } });
});

app.get('/api/docpacks/:id/files/:fileId', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  const f = db.getDocPackFile(fileId);
  if (!f || f.pack_id !== id) return res.status(404).send('Not found');
  const p = docpack.fileDiskPath(id, f.filename);
  if (!fs.existsSync(p)) return res.status(404).send('Missing on disk');
  res.sendFile(p);
});

app.delete('/api/docpacks/:id/files/:fileId', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  const f = db.getDocPackFile(fileId);
  if (!f || f.pack_id !== id) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(docpack.fileDiskPath(id, f.filename)); } catch {}
  db.deleteDocPackFile(fileId);
  res.json({ ok: true });
});

app.patch('/api/docpacks/:id/files/:fileId', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const fileId = parseInt(req.params.fileId);
  const f = db.getDocPackFile(fileId);
  if (!f || f.pack_id !== id) return res.status(404).json({ error: 'Not found' });
  const caption   = req.body?.caption   ?? f.caption ?? '';
  const sortOrder = req.body?.sort_order ?? f.sort_order ?? 0;
  db.updateDocPackFileMeta(fileId, caption, sortOrder);
  res.json({ ok: true });
});

app.post('/api/docpacks/:id/generate', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  try {
    const buf = docpack.generateDocPack(id);
    const filename = sanitizeFilename(pack.name) + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // Use RFC 5987 encoding for non-ASCII filenames (Hebrew)
    res.setHeader('Content-Disposition',
      `attachment; filename="docpack.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Length', buf.length);
    db.logAudit(req.user.id, req.user.username, 'export',
      `docpack:${pack.name}`, getClientIp(req), '');
    res.end(buf);
  } catch (e) {
    console.error('[docpack] generate failed:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Generation failed' });
  }
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
