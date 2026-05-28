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

const crypto  = require('crypto');
const nodemailer = require('nodemailer');
const { totp: _totp } = require('otplib');
const QRCode = require('qrcode');

const db        = require('./db');
const docpack   = require('./docpack');
const dsFinder  = require('./ds-finder');

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
const APP_URL    = (process.env.APP_URL || 'https://nuvo.co.il').replace(/\/$/, '');

// ── Email (nodemailer / Gmail) ────────────────────────────────────────────────

const _mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendMail(to, subject, html) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mail] SMTP not configured — skipping email to', to);
    return;
  }
  try {
    await _mailer.sendMail({
      from: `"אפקון" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    console.log('[mail] sent to', to, '|', subject);
  } catch (e) {
    console.error('[mail] send failed to', to, '—', e.message);
  }
}

// ── User-request helpers ──────────────────────────────────────────────────────

function _genUsername(email, existingUsernames) {
  // Use the part of the email before @ as the base username, keep only safe chars.
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user';
  if (!existingUsernames.has(base)) return base;
  let i = 2;
  while (existingUsernames.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function _genTempPassword() {
  // 10 random URL-safe chars + guaranteed upper + digit + symbol so it passes validatePassword
  const rand = crypto.randomBytes(8).toString('base64url').slice(0, 8);
  return `${rand.charAt(0).toUpperCase()}${rand.slice(1)}!7`;
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' here is required because dashboard.html uses inline
      // onclick="..." handlers and inline <script> blocks. Removing it would
      // need a full migration of all event handlers to addEventListener.
      scriptSrc:     ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
      fontSrc:    ["'self'", 'fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
      frameSrc:   ["'self'"],   // allow same-origin iframes (PDF preview)
      connectSrc: ["'self'"],
    }
  },
  // HSTS preload: 1 year + includeSubDomains + preload directive.
  // Eligible for submission at https://hstspreload.org/ once live.
  strictTransportSecurity: {
    maxAge: 60 * 60 * 24 * 365,    // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

// Permissions-Policy: explicitly deny browser APIs we don't use. Bonus
// Observatory score + prevents an XSS from accessing camera/mic/geolocation
// even if it somehow runs.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), ' +
    'encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), ' +
    'magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), ' +
    'publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), ' +
    'web-share=(), xr-spatial-tracking=()'
  );
  next();
});
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
  // Reject pending/intermediate TOTP tokens — they cannot access protected APIs
  if (!payload || payload.step) {
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

// Middleware for TOTP intermediate steps (pendingToken in request body)
function requirePendingToken(expectedStep) {
  return (req, res, next) => {
    const tok = req.body?.pendingToken;
    const p = tok ? verifyToken(tok) : null;
    if (!p || p.step !== expectedStep) {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
    req.pendingUserId = p.id;
    next();
  };
}

// TOTP helpers
function _generateSecret() {
  return _totp.generateSecret();
}
function _verifyTotpCode(secret, code) {
  try {
    _totp.options = { window: 1 }; // allow ±30s drift
    return _totp.check(String(code).replace(/\s/g, ''), secret);
  } catch { return false; }
}
function _generateBackupCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    return raw.slice(0, 4) + '-' + raw.slice(4);
  });
}
function _verifyTotpOrBackup(user, rawCode) {
  const code = String(rawCode || '').replace(/\s/g, '').toUpperCase();
  // 6-digit TOTP
  if (/^\d{6}$/.test(code)) return _verifyTotpCode(user.totp_secret, code);
  // Backup code (XXXX-XXXX)
  if (!user.totp_backup_codes) return false;
  let stored;
  try { stored = JSON.parse(user.totp_backup_codes); } catch { return false; }
  for (let i = 0; i < stored.length; i++) {
    if (bcrypt.compareSync(code, stored[i])) {
      stored.splice(i, 1);
      db.updateUserBackupCodes(user.id, JSON.stringify(stored));
      return true;
    }
  }
  return false;
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

// Max 5 registration-request submissions per IP per hour
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'יותר מדי בקשות — נסה שנית בעוד שעה' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  const token = req.cookies?.token;
  if (verifyToken(token)) return res.redirect('/dashboard');
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

  // ── 2FA gate ──────────────────────────────────────────────────────────────
  // Issue a short-lived pending token instead of a full session token.
  // The full JWT cookie is only set after TOTP is verified.
  if (user.totp_enabled) {
    const pendingToken = jwt.sign({ id: user.id, step: 'totp_verify' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ ok: true, requires2fa: true, pendingToken });
  }
  // No 2FA set up yet — force enrollment before granting access
  const pendingToken = jwt.sign({ id: user.id, step: 'totp_setup' }, JWT_SECRET, { expiresIn: '10m' });
  return res.json({ ok: true, needsTotpSetup: true, pendingToken, must_change_password: !!user.must_change_password });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  db.logAudit(req.user.id, req.user.username, 'logout', null, ip, ua);
  res.clearCookie('token');
  res.json({ ok: true });
});

// ── TOTP 2FA routes ───────────────────────────────────────────────────────────

// Rate limiter for TOTP verification (prevent brute force on the 6-digit code)
const totpLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,  // 2 minutes
  max: 8,
  message: { error: 'יותר מדי ניסיונות — נסה שנית בעוד 2 דקות' },
  standardHeaders: true, legacyHeaders: false,
});

// Change password during TOTP setup flow (before full JWT is issued)
// Used when must_change_password=1 AND totp not yet configured
app.post('/api/auth/totp/change-password', (req, res) => {
  const { pendingToken, currentPassword, newPassword } = req.body || {};
  if (!pendingToken || !currentPassword || !newPassword)
    return res.status(400).json({ error: 'Missing fields' });
  const pending = verifyToken(pendingToken);
  if (!pending || pending.step !== 'totp_setup')
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  const user = db.getUserById(pending.id);
  if (!user || !user.active) return res.status(401).json({ error: 'Unauthorized' });
  if (!bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (currentPassword === newPassword)
    return res.status(400).json({ error: 'הסיסמה החדשה זהה לישנה' });
  db.setPassword(user.id, newPassword);
  db.setMustChangePassword(user.id, 0);
  db.logAudit(user.id, user.username, 'change_password', 'Password changed during TOTP setup', null, '');
  // Issue fresh pending token (extends window after password change)
  const newPendingToken = jwt.sign({ id: user.id, step: 'totp_setup' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ ok: true, pendingToken: newPendingToken });
});

// Step 1b: Generate TOTP secret + QR code (called during setup flow)
// Accepts EITHER a pending setup token (body.pendingToken) OR a logged-in session (cookie)
app.post('/api/auth/totp/setup', async (req, res) => {
  let userId;
  // Try pending token first
  const tok = req.body?.pendingToken;
  const pending = tok ? verifyToken(tok) : null;
  if (pending && pending.step === 'totp_setup') {
    userId = pending.id;
  } else {
    // Fall back to full session (user re-triggering setup from dashboard)
    const cookiePayload = verifyToken(req.cookies?.token);
    if (!cookiePayload || cookiePayload.step) return res.status(401).json({ error: 'Unauthorized' });
    userId = cookiePayload.id;
  }
  const user = db.getUserById(userId);
  if (!user || !user.active) return res.status(401).json({ error: 'Unauthorized' });

  const secret = _generateSecret();
  db.setUserTotpSecret(userId, secret);

  const label = encodeURIComponent(`Afkon (${user.username})`);
  const issuer = encodeURIComponent('Afkon');
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  try {
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', width: 240 });
    res.json({ ok: true, secret, qrDataUrl, otpauthUrl });
  } catch (e) {
    console.error('[totp/setup] QR generation failed:', e.message);
    // Return the otpauth URL even if QR fails — client can use manual entry
    res.json({ ok: true, secret, qrDataUrl: null, otpauthUrl });
  }
});

// Step 1c: Activate TOTP — verify code, store backup codes, issue full JWT
app.post('/api/auth/totp/activate', totpLimiter, (req, res) => {
  const { code, pendingToken } = req.body || {};
  let userId;
  const pending = pendingToken ? verifyToken(pendingToken) : null;
  if (pending && pending.step === 'totp_setup') {
    userId = pending.id;
  } else {
    const cookiePayload = verifyToken(req.cookies?.token);
    if (!cookiePayload || cookiePayload.step) return res.status(401).json({ error: 'Unauthorized' });
    userId = cookiePayload.id;
  }
  const user = db.getUserById(userId);
  if (!user || !user.active || !user.totp_secret) return res.status(401).json({ error: 'Unauthorized' });

  if (!_verifyTotpCode(user.totp_secret, code)) {
    return res.status(400).json({ error: 'קוד שגוי — בדוק שהשעה מסונכרנת ונסה שנית' });
  }

  // Generate and hash backup codes
  const rawCodes = _generateBackupCodes();
  const hashedCodes = rawCodes.map(c => bcrypt.hashSync(c, 10));
  db.enableUserTotp(userId, JSON.stringify(hashedCodes));
  db.logAudit(userId, user.username, 'totp_enabled', 'TOTP 2FA activated', null, '');

  // Issue full JWT cookie now that 2FA is confirmed
  const token = signToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000,
  });
  res.json({ ok: true, backupCodes: rawCodes, role: user.role, must_change_password: !!user.must_change_password });
});

// Step 2: Verify TOTP code after password login (totp_enabled=1 path)
app.post('/api/auth/totp/verify', totpLimiter, (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'Missing fields' });

  const pending = verifyToken(pendingToken);
  if (!pending || pending.step !== 'totp_verify') {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  const user = db.getUserById(pending.id);
  if (!user || !user.active) return res.status(401).json({ error: 'Unauthorized' });
  if (!user.totp_enabled || !user.totp_secret) return res.status(400).json({ error: '2FA not configured' });

  if (!_verifyTotpOrBackup(user, code)) {
    db.logAudit(user.id, user.username, 'totp_fail', 'Wrong TOTP code', null, '');
    return res.status(401).json({ error: 'קוד שגוי — בדוק את האפליקציה ונסה שנית' });
  }

  db.logAudit(user.id, user.username, 'login_totp', 'TOTP verified', null, '');
  const token = signToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000,
  });
  res.json({ ok: true, role: user.role, must_change_password: !!user.must_change_password });
});

// Admin: reset 2FA for any user
app.post('/api/admin/users/:id/reset-2fa', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.disableUserTotp(id);
  db.logAudit(req.user.id, req.user.username, 'totp_reset',
    `Reset 2FA for user: ${target.username}`, getClientIp(req), '');
  res.json({ ok: true });
});

// ── General auth routes ────────────────────────────────────────────────────────

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // sections: null = all access (admin), array = specific allowed views (viewer)
  let sections = null;
  if (user.role !== 'admin') {
    sections = user.sections ? JSON.parse(user.sections) : [];
  }
  res.json({ id: user.id, username: user.username, role: user.role, sections, totp_enabled: !!user.totp_enabled });
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
  res.json(db.listUsersWithTotp());
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

// ── User join requests (public) ───────────────────────────────────────────────

// POST /api/user-requests — public, no auth, rate-limited
app.post('/api/user-requests', requestLimiter, async (req, res) => {
  const { firstName, lastName, email, phone, roleTitle, division } = req.body;

  // Validate all fields
  if (!firstName || !lastName || !email || !phone || !roleTitle || !division)
    return res.status(400).json({ error: 'כל השדות נדרשים' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'כתובת מייל אינה תקינה' });
  if (!/^[\d\s\-\+\(\)]{7,20}$/.test(phone))
    return res.status(400).json({ error: 'מספר טלפון אינו תקין' });
  if (String(firstName).length > 60 || String(lastName).length > 60)
    return res.status(400).json({ error: 'שם ארוך מדי' });

  const r = db.createUserRequest(
    String(firstName).trim(),
    String(lastName).trim(),
    String(email).trim().toLowerCase(),
    String(phone).trim(),
    String(roleTitle).trim(),
    String(division).trim()
  );
  const reqId = r.lastInsertRowid;
  const fullName = `${String(firstName).trim()} ${String(lastName).trim()}`;

  // Send confirmation to requester (best-effort)
  await sendMail(
    String(email).trim(),
    'בקשתך התקבלה — מערכת ניהול פרויקטים אפקון',
    `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#1a2a4a">בקשתך התקבלה ✅</h2>
      <p>שלום ${fullName},</p>
      <p>קיבלנו את בקשתך לפתיחת משתמש במערכת ניהול הפרויקטים של אפקון.</p>
      <p>הבקשה נמצאת בבדיקה — נחזור אליך בהקדם.</p>
      <br><p style="color:#64748b;font-size:.88em">אפקון בקרה ואוטומציה</p>
    </div>`
  );

  // Notify admin(s) if configured
  if (process.env.ADMIN_NOTIFY_EMAIL) {
    for (const adminEmail of process.env.ADMIN_NOTIFY_EMAIL.split(',').map(e => e.trim()).filter(Boolean)) {
      await sendMail(
        adminEmail,
        `בקשת הצטרפות חדשה — ${fullName}`,
        `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
          <h2 style="color:#1a2a4a">בקשת הצטרפות חדשה 📋</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:6px 12px;font-weight:700;color:#475569">שם:</td><td style="padding:6px 12px">${fullName}</td></tr>
            <tr style="background:#f8fafc"><td style="padding:6px 12px;font-weight:700;color:#475569">מייל:</td><td style="padding:6px 12px">${String(email).trim()}</td></tr>
            <tr><td style="padding:6px 12px;font-weight:700;color:#475569">טלפון:</td><td style="padding:6px 12px">${String(phone).trim()}</td></tr>
            <tr style="background:#f8fafc"><td style="padding:6px 12px;font-weight:700;color:#475569">תפקיד:</td><td style="padding:6px 12px">${String(roleTitle).trim()}</td></tr>
            <tr><td style="padding:6px 12px;font-weight:700;color:#475569">חטיבה:</td><td style="padding:6px 12px">${String(division).trim()}</td></tr>
          </table>
          <br>
          <a href="${APP_URL}/admin" style="background:#4f86f7;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700">לניהול הבקשה ←</a>
        </div>`
      );
    }
  }

  res.json({ ok: true, id: reqId });
});

// GET /api/user-requests — admin only, list all requests
app.get('/api/user-requests', requireAdmin, (req, res) => {
  res.json(db.listUserRequests());
});

// GET /api/user-requests/pending-count — admin only, for badge
app.get('/api/user-requests/pending-count', requireAdmin, (req, res) => {
  res.json({ count: db.listPendingUserRequests().length });
});

// PUT /api/user-requests/:id/approve
app.put('/api/user-requests/:id/approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const request = db.getUserRequest(id);
  if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });
  if (request.status !== 'pending')
    return res.status(400).json({ error: 'הבקשה כבר טופלה' });

  // Generate username from email
  const existingUsernames = new Set(db.listUsers().map(u => u.username.toLowerCase()));
  const username = _genUsername(request.email, existingUsernames);
  const tempPw   = _genTempPassword();

  try {
    db.createUser(username, tempPw, 'viewer');
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `שם המשתמש "${username}" כבר קיים` });
    }
    throw e;
  }

  db.approveUserRequest(id, req.user.username);
  db.logAudit(req.user.id, req.user.username, 'user_request_approved',
    `Approved request ${id} — created user: ${username}`, getClientIp(req), '');

  const fullName = `${request.first_name} ${request.last_name}`;

  // Send approval email with credentials
  await sendMail(
    request.email,
    'בקשתך אושרה — פרטי כניסה למערכת',
    `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#166534">בקשתך אושרה ✅</h2>
      <p>שלום ${fullName},</p>
      <p>בקשתך לפתיחת משתמש אושרה! להלן פרטי הכניסה שלך:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <tr style="background:#f0fdf4"><td style="padding:10px 16px;font-weight:700;color:#166534">כתובת המערכת:</td>
          <td style="padding:10px 16px"><a href="${APP_URL}">${APP_URL}</a></td></tr>
        <tr><td style="padding:10px 16px;font-weight:700;color:#475569">שם משתמש:</td>
          <td style="padding:10px 16px;font-family:monospace;font-size:1.1em">${username}</td></tr>
        <tr style="background:#f8fafc"><td style="padding:10px 16px;font-weight:700;color:#475569">סיסמה זמנית:</td>
          <td style="padding:10px 16px;font-family:monospace;font-size:1.1em">${tempPw}</td></tr>
      </table>
      <p style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;font-size:.9em;color:#92400e">
        ⚠️ בכניסה הראשונה תתבקש להחליף את הסיסמה הזמנית לסיסמה אישית.
      </p>
      <br><p style="color:#64748b;font-size:.88em">אפקון בקרה ואוטומציה</p>
    </div>`
  );

  res.json({ ok: true, username });
});

// PUT /api/user-requests/:id/reject
app.put('/api/user-requests/:id/reject', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const request = db.getUserRequest(id);
  if (!request) return res.status(404).json({ error: 'בקשה לא נמצאה' });
  if (request.status !== 'pending')
    return res.status(400).json({ error: 'הבקשה כבר טופלה' });

  const note = String(req.body.rejection_note || '').trim().slice(0, 500);
  db.rejectUserRequest(id, req.user.username, note);
  db.logAudit(req.user.id, req.user.username, 'user_request_rejected',
    `Rejected request ${id} — ${request.email}`, getClientIp(req), '');

  const fullName = `${request.first_name} ${request.last_name}`;

  // Send rejection email
  await sendMail(
    request.email,
    'עדכון בקשת הצטרפות — אפקון',
    `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#1a2a4a">עדכון לגבי בקשתך</h2>
      <p>שלום ${fullName},</p>
      <p>לצערנו, בקשתך לפתיחת משתמש במערכת לא אושרה בשלב זה.</p>
      ${note ? `<p style="background:#f1f5f9;border-radius:8px;padding:10px 14px;color:#374151"><strong>הערת המנהל:</strong> ${note}</p>` : ''}
      <p>לשאלות, ניתן לפנות ישירות לאחראי המערכת.</p>
      <br><p style="color:#64748b;font-size:.88em">אפקון בקרה ואוטומציה</p>
    </div>`
  );

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

// ── Purchase requisitions (דרישת רכש) ────────────────────────────────────────

function parseReqItems(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

function normalizeReqItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(it => it && typeof it === 'object')
    .map(it => ({
      source: it.source === 'warehouse' ? 'warehouse' : 'pricelist',
      sku:    String(it.sku  ?? '').trim(),
      desc:   String(it.desc ?? '').trim(),
      qty:    Math.max(0, Number(it.qty) || 0),
      unit:   String(it.unit ?? '').trim(),
      price:  Number(it.price) || 0,
      cur:    String(it.cur  ?? '').trim() || 'ILS',
    }))
    .filter(it => it.sku && it.qty > 0);
}

const VALID_REQ_STATUSES = ['draft', 'pending', 'approved', 'done'];

app.get('/api/requisitions', requireAuth, (_req, res) => {
  const rows = db.listRequisitions().map(r => {
    const items = parseReqItems(r.items_json);
    return {
      id:         r.id,
      req_number: r.req_number,
      supplier:   r.supplier,
      requester:  r.requester,
      show_prices: !!r.show_prices,
      status:     r.status || 'draft',
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: r.created_by,
      item_count: items.length,
    };
  });
  res.json({ items: rows });
});

app.get('/api/requisitions/:id', requireAuth, (req, res) => {
  const r = db.getRequisition(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({
    id:          r.id,
    req_number:  r.req_number,
    supplier:    r.supplier,
    requester:   r.requester,
    notes:       r.notes,
    items:       parseReqItems(r.items_json),
    show_prices: !!r.show_prices,
    status:      r.status || 'draft',
    created_at:  r.created_at,
    updated_at:  r.updated_at,
    created_by:  r.created_by,
  });
});

app.patch('/api/requisitions/:id/status', requireAuth, (req, res) => {
  const existing = db.getRequisition(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body || {};
  if (!VALID_REQ_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_REQ_STATUSES.join(', ')}` });
  }
  db.updateRequisitionStatus(req.params.id, status);
  db.logAudit(req.user.id, req.user.username, 'requisition_status',
    `${existing.req_number}: ${existing.status || 'draft'} → ${status}`, getClientIp(req), '');
  res.json({ ok: true });
});

