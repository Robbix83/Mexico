require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');

const db = require('./db');

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
app.use(express.json());
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

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    db.logAudit(user?.id, username, 'login_fail', 'Wrong credentials', ip, ua);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!user.active) {
    db.logAudit(user.id, user.username, 'login_fail', 'Account disabled', ip, ua);
    return res.status(401).json({ error: 'Account is disabled' });
  }

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

app.put('/api/users/:id/sections', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { sections } = req.body;
  const valid = ['list', 'kanban', 'catalog', 'pricelist'];
  if (!Array.isArray(sections) || sections.some(s => !valid.includes(s)))
    return res.status(400).json({ error: 'Invalid sections value' });
  db.setSections(id, sections);
  db.logAudit(req.user.id, req.user.username, 'update_user',
    `Set sections for user id=${id}: [${sections.join(',')}]`, getClientIp(req), '');
  res.json({ ok: true });
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
});