app.post('/api/requisitions', requireAuth, (req, res) => {
  const { supplier, requester, notes, items, show_prices, status } = req.body || {};
  const normItems = normalizeReqItems(items);
  const id = uuidv4();
  const reqNumber = db.nextReqNumber();
  try {
    db.createRequisition({
      id, reqNumber,
      supplier:  supplier  ? String(supplier).trim()  : null,
      requester: requester ? String(requester).trim() : null,
      notes:     notes     ? String(notes).trim()     : null,
      itemsJson: JSON.stringify(normItems),
      showPrices: show_prices !== false,
      status: VALID_REQ_STATUSES.includes(status) ? status : 'draft',
      createdBy: req.user.username || null,
    });
    db.logAudit(req.user.id, req.user.username, 'requisition_create',
      `${reqNumber} (${normItems.length} items)`, getClientIp(req), '');
    res.json({ ok: true, id, req_number: reqNumber });
  } catch (e) {
    console.error('[requisitions] create failed:', e.message);
    res.status(500).json({ error: 'Failed to create requisition' });
  }
});

app.put('/api/requisitions/:id', requireAuth, (req, res) => {
  const existing = db.getRequisition(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { supplier, requester, notes, items, show_prices } = req.body || {};
  const normItems = normalizeReqItems(items);
  try {
    db.updateRequisition(req.params.id, {
      supplier:  supplier  ? String(supplier).trim()  : null,
      requester: requester ? String(requester).trim() : null,
      notes:     notes     ? String(notes).trim()     : null,
      itemsJson: JSON.stringify(normItems),
      showPrices: show_prices !== false,
    });
    db.logAudit(req.user.id, req.user.username, 'requisition_update',
      `${existing.req_number} (${normItems.length} items)`, getClientIp(req), '');
    res.json({ ok: true });
  } catch (e) {
    console.error('[requisitions] update failed:', e.message);
    res.status(500).json({ error: 'Failed to update requisition' });
  }
});

app.delete('/api/requisitions/:id', requireAuth, (req, res) => {
  const existing = db.getRequisition(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.deleteRequisition(req.params.id);
  db.logAudit(req.user.id, req.user.username, 'requisition_delete',
    existing.req_number, getClientIp(req), '');
  res.json({ ok: true });
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

// ── DS Finder background worker routes ───────────────────────────────────────

const dsfCatalogLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many catalog sync requests' },
});

// Status: pending/found/not_found/error counts + last-run timestamps
app.get('/api/admin/ds-finder/status', requireAdmin, (_req, res) => {
  res.json(dsFinder.getStatus());
});

// List queue items (most recent first, optional ?status= filter)
app.get('/api/admin/ds-finder/list', requireAdmin, (req, res) => {
  // By default exclude 'found' items — they don't need attention.
  // Pass ?status=found or ?status=all to include them.
  const status = req.query.status;
  let items;
  if (status === 'all') {
    items = db.listDsQueue(null, 2000);
  } else if (status) {
    items = db.listDsQueue(status, 500);
  } else {
    items = db.listDsQueueActive(500); // default: pending + error + not_found only
  }
  res.json({ items });
});

// Manual trigger: populate queue + process 10 items immediately
app.post('/api/admin/ds-finder/run', requireAdmin, (req, res) => {
  setImmediate(async () => {
    try {
      await dsFinder.populateQueue();
      await dsFinder.processQueue(10);
    } catch (e) {
      console.error('[ds-finder] manual run error:', e.message);
    }
  });
  db.logAudit(req.user.id, req.user.username, 'ds_finder_run',
    'Manual ds-finder triggered', getClientIp(req), '');
  res.json({ ok: true });
});

// Pause the background worker (intervals keep running, processQueue no-ops)
app.post('/api/admin/ds-finder/pause', requireAdmin, (req, res) => {
  dsFinder.pauseWorker();
  db.logAudit(req.user.id, req.user.username, 'ds_finder_pause', 'Worker paused', getClientIp(req), '');
  res.json({ ok: true, paused: true });
});

// Resume the background worker
app.post('/api/admin/ds-finder/resume', requireAdmin, (req, res) => {
  dsFinder.resumeWorker();
  db.logAudit(req.user.id, req.user.username, 'ds_finder_resume', 'Worker resumed', getClientIp(req), '');
  res.json({ ok: true, paused: false });
});

// Manual URL download: admin provides model + manufacturer + PDF URL, download happens immediately
app.post('/api/admin/ds-finder/manual', requireAdmin, async (req, res) => {
  const { model, manufacturer, url } = req.body || {};
  if (!model || !manufacturer || !url) {
    return res.status(400).json({ error: 'model, manufacturer and url are required' });
  }
  try {
    const result = await dsFinder.downloadFromUrl(model.trim(), manufacturer.trim(), url.trim());
    if (result.success) {
      const filename = path.basename(result.path);
      db.logAudit(req.user.id, req.user.username, 'ds_finder_manual',
        `${manufacturer}/${model} → ${filename}`, getClientIp(req), url);
      res.json({ ok: true, path: result.path, filename, foundViaSearch: result.foundViaSearch || false });
    } else {
      res.status(422).json({ ok: false, error: result.error });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Per-manufacturer settings: list with per-manufacturer stats
app.get('/api/admin/ds-finder/manufacturers', requireAdmin, (_req, res) => {
  res.json({ manufacturers: db.listDsFinderManufacturers() });
});

// Per-manufacturer settings: toggle enabled/disabled
app.put('/api/admin/ds-finder/manufacturers/:mfr', requireAdmin, (req, res) => {
  const mfr     = req.params.mfr;
  const enabled = req.body.enabled !== false && req.body.enabled !== 0;
  db.setDsFinderSetting(mfr, enabled);
  db.logAudit(req.user.id, req.user.username, 'ds_finder_setting',
    `${mfr}: ${enabled ? 'enabled' : 'disabled'}`, getClientIp(req), '');
  res.json({ ok: true, manufacturer: mfr, enabled });
});

// Reset backoff: set next_retry_at=now for all error items so they get processed on next run
app.post('/api/admin/ds-finder/reset-errors', requireAdmin, (req, res) => {
  const info = db.resetDsQueueErrors();
  db.logAudit(req.user.id, req.user.username, 'ds_finder_reset', `Reset ${info.changes} error items`, getClientIp(req), '');
  res.json({ ok: true, count: info.changes });
});

// Catalog sync: browser sends catalog items missing datasheets
app.post('/api/admin/ds-finder/catalog', requireAdmin, dsfCatalogLimiter, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  if (items.length > 500)    return res.status(400).json({ error: 'too many items (max 500)' });
  const added = dsFinder.addCatalogItems(items);
  res.json({ ok: true, added });
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

// Public landing page — authenticated users are redirected directly to dashboard
app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (verifyToken(token)) return res.redirect('/dashboard');
  res.sendFile(path.join(STATIC_DIR, 'landing.html'));
});

// Main dashboard — requires authentication
app.get('/dashboard', requireAuth, (req, res) => {
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

// Public: logo served without auth (needed on landing page before login)
app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'logo.png'));
});

// Static assets — auth required
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
  // Start the background datasheet-finder worker
  // Runs in production automatically; set DS_FINDER_ENABLED=1 to test locally
  if (process.env.NODE_ENV === 'production' || process.env.DS_FINDER_ENABLED === '1') {
    try { dsFinder.startWorker(); }
    catch (e) { console.error('[ds-finder] failed to start:', e.message); }
  }
});
