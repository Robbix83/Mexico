require('dotenv').config();
const compression  = require('compression');
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
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse     = require('pdf-parse');

const crypto  = require('crypto');
const nodemailer = require('nodemailer');
const { totp: _totp } = require('otplib');
const QRCode = require('qrcode');

const db        = require('./db');
const docpack   = require('./docpack');
const docparse  = require('./docparse');
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
      from: `"מערכת ניהול" <${process.env.SMTP_USER}>`,
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
app.use(compression());                    // gzip all responses — critical for mobile
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
// Generate a TOTP-compatible base32 secret using Node crypto directly.
// Avoids otplib's generateSecret() which can fail if its internal options
// state is corrupted by the options-spread pattern used in _verifyTotpCode.
function _generateSecret() {
  const bytes = crypto.randomBytes(20);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '', bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { result += chars[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) result += chars[(value << (5 - bits)) & 31];
  return result;
}
// Pure Node.js TOTP verification (RFC 6238 / HOTP RFC 4226).
// Does NOT use otplib at all, so there is no risk of options-state corruption.
function _base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const char of str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(output);
}
function _hotpCode(secretBuf, counter) {
  const msg = Buffer.allocUnsafe(8);
  msg.writeUInt32BE(0, 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff)
  ) % 1000000;
  return String(code).padStart(6, '0');
}
function _verifyTotpCode(secret, code) {
  try {
    const clean = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    const key = _base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / 30);
    // Allow ±1 window (±30 s) to account for clock skew
    for (let delta = -1; delta <= 1; delta++) {
      if (_hotpCode(key, counter + delta) === clean) return true;
    }
    return false;
  } catch (e) {
    console.error('[verifyTotpCode]', e.message);
    return false;
  }
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
  // In development mode, skip TOTP entirely and issue a full session token.
  if (process.env.NODE_ENV !== 'production') {
    const token = signToken(user);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
    return res.json({ ok: true });
  }
  // Issue a short-lived pending token instead of a full session token.
  // The full JWT cookie is only set after TOTP is verified.
  if (user.totp_enabled) {
    const pendingToken = jwt.sign({ id: user.id, step: 'totp_verify' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ ok: true, requires2fa: true, pendingToken });
  }
  // No 2FA set up yet — force enrollment before granting access
  const pendingToken = jwt.sign({ id: user.id, step: 'totp_setup' }, JWT_SECRET, { expiresIn: '30m' });
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
  const newPendingToken = jwt.sign({ id: user.id, step: 'totp_setup' }, JWT_SECRET, { expiresIn: '30m' });
  res.json({ ok: true, pendingToken: newPendingToken });
});

// Step 1b: Return TOTP secret + otpauth URL (QR is generated client-side)
// Accepts EITHER a pending setup token (body.pendingToken) OR a logged-in session (cookie)
app.post('/api/auth/totp/setup', (req, res) => {
  try {
    let userId;
    const tok = req.body?.pendingToken;
    const pending = tok ? verifyToken(tok) : null;
    if (pending && pending.step === 'totp_setup') {
      userId = pending.id;
    } else {
      const cookiePayload = verifyToken(req.cookies?.token);
      if (!cookiePayload || cookiePayload.step) return res.status(401).json({ error: 'Unauthorized' });
      userId = cookiePayload.id;
    }
    const user = db.getUserById(userId);
    if (!user || !user.active) return res.status(401).json({ error: 'Unauthorized' });

    // Reuse an existing pending secret so the user's already-scanned QR stays valid.
    // Only generate a new one if none is stored yet.
    const secret = user.totp_secret || _generateSecret();
    if (!user.totp_secret) db.setUserTotpSecret(userId, secret);

    const label = encodeURIComponent(`Afcon (${user.username})`);
    const issuer = encodeURIComponent('Afcon');
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    // QR code is generated client-side (browser canvas via qrcodejs CDN)
    // Server only returns the raw values — no QR library needed here
    res.json({ ok: true, secret, otpauthUrl });
  } catch (e) {
    console.error('[totp/setup] error:', e.message, e.stack);
    if (!res.headersSent) res.status(500).json({ error: 'שגיאת שרת: ' + e.message });
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
  const valid = ['list', 'kanban', 'catalog', 'pricelist', 'warehouse', 'docpack', 'requisition', 'boq', 'budget', 'orders'];
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
  // Accept both field formats:
  //   landing.html sends: { name, email, phone, division, reason }
  //   (legacy/API) sends: { firstName, lastName, email, phone, roleTitle, division }
  let { firstName, lastName, email, phone, roleTitle, division, name, reason } = req.body;
  if (name && (!firstName || !lastName)) {
    const parts = String(name).trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName  = parts.slice(1).join(' ') || parts[0] || '';
  }
  if (!roleTitle && reason) roleTitle = String(reason).trim() || 'לא צוין';
  if (!roleTitle) roleTitle = 'לא צוין';

  // Validate required fields
  if (!firstName || !email || !division)
    return res.status(400).json({ error: 'נא למלא שם, אימייל ומחלקה' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
    return res.status(400).json({ error: 'כתובת מייל אינה תקינה' });
  if (phone && !/^[\d\s\-\+\(\)]{7,20}$/.test(String(phone).trim()))
    return res.status(400).json({ error: 'מספר טלפון אינו תקין' });
  if (String(firstName).length > 60 || String(lastName || '').length > 60)
    return res.status(400).json({ error: 'שם ארוך מדי' });

  const r = db.createUserRequest(
    String(firstName).trim(),
    String(lastName || '').trim(),
    String(email).trim().toLowerCase(),
    String(phone || '').trim(),
    String(roleTitle).trim(),
    String(division).trim()
  );
  const reqId = r.lastInsertRowid;
  const fullName = `${String(firstName).trim()} ${String(lastName || '').trim()}`.trim();

  // Send confirmation to requester (best-effort)
  await sendMail(
    String(email).trim(),
    'בקשתך התקבלה — מערכת ניהול פרויקטים',
    `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#1a2a4a">בקשתך התקבלה ✅</h2>
      <p>שלום ${fullName},</p>
      <p>קיבלנו את בקשתך לפתיחת משתמש במערכת ניהול הפרויקטים.</p>
      <p>הבקשה נמצאת בבדיקה — נחזור אליך בהקדם.</p>
      <br><p style="color:#64748b;font-size:.88em">מערכת ניהול פרויקטים</p>
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
      <br><p style="color:#64748b;font-size:.88em">מערכת ניהול פרויקטים</p>
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
    'עדכון בקשת הצטרפות',
    `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#1a2a4a">עדכון לגבי בקשתך</h2>
      <p>שלום ${fullName},</p>
      <p>לצערנו, בקשתך לפתיחת משתמש במערכת לא אושרה בשלב זה.</p>
      ${note ? `<p style="background:#f1f5f9;border-radius:8px;padding:10px 14px;color:#374151"><strong>הערת המנהל:</strong> ${note}</p>` : ''}
      <p>לשאלות, ניתן לפנות ישירות לאחראי המערכת.</p>
      <br><p style="color:#64748b;font-size:.88em">מערכת ניהול פרויקטים</p>
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
      source: it.source === 'warehouse' ? 'warehouse' : it.source === 'catalog' ? 'catalog' : 'pricelist',
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
      status: pack.status || 'draft',
      is_template: pack.is_template || 0,
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
  const { name, data, status } = req.body || {};
  const finalName = (name && typeof name === 'string' && name.trim()) ? name.trim() : pack.name;
  const VALID_STATUSES = ['draft','planning','execution','as-made','archived'];
  const finalStatus = (status && VALID_STATUSES.includes(status)) ? status : null;
  let dataJson = '{}';
  let dataObj = {};
  if (data && typeof data === 'object') {
    try { dataJson = JSON.stringify(data); dataObj = data; } catch { return res.status(400).json({ error: 'invalid data' }); }
  } else if (typeof data === 'string') {
    dataJson = data;
    try { dataObj = JSON.parse(data); } catch {}
  }
  db.updateDocPack(id, finalName, dataJson, finalStatus);

  // ── Sync linked datasheets to current equipment models ──────────────────────
  // When the user edits/removes equipment rows, auto-linked datasheet files for
  // removed/changed models must be cleaned up so stale PDFs don't appear in the
  // pack timeline or the generated ZIP.
  //
  // Strategy:
  //   1. Collect all model strings from cameras / backhauls / switches / others
  //   2. Resolve each model to a datasheet external_path (if found in the index)
  //   3. Delete any doc_pack_files row that is a linked datasheet (filename=NULL,
  //      external_path set) whose path is no longer in the current model set.
  //   4. Auto-attach missing datasheets for models that have one in the index.
  try {
    const allRows = [
      ...(dataObj.cameras   || []),
      ...(dataObj.backhauls || []),
      ...(dataObj.switches  || []),
      ...(dataObj.others    || []),
    ];
    // Set of external_paths that correspond to current equipment
    const wantedPaths = new Set();
    for (const row of allRows) {
      const model = String(row.model || row.mpn || row.name || '').trim();
      if (!model) continue;
      const ds = docpack.lookupDatasheet(model);
      if (ds) wantedPaths.add(ds.absPath);
    }

    // Remove linked datasheets whose model is no longer present
    const existingFiles = db.listDocPackFiles(id);
    for (const f of existingFiles) {
      if (f.filename !== null) continue;      // uploaded file, not a linked datasheet
      if (!f.external_path) continue;         // skip rows with no path
      if (!wantedPaths.has(f.external_path)) {
        db.deleteDocPackFile(f.id);           // stale — model was changed or removed
      }
    }

    // Auto-attach datasheets for models not yet in the pack
    const remainingPaths = new Set(
      db.listDocPackFiles(id)
        .filter(f => f.external_path)
        .map(f => f.external_path)
    );
    for (const row of allRows) {
      const model = String(row.model || row.mpn || row.name || '').trim();
      if (!model) continue;
      const ds = docpack.lookupDatasheet(model);
      if (!ds) continue;
      if (remainingPaths.has(ds.absPath)) continue; // already attached
      db.addDocPackFile({
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
      remainingPaths.add(ds.absPath); // prevent double-add for duplicate models
    }
  } catch (syncErr) {
    console.warn('[docpack] datasheet sync error:', syncErr.message);
    // Non-fatal — the pack data was saved successfully
  }

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

// ── Toggle is_template flag ──────────────────────────────────────────────────
app.patch('/api/docpacks/:id/template', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  const isTemplate = !!(req.body && req.body.is_template);
  db.setDocPackTemplate(id, isTemplate);
  db.logAudit(req.user.id, req.user.username, 'docpack_template_toggle',
    `Pack #${id} → is_template=${isTemplate ? 1 : 0}`, getClientIp(req), '');
  res.json({ ok: true, id, is_template: isTemplate ? 1 : 0 });
});

// ── Duplicate / save-as-template ────────────────────────────────────────────
// One endpoint, three behaviours selected by booleans in the body:
//   { strip:false, asTemplate:false, copyFiles:true  } → "שכפל" (full clone)
//   { strip:true,  asTemplate:true,  copyFiles:false } → "שמור כתבנית"
//   { strip:false, asTemplate:false, copyFiles:false } → "צור מתבנית" (from template)
// `strip` removes project-specific content; `copyFiles` physically copies the
// source pack's uploaded files (and re-links its datasheets).
app.post('/api/docpacks/:id/duplicate', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const src = db.getDocPack(id);
  if (!src) return res.status(404).json({ error: 'Pack not found' });

  const strip      = !!(req.body && req.body.strip);
  const asTemplate = !!(req.body && req.body.asTemplate);
  const copyFiles  = !!(req.body && req.body.copyFiles);

  let data = {};
  try { data = JSON.parse(src.data || '{}'); } catch { data = {}; }
  const outData = strip ? docparse.stripToTemplate(data) : data;

  const reqName = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
  const name = reqName || (asTemplate ? `${src.name} — תבנית` : `${src.name} (עותק)`);

  const r = db.createDocPack(name, src.type, JSON.stringify(outData),
    req.user.id, req.user.username, asTemplate ? 1 : 0);
  const newId = r.lastInsertRowid;

  let filesCopied = 0;
  if (copyFiles) {
    let usedBytes = 0;
    for (const f of db.listDocPackFiles(id)) {
      // Linked datasheet (no physical file) — just re-create the link row.
      if (!f.filename) {
        if (!f.external_path) continue;
        db.addDocPackFile({
          packId: newId, kind: f.kind, filename: null,
          originalName: f.original_name, mime: f.mime, size: f.size,
          caption: f.caption, note: f.note, visibility: f.visibility,
          contributor: req.user.username, sortOrder: f.sort_order,
          externalPath: f.external_path,
        });
        filesCopied++;
        continue;
      }
      const srcPath = docpack.fileDiskPath(id, f.filename);
      if (!fs.existsSync(srcPath)) continue;
      usedBytes += f.size || 0;
      if (usedBytes > PER_PACK_QUOTA_BYTES) break; // safety: don't blow the quota
      const ext = (f.filename.match(/\.([a-z0-9]{2,5})$/i) || [, 'bin'])[1].toLowerCase();
      const newName = `${uuidv4()}.${ext}`;
      try { fs.copyFileSync(srcPath, docpack.fileDiskPath(newId, newName)); }
      catch { continue; }
      db.addDocPackFile({
        packId: newId, kind: f.kind, filename: newName,
        originalName: f.original_name, mime: f.mime, size: f.size,
        caption: f.caption, note: f.note, visibility: f.visibility,
        contributor: req.user.username, sortOrder: f.sort_order,
      });
      filesCopied++;
    }
  }

  db.logAudit(req.user.id, req.user.username, 'docpack_duplicate',
    `Duplicated pack #${id} → #${newId} (${asTemplate ? 'template' : 'project'}${strip ? ', stripped' : ''}, ${filesCopied} files)`,
    getClientIp(req), '');
  res.json({ ok: true, id: newId, is_template: asTemplate ? 1 : 0, files_copied: filesCopied });
});

// ── Import + analyse an existing "תיק תיעוד" Word document ───────────────────
// Parses the uploaded .docx into a pack `data` object, creates a new pack (or
// template), keeps the source .docx attached as an internal reference file, and
// returns an analysis summary describing what was detected.
app.post('/api/docpacks/import', requireAdmin, docPackUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  req.file.originalname = fixUtf8Filename(req.file.originalname);
  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch {} };

  if (!/\.docx$/i.test(req.file.originalname)) {
    cleanup();
    return res.status(400).json({ error: 'נא להעלות קובץ Word בפורמט .docx' });
  }

  let parsed;
  try {
    const buf = fs.readFileSync(req.file.path);
    parsed = await docparse.parseDocxToPackData(buf, { geminiApiKey: process.env.GEMINI_API_KEY });
  } catch (e) {
    cleanup();
    return res.status(400).json({ error: 'ניתוח הקובץ נכשל: ' + e.message });
  }

  const asTemplate = !!(req.body && (req.body.asTemplate === '1' || req.body.asTemplate === 'true' || req.body.asTemplate === true));
  let data = parsed.data || {};
  if (asTemplate) data = docparse.stripToTemplate(data);

  const reqName = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
  const name = reqName || (!asTemplate && data.site_name) ||
    req.file.originalname.replace(/\.docx$/i, '').trim() || 'תיק מיובא';

  const r = db.createDocPack(name, 'cctv', JSON.stringify(data),
    req.user.id, req.user.username, asTemplate ? 1 : 0);
  const newId = r.lastInsertRowid;

  // Keep the original .docx as an internal reference file (provenance).
  try {
    const newName = `${uuidv4()}.docx`;
    fs.renameSync(req.file.path, docpack.fileDiskPath(newId, newName));
    db.addDocPackFile({
      packId: newId, kind: 'general', filename: newName,
      originalName: req.file.originalname, mime: req.file.mimetype, size: req.file.size,
      caption: 'מקור הייבוא', note: 'הקובץ המקורי שממנו יובא התיק',
      visibility: 'internal', contributor: req.user.username, sortOrder: 0,
    });
  } catch {
    cleanup();
  }

  db.logAudit(req.user.id, req.user.username, 'docpack_import',
    `Imported pack from "${req.file.originalname}" → #${newId} (${asTemplate ? 'template' : 'project'})`,
    getClientIp(req), '');
  res.json({ ok: true, id: newId, is_template: asTemplate ? 1 : 0, analysis: parsed.analysis });
});

// Catalog item file upload — saves to DS_PATH/catalog/ and returns a /ds/catalog/ URL.
// Stored on the server (not localStorage base64) so large PDFs don't get truncated.
app.post('/api/catalog/upload', requireAuth, docPackUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    req.file.originalname = fixUtf8Filename(req.file.originalname);
    // Optional target subfolder (e.g. manufacturer name); sanitized, defaults to 'catalog'
    const rawFolder = (req.body && req.body.folder) ? String(req.body.folder) : 'catalog';
    const folder = rawFolder.replace(/[^A-Za-z0-9 _.-]+/g, '_').replace(/\.\.+/g, '_').slice(0, 40) || 'catalog';
    const dir = path.join(DS_PATH, folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Keep a readable, collision-safe name: <original-base>__<short-uuid>.<ext>
    const orig = req.file.originalname || 'file';
    const extMatch = orig.match(/\.([a-z0-9]{2,5})$/i);
    const ext = (extMatch ? extMatch[1] : 'bin').toLowerCase();
    // Prefer a client-supplied base name (product model code); fall back to original filename
    const rawBase = (req.body && req.body.basename) ? String(req.body.basename) : orig.replace(/\.[^.]+$/, '');
    const base = (rawBase.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 60)) || 'file';
    const newName = `${base}__${uuidv4().slice(0, 8)}.${ext}`;
    const destPath = path.join(dir, newName);
    fs.renameSync(req.file.path, destPath);
    db.logAudit(req.user.id, req.user.username, 'catalog_file_upload', folder + '/' + newName, getClientIp(req), '');
    res.json({ ok: true, url: '/ds/' + encodeURIComponent(folder) + '/' + encodeURIComponent(newName),
               name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: e.message });
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

// Diagnostic: test PDF rendering on this server — renders 1 page from
// a known-good datasheet and reports success/failure + timing.
// GET /api/admin/test-pdf-render
app.get('/api/admin/test-pdf-render', requireAdmin, async (req, res) => {
  const os = require('os');
  const testModel = req.query.model || 'DS-1227ZJ';
  const ds = docpack.lookupDatasheet(testModel);
  if (!ds) return res.json({ ok: false, error: 'model not in index: ' + testModel });
  if (!fs.existsSync(ds.absPath)) return res.json({ ok: false, error: 'file missing: ' + ds.absPath });
  const tmpDir = path.join(os.tmpdir(), 'dp_test_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const t0 = Date.now();
  try {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(ds.absPath, { scale: 1.5 });
    let n = 0;
    for await (const buf of doc) {
      const p = path.join(tmpDir, `page_${++n}.png`);
      fs.writeFileSync(p, buf);
      if (n >= 1) break;
    }
    const elapsed = Date.now() - t0;
    // cleanup
    try { for (let i = 1; i <= n; i++) fs.unlinkSync(path.join(tmpDir, `page_${i}.png`)); fs.rmdirSync(tmpDir); } catch {}
    return res.json({ ok: true, model: testModel, pages: n, ms: elapsed, path: ds.absPath });
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    return res.json({ ok: false, error: e.message, model: testModel, path: ds.absPath });
  }
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

// Sync linked datasheets: remove stale ones, re-resolve broken paths, auto-attach missing.
// Also fixes external_path entries that point to a different machine/OS
// (e.g. C:\Mexico\ds\... stored from a dev machine, needs to become
// /opt/render/project/src/ds/... on the Render server).
app.post('/api/docpacks/:id/cleanup-datasheets', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const pack = db.getDocPack(id);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  let dataObj = {};
  try { dataObj = JSON.parse(pack.data || '{}'); } catch {}

  const allRows = [
    ...(dataObj.cameras   || []),
    ...(dataObj.backhauls || []),
    ...(dataObj.switches  || []),
    ...(dataObj.others    || []),
  ];

  // Build the set of current wanted external_paths (re-resolved via live index)
  const wantedByModel = new Map(); // model → ds
  const wantedPaths   = new Set();
  for (const row of allRows) {
    const model = String(row.model || row.mpn || row.name || '').trim();
    if (!model) continue;
    const ds = docpack.lookupDatasheet(model);
    if (ds) { wantedPaths.add(ds.absPath); wantedByModel.set(model, ds); }
  }

  const existingFiles = db.listDocPackFiles(id);
  let removed = 0, fixed = 0;

  for (const f of existingFiles) {
    if (f.filename !== null) continue;  // uploaded file — skip
    if (!f.external_path) continue;

    // ── Fix stale OS paths (e.g. Windows path on a Linux server) ──
    if (!fs.existsSync(f.external_path)) {
      const modelHint = (f.original_name || path.basename(f.external_path))
        .replace(/\.pdf$/i, '');
      const ds = modelHint ? docpack.lookupDatasheet(modelHint) : null;
      if (ds && fs.existsSync(ds.absPath)) {
        db.updateDocPackFileExternalPath(f.id, ds.absPath);
        fixed++;
        continue; // path fixed — keep the file
      }
    }

    // ── Remove datasheets no longer matching current equipment ──
    if (!wantedPaths.has(f.external_path)) {
      db.deleteDocPackFile(f.id);
      removed++;
    }
  }

  // ── Auto-attach missing datasheets for current equipment ──
  const currentPaths = new Set(
    db.listDocPackFiles(id).filter(f => f.external_path).map(f => f.external_path)
  );
  let added = 0;
  for (const ds of wantedByModel.values()) {
    if (currentPaths.has(ds.absPath)) continue;
    const model = [...wantedByModel.entries()].find(([,v])=>v===ds)?.[0] || ds.original;
    db.addDocPackFile({
      packId: id, kind: 'datasheet', filename: null,
      originalName: ds.original + '.pdf', mime: 'application/pdf',
      size: (() => { try { return fs.statSync(ds.absPath).size; } catch { return 0; } })(),
      caption: ds.mfr, note: `דף מוצר עבור ${model}`,
      visibility: 'client', contributor: req.user.username,
      sortOrder: Date.now() % 1_000_000, externalPath: ds.absPath,
    });
    currentPaths.add(ds.absPath);
    added++;
  }

  res.json({ ok: true, removed, fixed, added });
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

// ── Weather (Tel Aviv via open-meteo, no API key required) ───────────────────

let _weatherCache = null, _weatherFetchedAt = 0;

app.get('/api/weather', requireAuth, async (req, res) => {
  if (_weatherCache && Date.now() - _weatherFetchedAt < 15 * 60 * 1000) {
    return res.json(_weatherCache);
  }
  try {
    const r = await fetch(
      'https://api.open-meteo.com/v1/forecast' +
      '?latitude=32.0853&longitude=34.7818&current_weather=true&timezone=Asia%2FJerusalem'
    );
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const d = await r.json();
    _weatherCache = d;
    _weatherFetchedAt = Date.now();
    res.json(d);
  } catch (e) {
    console.error('[weather]', e.message);
    if (_weatherCache) return res.json(_weatherCache); // serve stale on error
    res.status(502).json({ error: 'weather unavailable' });
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

// ── External PDF proxy (for inline preview of remote datasheets) ─────────────
// Remote servers block iframe embedding (X-Frame-Options) and Google's viewer is
// unreliable. We fetch the PDF server-side and stream it same-origin so a normal
// iframe can render it. Guards: auth required, http(s) only, no private hosts,
// PDF content-type enforced, size capped.
const _PROXY_MAX_BYTES = 40 * 1024 * 1024; // 40MB
function _isPrivateHost(host) {
  const h = (host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  // IPv4 private / loopback / link-local ranges
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  if (h === '0.0.0.0' || h === '::1') return true;
  return false;
}
// ── Weather — proxy to Open-Meteo (no API key, Tel Aviv coords) ─────────────
// Caches for 10 min server-side so we don't hammer the free API.
let _wxCache = null, _wxCacheAt = 0;
app.get('/api/weather', requireAuth, async (req, res) => {
  const now = Date.now();
  if (_wxCache && now - _wxCacheAt < 10 * 60 * 1000) return res.json(_wxCache);
  try {
    const url = 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=32.0853&longitude=34.7818&current_weather=true&timezone=Asia%2FJerusalem';
    const data = await new Promise((resolve, reject) => {
      const req2 = require('https').get(url, { timeout: 8000 }, r => {
        let raw = '';
        r.on('data', c => raw += c);
        r.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('parse')); } });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
    });
    _wxCache = data;
    _wxCacheAt = now;
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'weather unavailable: ' + e.message });
  }
});

app.get('/api/ds-proxy', requireAuth, async (req, res) => {
  const raw = String(req.query.url || '');
  let u;
  try { u = new URL(raw); } catch { return res.status(400).send('bad url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).send('bad protocol');
  if (_isPrivateHost(u.hostname)) return res.status(403).send('forbidden host');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    // Browser-like headers help bypass basic bot walls that otherwise serve an HTML page
    const r = await fetch(u.href, { signal: ctrl.signal, redirect: 'follow', headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
      'Referer': u.origin + '/',
    } });
    clearTimeout(timer);
    const probe = req.query.probe === '1';
    if (!r.ok) {
      if (probe) return res.json({ pdf: false, reason: 'upstream ' + r.status });
      return res.status(502).send('upstream ' + r.status);
    }
    const len = parseInt(r.headers.get('content-length') || '0', 10);
    if (len && len > _PROXY_MAX_BYTES) {
      if (probe) return res.json({ pdf: false, reason: 'too large' });
      return res.status(413).send('too large');
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > _PROXY_MAX_BYTES) {
      if (probe) return res.json({ pdf: false, reason: 'too large' });
      return res.status(413).send('too large');
    }
    // Verify real PDF by magic bytes (%PDF) — many sites serve an HTML wall for .pdf URLs
    const isRealPdf = buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-';
    if (probe) return res.json({ pdf: isRealPdf });
    if (!isRealPdf) return res.status(415).send('not a pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (e) {
    res.status(502).send('proxy failed');
  }
});

// ── Static files (auth protected) ────────────────────────────────────────────

// Public landing page — authenticated users are redirected directly to dashboard
app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (verifyToken(token)) return res.redirect('/dashboard');
  res.sendFile(path.join(STATIC_DIR, 'landing.html'));
});

// Main dashboard — requires authentication
// no-store: prevents browser from serving a stale cached copy of the large HTML
app.get('/dashboard', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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

// ── BOQ (כתב כמויות) ──────────────────────────────────────────────────────────

const boq = require('./boq');
boq.seedSystemTemplates();

const boqUpload = multer({
  dest: path.join(__dirname, 'data', '_boq_staging'),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .xlsx files are allowed'));
  },
});

// Shared: fetch exchange rates for rollup (reuses the /api/rates cache in memory)
let _boqRatesCache = null, _boqRatesCacheAt = 0;
async function _getBoqRates() {
  if (_boqRatesCache && Date.now() - _boqRatesCacheAt < 55 * 60 * 1000) return _boqRatesCache;
  try {
    const res = await fetch('https://boi.org.il/PublicApi/GetExchangeRates?key=USD,EUR');
    const json = await res.json();
    const rates = {};
    for (const r of json?.result?.exchangeRates || []) {
      if (r.key === 'USD') rates.USD = r.currentExchangeRate;
      if (r.key === 'EUR') rates.EUR = r.currentExchangeRate;
    }
    _boqRatesCache = rates;
    _boqRatesCacheAt = Date.now();
    return rates;
  } catch { return { USD: 3.7, EUR: 4.1 }; }
}

// ── Templates ──

app.get('/api/boq/templates', requireSection('boq'), (_req, res) => {
  const templates = db.listBoqTemplates();
  res.json(templates.map(t => ({
    ...t,
    keywords:   JSON.parse(t.keywords_json   || '[]'),
    components: JSON.parse(t.components_json || '[]'),
  })));
});

app.post('/api/boq/templates', requireSection('boq'), (req, res) => {
  const { name, keywords, components } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.createBoqTemplate({
    name,
    keywordsJson:   JSON.stringify(keywords   || []),
    componentsJson: JSON.stringify(components || []),
    isSystem: false,
  });
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/boq/templates/:id', requireSection('boq'), (req, res) => {
  const { name, keywords, components } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.updateBoqTemplate(parseInt(req.params.id), {
    name,
    keywordsJson:   JSON.stringify(keywords   || []),
    componentsJson: JSON.stringify(components || []),
  });
  res.json({ ok: true });
});

app.delete('/api/boq/templates/:id', requireAdmin, (req, res) => {
  db.deleteBoqTemplate(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Projects ──

app.get('/api/boq/projects', requireSection('boq'), (_req, res) => {
  res.json(db.listBoqProjects());
});

app.post('/api/boq/projects', requireSection('boq'), (req, res) => {
  const { name, description, site, status, currency, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.createBoqProject({ name, description, site, status, currency, notes, createdBy: req.user.username });
  db.logAudit(req.user.id, req.user.username, 'boq_create_project', name, getClientIp(req), '');
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/boq/projects/:id', requireSection('boq'), (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const items = db.listBoqItems(project.id);
  const allComponents = db.listBoqComponentsByProject(project.id);
  const compsByItemId = {};
  for (const c of allComponents) (compsByItemId[c.item_id] = compsByItemId[c.item_id] || []).push(c);
  res.json({ project, items, componentsByItemId: compsByItemId });
});

app.put('/api/boq/projects/:id', requireSection('boq'), (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { name, description, site, status, currency, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.updateBoqProject(project.id, { name, description, site, status, currency, notes });
  res.json({ ok: true });
});

app.delete('/api/boq/projects/:id', requireAdmin, (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  db.deleteBoqProject(project.id);
  db.logAudit(req.user.id, req.user.username, 'boq_delete_project', project.name, getClientIp(req), '');
  res.json({ ok: true });
});

// ── Items ──

// Compare hierarchical item numbers like "1.20" vs "1.21" vs "2.0"
function _compareItemNums(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = String(a).split('.').map(s => parseFloat(s) || 0);
  const pb = String(b).split('.').map(s => parseFloat(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

app.post('/api/boq/projects/:id/items', requireSection('boq'), (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { description, itemNumber, parentNumber, unit, quantity, isRfq, isSection, notes } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });

  // Prevent duplicate item numbers within the same project
  if (itemNumber) {
    const existing = db.listBoqItems(project.id).find(i => i.item_number === itemNumber);
    if (existing) return res.status(409).json({ error: `מספר סעיף ${itemNumber} כבר קיים בפרויקט` });
  }

  let sortOrder;
  if (itemNumber) {
    // Insert at the correct chronological position based on item number
    const allItems = db.listBoqItems(project.id); // ordered by sort_order ASC
    let insertAfterSortOrder = -1;
    for (let i = 0; i < allItems.length; i++) {
      const existingNum = allItems[i].item_number;
      // Skip items without a number — only numbered items define the insertion point
      if (!existingNum) continue;
      if (_compareItemNums(existingNum, itemNumber) < 0) {
        insertAfterSortOrder = allItems[i].sort_order;
      }
    }
    sortOrder = insertAfterSortOrder + 1;
    // Always shift: make room at this exact sort_order position
    db.db.prepare('UPDATE boq_items SET sort_order = sort_order + 1 WHERE project_id = ? AND sort_order >= ?')
      .run(project.id, sortOrder);
  } else {
    sortOrder = db.countBoqItems(project.id);
  }

  const r = db.createBoqItem({ projectId: project.id, description, itemNumber, parentNumber, unit, quantity: quantity || 1, isRfq: !!isRfq, isSection: !!isSection, sortOrder, notes });
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/boq/items/:itemId', requireSection('boq'), (req, res) => {
  const item = db.getBoqItem(parseInt(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { description, itemNumber, parentNumber, unit, quantity, isRfq, rfqVendor, rfqNotes, rfqPriceIls, isSection, notes, contractUnitPrice } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  db.updateBoqItem(item.id, { description, itemNumber, parentNumber, unit, quantity, isRfq: !!isRfq, rfqVendor, rfqNotes, rfqPriceIls: rfqPriceIls != null ? parseFloat(rfqPriceIls) : null, isSection: !!isSection, notes });
  if (contractUnitPrice !== undefined) db.updateBoqItemContractPrice(item.id, contractUnitPrice != null ? parseFloat(contractUnitPrice) : null);
  res.json({ ok: true });
});

app.delete('/api/boq/items/:itemId/components', requireSection('boq'), (req, res) => {
  try {
    const item = db.getBoqItem(parseInt(req.params.itemId));
    if (!item) return res.status(404).json({ error: 'Not found' });
    db.deleteBoqComponentsByItem(item.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/boq/items/:itemId', requireSection('boq'), (req, res) => {
  const item = db.getBoqItem(parseInt(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.deleteBoqItem(item.id);
  res.json({ ok: true });
});

// Clear all items in a project (reset before re-import) — keeps the project record itself
app.delete('/api/boq/projects/:id/items', requireSection('boq'), (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  db.deleteAllBoqItemsByProject(project.id);
  db.logAudit(req.user.id, req.user.username, 'boq_clear_items', project.name, getClientIp(req), '');
  res.json({ ok: true });
});

app.post('/api/boq/projects/:id/items/reorder', requireSection('boq'), (req, res) => {
  const { pairs } = req.body; // [{id, sortOrder}]
  if (!Array.isArray(pairs)) return res.status(400).json({ error: 'pairs array required' });
  db.reorderBoqItems(pairs.map(p => ({ id: parseInt(p.id), sortOrder: parseInt(p.sortOrder) })));
  res.json({ ok: true });
});

app.patch('/api/boq/items/:itemId/contract-price', requireSection('boq'), (req, res) => {
  const item = db.getBoqItem(parseInt(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const raw = req.body.price;
  const price = raw === '' || raw == null ? null : parseFloat(raw);
  if (price !== null && isNaN(price)) return res.status(400).json({ error: 'price must be a number' });
  db.updateBoqItemContractPrice(item.id, price);
  res.json({ ok: true });
});

app.patch('/api/boq/items/:itemId/rfq-price', requireSection('boq'), (req, res) => {
  const item = db.getBoqItem(parseInt(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const price = parseFloat(req.body.priceIls);
  if (isNaN(price)) return res.status(400).json({ error: 'priceIls must be a number' });
  db.updateBoqItemRfqPrice(item.id, price);
  res.json({ ok: true });
});

// ── Components ──

app.post('/api/boq/items/:itemId/components', requireSection('boq'), (req, res) => {
  try {
    const item = db.getBoqItem(parseInt(req.params.itemId));
    if (!item) return res.status(404).json({ error: 'Not found' });
    const { componentKey, label, unitPrice, currency, quantity, quantityFormula } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    const existing = db.listBoqComponents(item.id);
    const r = db.createBoqComponent({ itemId: item.id, componentKey: componentKey || 'custom', label, unitPrice: parseFloat(unitPrice) || 0, currency: currency || 'ILS', quantity: parseFloat(quantity) || 1, quantityFormula: quantityFormula || null, sortOrder: existing.length });
    res.json({ id: r.lastInsertRowid });
  } catch(e) { console.error('[boq POST comp]', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/boq/components/:compId', requireSection('boq'), (req, res) => {
  try {
    const comp = db.db.prepare('SELECT * FROM boq_components WHERE id=?').get(parseInt(req.params.compId));
    if (!comp) return res.status(404).json({ error: 'Not found' });
    const { componentKey, label, unitPrice, currency, quantity, quantityFormula, sortOrder } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    db.updateBoqComponent(comp.id, { componentKey: componentKey || 'custom', label, unitPrice: parseFloat(unitPrice) || 0, currency: currency || 'ILS', quantity: parseFloat(quantity) || 1, quantityFormula: quantityFormula || null, sortOrder: sortOrder != null ? parseInt(sortOrder) : comp.sort_order });
    res.json({ ok: true });
  } catch(e) { console.error('[boq PUT comp]', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/boq/components/:compId', requireSection('boq'), (req, res) => {
  try {
    const comp = db.db.prepare('SELECT * FROM boq_components WHERE id=?').get(parseInt(req.params.compId));
    if (!comp) return res.status(404).json({ error: 'Not found' });
    db.deleteBoqComponent(comp.id);
    res.json({ ok: true });
  } catch(e) { console.error('[boq DELETE comp]', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/boq/items/:itemId/apply-template/:templateId', requireSection('boq'), (req, res) => {
  const item = db.getBoqItem(parseInt(req.params.itemId));
  const tmpl = db.getBoqTemplate(parseInt(req.params.templateId));
  if (!item || !tmpl) return res.status(404).json({ error: 'Not found' });
  db.deleteBoqComponentsByItem(item.id);
  db.updateBoqItemTemplate(item.id, tmpl.id);
  let comps;
  try { comps = JSON.parse(tmpl.components_json || '[]'); } catch { comps = []; }
  let i = 0;
  for (const c of comps) {
    db.createBoqComponent({ itemId: item.id, componentKey: c.key || 'custom', label: c.label, unitPrice: c.unitPrice || 0, currency: c.currency || 'ILS', quantity: c.quantity || 1, quantityFormula: c.formula || null, sortOrder: i++ });
  }
  res.json({ ok: true, applied: comps.length });
});

// Link a template to an item WITHOUT replacing its components
app.put('/api/boq/items/:itemId/link-template/:templateId', requireSection('boq'), (req, res) => {
  const item = db.getBoqItem(parseInt(req.params.itemId));
  const tmpl = db.getBoqTemplate(parseInt(req.params.templateId));
  if (!item || !tmpl) return res.status(404).json({ error: 'Not found' });
  db.updateBoqItemTemplate(item.id, tmpl.id);
  res.json({ ok: true });
});

// Sync current item component prices back to the template
app.post('/api/boq/templates/:id/sync-prices', requireSection('boq'), (req, res) => {
  const tmpl = db.getBoqTemplate(parseInt(req.params.id));
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const item = db.getBoqItem(parseInt(itemId));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const liveComps = db.listBoqComponents(item.id);
  let tmplComps;
  try { tmplComps = JSON.parse(tmpl.components_json || '[]'); } catch { tmplComps = []; }
  // Merge: update unitPrice for matching keys; append new keys
  const byKey = {};
  for (const tc of tmplComps) byKey[tc.key] = tc;
  for (const lc of liveComps) {
    if (byKey[lc.component_key]) {
      byKey[lc.component_key].unitPrice = lc.unit_price;
    } else {
      tmplComps.push({ key: lc.component_key, label: lc.label, unitPrice: lc.unit_price, currency: lc.currency, quantity: lc.quantity, formula: lc.quantity_formula || null, sort: lc.sort_order });
    }
  }
  db.updateBoqTemplate(tmpl.id, { name: tmpl.name, keywordsJson: tmpl.keywords_json, componentsJson: JSON.stringify(tmplComps) });
  res.json({ ok: true, syncedCount: liveComps.length });
});

// ── Import ──

app.post('/api/boq/projects/:id/import/xlsx', requireSection('boq'), boqUpload.single('file'), async (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ip = getClientIp(req);
  try {
    const buf = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    const { items: parsedItems, warnings, colMapDebug } = await boq.parseXlsx(buf);
    let inserted = 0;
    const tx = db.db.transaction(() => {
      let sortOrder = db.countBoqItems(project.id);
      for (const pi of parsedItems) {
        db.createBoqItem({ projectId: project.id, itemNumber: pi.itemNumber, parentNumber: pi.parentNumber, description: pi.description, unit: pi.unit, quantity: pi.quantity || 1, isRfq: pi.isRfq, isSection: pi.isSection, sortOrder: sortOrder++, templateId: null, contractUnitPrice: pi.contractUnitPrice ?? null });
        inserted++;
      }
    });
    tx();
    db.logAudit(req.user.id, req.user.username, 'boq_import_xlsx', `Project ${project.id}: ${inserted} items`, ip, '');
    res.json({ ok: true, insertedCount: inserted, warnings, colMapDebug });
  } catch (e) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    console.error('[boq] xlsx import error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/boq/projects/:id/import/csv', requireSection('boq'), async (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv required' });
  const { items: parsedItems, warnings } = boq.parseCsv(csv);
  let inserted = 0;
  const tx = db.db.transaction(() => {
    let sortOrder = db.countBoqItems(project.id);
    for (const pi of parsedItems) {
      db.createBoqItem({ projectId: project.id, itemNumber: pi.itemNumber, parentNumber: pi.parentNumber, description: pi.description, unit: pi.unit, quantity: pi.quantity || 1, isRfq: pi.isRfq, isSection: false, sortOrder: sortOrder++, templateId: null, contractUnitPrice: pi.contractUnitPrice ?? null });
      inserted++;
    }
  });
  tx();
  res.json({ ok: true, insertedCount: inserted, warnings });
});

app.post('/api/boq/projects/:id/import/rows', requireSection('boq'), (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
  let inserted = 0;
  const tx = db.db.transaction(() => {
    let sortOrder = db.countBoqItems(project.id);
    for (const row of rows) {
      if (!row.description) continue;
      const match = boq.matchTemplate(row.description);
      const r = db.createBoqItem({ projectId: project.id, itemNumber: row.itemNumber || null, parentNumber: row.parentNumber || null, description: row.description, unit: row.unit || null, quantity: row.quantity || 1, isRfq: !!row.isRfq, isSection: !!row.isSection, sortOrder: sortOrder++, templateId: match?.template?.id || null, contractUnitPrice: row.contractUnitPrice ?? null });
      if (match && !row.isSection) {
        let tmplComps;
        try { tmplComps = JSON.parse(match.template.components_json || '[]'); } catch { tmplComps = []; }
        let ci = 0;
        for (const c of tmplComps) db.createBoqComponent({ itemId: r.lastInsertRowid, componentKey: c.key || 'custom', label: c.label, unitPrice: c.unitPrice || 0, currency: c.currency || 'ILS', quantity: c.quantity || 1, sortOrder: ci++ });
      }
      inserted++;
    }
  });
  tx();
  res.json({ ok: true, insertedCount: inserted });
});

// ── Summary & Export ──

app.get('/api/boq/projects/:id/summary', requireSection('boq'), async (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const items = db.listBoqItems(project.id);
  const allComponents = db.listBoqComponentsByProject(project.id);
  const rates = await _getBoqRates();
  const rollup = boq.rollupProject(items, allComponents, rates);
  res.json({ ...rollup, rates });
});

app.get('/api/boq/projects/:id/export/xlsx', requireSection('boq'), async (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const items = db.listBoqItems(project.id);
  const allComponents = db.listBoqComponentsByProject(project.id);
  const rates = await _getBoqRates();
  try {
    const buf = await boq.exportXlsx(project, items, allComponents, rates);
    const filename = encodeURIComponent(`BOQ-${project.name}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (e) {
    console.error('[boq] xlsx export error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/boq/projects/:id/export/pdf', requireSection('boq'), async (req, res) => {
  const project = db.getBoqProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const items = db.listBoqItems(project.id);
  const allComponents = db.listBoqComponentsByProject(project.id);
  const rates = await _getBoqRates();
  try {
    const buf = await boq.exportPdf(project, items, allComponents, rates);
    const filename = encodeURIComponent(`BOQ-${project.name}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (e) {
    console.error('[boq] pdf export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Budget Control (בקרה תקציבית) ─────────────────────────────────────────────

const budget = require('./budget');

const budgetUpload = multer({
  dest: path.join(__dirname, 'data', '_budget_staging'),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .xlsx files are allowed'));
  },
});

app.get('/api/budget/projects', requireSection('budget'), (_req, res) => {
  const projects = db.listBudgetProjects();
  const result = projects.map(p => {
    const items  = db.listBudgetItems(p.id);
    const rollup = budget.rollupBudget(items);
    return { ...p, itemCount: items.length, rollup };
  });
  res.json(result);
});

app.post('/api/budget/projects', requireSection('budget'), (req, res) => {
  const { name, site, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = db.createBudgetProject({ name, site, notes, createdBy: req.user.username });
  res.json(db.getBudgetProject(r.lastInsertRowid));
});

app.get('/api/budget/projects/:id', requireSection('budget'), (req, res) => {
  const id = parseInt(req.params.id);
  const proj = db.getBudgetProject(id);
  if (!proj) return res.status(404).json({ error: 'Not found' });
  const items  = db.listBudgetItems(id);
  const rollup = budget.rollupBudget(items);
  res.json({ ...proj, items, rollup });
});

app.put('/api/budget/projects/:id', requireSection('budget'), (req, res) => {
  const id = parseInt(req.params.id);
  const proj = db.getBudgetProject(id);
  if (!proj) return res.status(404).json({ error: 'Not found' });
  const { name, site, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  db.updateBudgetProject(id, { name, site, notes });
  res.json(db.getBudgetProject(id));
});

app.delete('/api/budget/projects/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const proj = db.getBudgetProject(id);
  if (!proj) return res.status(404).json({ error: 'Not found' });
  db.deleteBudgetProject(id);
  db.logAudit(req.user.id, req.user.username, 'budget_delete_project', proj.name, getClientIp(req), '');
  res.json({ ok: true });
});

app.post('/api/budget/projects/:id/import/xlsx', requireSection('budget'), budgetUpload.single('file'), async (req, res) => {
  const id   = parseInt(req.params.id);
  const proj = db.getBudgetProject(id);
  if (!proj) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const buf = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    const { items: parsed, warnings } = await budget.parseBudgetXlsx(buf);
    if (!parsed.length) return res.status(422).json({ error: warnings.join('; ') || 'No items found' });

    // Replace existing items
    db.deleteBudgetItemsByProject(id);
    for (let i = 0; i < parsed.length; i++) {
      db.createBudgetItem({ ...parsed[i], projectId: id, sortOrder: i });
    }
    db.logAudit(req.user.id, req.user.username, 'budget_import', `Project ${id}: ${parsed.length} items`, getClientIp(req), '');
    res.json({ insertedCount: parsed.length, warnings });
  } catch (e) {
    console.error('[budget] import error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/budget/projects/:id/items', requireSection('budget'), (req, res) => {
  const id = parseInt(req.params.id);
  db.deleteBudgetItemsByProject(id);
  res.json({ ok: true });
});

app.put('/api/budget/items/:itemId', requireSection('budget'), (req, res) => {
  const id   = parseInt(req.params.itemId);
  const item = db.db.prepare('SELECT * FROM budget_items WHERE id=?').get(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.updateBudgetItem(id, req.body);
  res.json(db.db.prepare('SELECT * FROM budget_items WHERE id=?').get(id));
});

app.delete('/api/budget/items/:itemId', requireSection('budget'), (req, res) => {
  const id   = parseInt(req.params.itemId);
  const item = db.db.prepare('SELECT * FROM budget_items WHERE id=?').get(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.deleteBudgetItem(id);
  res.json({ ok: true });
});

app.get('/api/budget/projects/:id/export/xlsx', requireSection('budget'), async (req, res) => {
  const id   = parseInt(req.params.id);
  const proj = db.getBudgetProject(id);
  if (!proj) return res.status(404).json({ error: 'Not found' });
  const items = db.listBudgetItems(id);
  try {
    const buf      = await budget.exportBudgetXlsx(proj, items);
    const filename = encodeURIComponent(`Budget-${proj.name}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (e) {
    console.error('[budget] export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Public: logo served without auth (needed on landing page before login)
app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'logo.png'));
});

// Public: design preview files (no auth needed — static mockups only)
app.get('/preview/:file', (req, res) => {
  const name = path.basename(req.params.file);
  if (!name.endsWith('.html')) return res.status(403).send('Forbidden');
  const filePath = path.join(STATIC_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ══════════════════════════════════════════════════════════════════════════════
// ── ORDERS (הזמנות נכנסות) ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const ORDER_STORAGE_DIR  = path.join(__dirname, 'data', 'orders');
const INVOICE_STORAGE_DIR = path.join(__dirname, 'data', 'invoices');
[ORDER_STORAGE_DIR, INVOICE_STORAGE_DIR,
 path.join(__dirname, 'data', '_order_staging'),
 path.join(__dirname, 'data', '_invoice_staging')
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const orderUpload = multer({
  dest: path.join(__dirname, 'data', '_order_staging'),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.pdf$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('יש להעלות קובץ PDF בלבד'));
  }
});
const invoiceUpload = multer({
  dest: path.join(__dirname, 'data', '_invoice_staging'),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(pdf|jpe?g|png)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('יש להעלות PDF או תמונה'));
  }
});

const EXTRACT_PROMPT = `אתה מנתח הזמנות רכש ישראליות. חלץ את השדות הבאים וחזור JSON בלבד ללא markdown:
{
  "order_number": "מספר ההזמנה",
  "order_date": "YYYY-MM-DD או null",
  "ordering_entity": "שם הגורם המזמין / הרשות / החברה",
  "description": "תיאור קצר של מה שהוזמן (עד 200 תווים)",
  "amount_pre_vat": 12345.67,
  "currency": "ILS"
}
אם שדה לא נמצא — החזר null עבורו. הסכום חייב להיות מספר (לא מחרוזת).`;


// ── Helper: parse line items from the work items section ─────────────────────


function parseOrderItems(rawText) {
  // Remove PUA chars, normalise inline whitespace (keep newlines for line splitting)
  const text = rawText.replace(/[-]/g, '').replace(/[ \t]+/g, ' ');

  const items = [];

  const SEC_HEADER = 'רשימת פריטי העבודה';
  const secStart = text.indexOf(SEC_HEADER);
  if (secStart === -1) return items;

  // Take the whole remaining text from section start — end is detected while parsing
  const lines = text.slice(secStart).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) console.log('[parse-debug] first 3 lines:', JSON.stringify(lines.slice(0,3)));

  // Unit words that appear between qty and description in RTL column order
  const UNIT_RE = /^(קומפלט|יח\.|חודש|שנה|סט)[ \t]*/u;

  let current   = null;
  let extra     = [];
  let seenItems = false; // true once the first real item line is processed

  const saveItem = () => {
    if (!current) return;
    if (extra.length)
      current.description = (current.description + ' ' + extra.join(' ')).trim().slice(0, 300);
    if (current.total > 0) items.push(current);
    current = null;
    extra   = [];
  };

  for (const line of lines) {
    // ── Non-amount line ────────────────────────────────────────────────────────
    if (!/^[\d,]+\.\d{2}/.test(line)) {
      // Stop once items have started and we see a totals-section marker
      if (seenItems && /סה.{0,3}כ/.test(line)) { saveItem(); break; }

      // Append as description continuation (skip totals text)
      if (current &&
          /[א-ת]/.test(line) &&
          !/^\d+$/.test(line) &&
          !/סה.{0,3}כ/.test(line))
        extra.push(line);
      continue;
    }

    // ── Amount line: extract all leading numbers ───────────────────────────────
    let r = line;
    const nums = [];
    let m;
    while ((m = r.match(/^([\d,]+\.\d{2})/))) {
      nums.push(parseFloat(m[1].replace(/,/g, '')));
      r = r.slice(m[1].length);
    }

    // Skip single-amount summary lines and zero-total lines
    if (nums.length < 2 || nums[0] === 0) continue;

    // Stop if the text after the amounts contains a totals marker
    if (/סה.{0,3}כ/.test(r)) { saveItem(); break; }

    // ── Qty: in RTL layout the LAST extracted number is qty ───────────────────
    let qty = 1;
    if (nums.length >= 3) {
      qty = nums.pop();           // [total, pre_disc, unit_price, qty] → pop qty
    } else if (nums.length === 2 && nums[0] !== nums[1]) {
      const implied = nums[0] / nums[1];
      if (Number.isInteger(implied) && implied >= 1 && implied <= 999) qty = implied;
    }

    const total      = nums[0];
    const unit_price = nums.length > 1 && nums[nums.length - 1] !== nums[0]
                         ? nums[nums.length - 1] : null;

    // ── Unit word ──────────────────────────────────────────────────────────────
    let unit = '';
    const unitM = r.match(UNIT_RE);
    if (unitM) { unit = unitM[1].trim(); r = r.slice(unitM[0].length); }

    // ── Description cleanup ────────────────────────────────────────────────────
    let desc = r
      .replace(/\d+\.\d+סעיף\s*/gu, '')   // strip "15.3סעיף" section codes
      .replace(/\s+\d+\s*$/, '')            // strip trailing item number
      .trim();

    // Fix RTL extraction artifacts:
    // 1. Leading "5%" (or any NN%) before Hebrew → move to end
    //    e.g. "5%הוצאה בלתי מתוכננת" → "הוצאה בלתי מתוכננת 5%"
    const leadPct = desc.match(/^(\d+%)\s*/);
    if (leadPct && /[א-ת]/.test(desc.slice(leadPct[0].length))) {
      desc = desc.slice(leadPct[0].length).trim() + ' ' + leadPct[1];
    }
    // 2. Isolated lone digit sandwiched between Hebrew words → remove
    //    e.g. "כל שנה 2 נוספת" → "כל שנה נוספת"
    desc = desc.replace(/([א-ת])\s+\d{1,2}\s+([א-ת])/gu, '$1 $2');

    saveItem();
    seenItems = true;
    current   = { description: desc, qty, unit: unit || null, total, unit_price };
  }
  saveItem();
  return items;
}


async function extractOrderFromPdf(buffer) {
  let rawText = '';
  try {
    const pdfData = await pdfParse(buffer);
    rawText = (pdfData.text || '').trim();
  } catch (e) {
    console.warn('[extractOrderFromPdf] pdf-parse error:', e.message);
  }

  if (rawText.length < 80) {
    return { order_number: null, order_date: null, ordering_entity: null,
             description: null, amount_pre_vat: null, currency: 'ILS', items: [] };
  }

  // Clean text: remove PUA chars, collapse whitespace (no newlines)
  const flat = rawText.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ');
  // Clean text preserving newlines (for description extraction)
  const cleanText = rawText.replace(/[\uE000-\uF8FF]/g, '');

  // ── Order number ──────────────────────────────────────────────────────
  let order_number = null;
  const onMatch =
    flat.match(/\u05D4\u05D6\u05DE\u05E0\u05EA \u05E2\u05D1\u05D5\u05D3\u05D4 \u05DE\u05E1'? ?(\d+)/) ||
    flat.match(/\u05DE\u05E1' \u05D4\u05D6\u05DE\u05E0\u05D4 (\d+)/i) ||
    flat.match(/purchase order #? ?([\d\-\/]+)/i) ||
    flat.match(/order (?:no|number|#) ?:? ?([\d\-\/]+)/i);
  if (onMatch) order_number = onMatch[1].trim();

  // ── Date (Israeli DD/MM/YYYY → stored as YYYY-MM-DD) ─────────────────
  let order_date = null;
  const dateMatch =
    flat.match(/\u05EA\u05D0\u05E8\u05D9\u05DA \u05E4\u05EA\u05D9\u05D7\u05EA \u05D4\S+:? ?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/) ||
    flat.match(/\u05EA\u05D0\u05E8\u05D9\u05DA[^:]*: ?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/) ||
    flat.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (dateMatch) {
    const parts = dateMatch[1].split(/[\/\-\.]/);
    if (parts.length === 3) {
      let [d, mo, y] = parts;
      if (y.length === 2) y = '20' + y;
      if (parseInt(y) > 1900 && parseInt(y) < 2100)
        order_date = String(y) + '-' + String(mo).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    }
  }

  // ── Ordering entity ───────────────────────────────────────────────────
  let ordering_entity = null;
  const entityMatch =
    flat.match(/(\u05E2\u05D9\u05E8\u05D9\u05D9\u05EA [^\d,]{3,35})/) ||
    flat.match(/(\u05DE\u05D5\u05E2\u05E6\u05D4 [^\d,]{3,35})/) ||
    flat.match(/(?:\u05DC\u05DB\u05D1\u05D5\u05D3 )([^\n\r,]{3,50})/);
  if (entityMatch) {
    ordering_entity = entityMatch[1].trim()
      .replace(/\s+(?:\u05D8\u05DC\u05E4\u05D5\u05DF|\u05E4\u05E7\u05E1|\u05DE\u05E1'|\u05DB\u05EA\u05D5\u05D1\u05EA).*$/i, '')
      .replace(/\s+/g, ' ').trim().slice(0, 60);
  } else {
    const ls = flat.split(' ');
    const cand = ls.find(w => /[\u05D0-\u05EA]{4,}/.test(w));
    if (cand) ordering_entity = cand.slice(0, 60);
  }

  // ── Amount pre-VAT ────────────────────────────────────────────────────
  let amount_pre_vat = null;
  // Match "סה"כ לפני מע"מ 160,402.20" in various quote styles
  const amtMatch =
    flat.match(/\u05E1\u05D4.{0,5}\u05DB.{0,15}\u05DE\u05E2.{0,5}\u05DE\s*([\d,]+\.\d{2})/) ||
    flat.match(/(?:subtotal|net amount)\s*([\d,]+\.\d{2})/i);
  if (amtMatch) {
    const num = parseFloat(amtMatch[1].replace(/,/g, ''));
    if (!isNaN(num) && num > 0) amount_pre_vat = num;
  }

  // תיאור from תאור: שדה
  // In RTL-extracted PDFs the label can appear reversed as "ור:" — match both.
  let description = null;
  {
    // cleanText preserves newlines so [^\n] correctly stops at line boundary
    const vorPat = new RegExp("\u05D5\u05E8:\\s*([^\n\r]{3,180})");
    const taorPat = new RegExp("\u05EA\u05D0\u05D5\u05E8\\s*:\\s*([^\n\r]{3,180})");
    const descMatch = cleanText.match(vorPat) || cleanText.match(taorPat);
    if (descMatch) {
      description = descMatch[1]
        .replace(new RegExp("\u05EA\u05D0\\s*$"), "")   // strip stray תא artifact
        .replace(/\s+/g, " ").trim().slice(0, 180);
    }
  }

    // ── Line items ─────────────────────────────────────────────────────────
  const items = parseOrderItems(rawText);

  return { order_number, order_date, ordering_entity, description, amount_pre_vat, currency: 'ILS', items };
}

// ── Cities ───────────────────────────────────────────────────────────────────
app.get('/api/orders/cities', requireSection('orders'), (req, res) => {
  const cities = db.listOrderCities();
  // Attach project counts
  res.json(cities.map(c => ({
    ...c,
    projects: db.listOrderProjects(c.id)
  })));
});

app.post('/api/orders/cities', requireSection('orders'), (req, res) => {
  const { name, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'שם עיר נדרש' });
  try {
    const r = db.createOrderCity(name.trim(), notes);
    res.json({ id: r.lastInsertRowid, name: name.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'עיר עם שם זה כבר קיימת' });
    throw e;
  }
});

app.delete('/api/orders/cities/:id', requireSection('orders'), (req, res) => {
  db.deleteOrderCity(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Projects ─────────────────────────────────────────────────────────────────
app.post('/api/orders/cities/:cityId/projects', requireSection('orders'), (req, res) => {
  const cityId = parseInt(req.params.cityId);
  const { name, client, contractNumber, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'שם פרויקט נדרש' });
  const r = db.createOrderProject({ cityId, name: name.trim(), client, contractNumber, notes, createdBy: req.user.username });
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/orders/projects/:id', requireSection('orders'), (req, res) => {
  const { name, client, contractNumber, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'שם פרויקט נדרש' });
  db.updateOrderProject(parseInt(req.params.id), { name, client, contractNumber, notes });
  res.json({ ok: true });
});

app.delete('/api/orders/projects/:id', requireSection('orders'), (req, res) => {
  db.deleteOrderProject(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Orders ───────────────────────────────────────────────────────────────────
app.get('/api/orders/projects/:id', requireSection('orders'), (req, res) => {
  const project = db.getOrderProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const orders = db.listOrders(project.id);
  res.json({ project, orders });
});

// Upload PDF → extract with Claude → return extracted data (not yet saved)
app.post('/api/orders/projects/:id/upload', requireSection('orders'),
  orderUpload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'קובץ PDF נדרש' });
    const stagingPath = req.file.path;
    try {
      // No API key check needed — extraction is fully local
      const buffer = fs.readFileSync(stagingPath);
      const extracted = await extractOrderFromPdf(buffer);

      // Move to permanent storage
      const ext = '.pdf';
      const storedName = uuidv4() + ext;
      const destPath = path.join(ORDER_STORAGE_DIR, storedName);
      fs.renameSync(stagingPath, destPath);

      // Convert ISO date → DD/MM/YYYY for display in the confirm modal
      if (extracted.order_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.order_date)) {
        const [y, mo, d] = extracted.order_date.split('-');
        extracted.order_date_display = `${d}/${mo}/${y}`;
      } else {
        extracted.order_date_display = extracted.order_date || '';
      }

      res.json({
        extracted,
        tempFile: { storedName, originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8') }
      });
    } catch (e) {
      try { fs.unlinkSync(stagingPath); } catch (_) {}
      console.error('[orders/upload]', e);
      res.status(500).json({ error: 'שגיאה בניתוח ה-PDF: ' + e.message });
    }
  }
);

// Confirm & save order after user reviews extracted data
app.post('/api/orders/projects/:id/confirm', requireSection('orders'), (req, res) => {
  const project = db.getOrderProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { orderNumber, orderDate, orderingEntity, description, amountPreVat,
          currency, notes, pdfStoredName, pdfOriginalName, rawExtracted, items } = req.body;
  const pdfPath = pdfStoredName ? path.join(ORDER_STORAGE_DIR, pdfStoredName) : null;
  const r = db.createOrder({
    projectId: project.id, orderNumber, orderDate, orderingEntity,
    description, amountPreVat: amountPreVat != null ? parseFloat(amountPreVat) : null,
    currency: currency || 'ILS',
    pdfPath: pdfPath ? pdfPath : null,
    pdfOriginalName: pdfOriginalName || null,
    notes: notes || null,
    rawExtracted: rawExtracted ? JSON.stringify(rawExtracted) : null,
    itemsJson: items ? JSON.stringify(items) : '[]'
  });
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/orders/:id', requireSection('orders'), (req, res) => {
  const order = db.getOrder(parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { orderNumber, orderDate, orderingEntity, description, amountPreVat,
          isInvoiced, invoiceDate, invoiceNumber, notes } = req.body;
  db.updateOrder(order.id, { orderNumber, orderDate, orderingEntity, description,
    amountPreVat: amountPreVat != null ? parseFloat(amountPreVat) : null,
    isInvoiced: !!isInvoiced, invoiceDate, invoiceNumber, notes });
  res.json({ ok: true });
});

app.delete('/api/orders/:id', requireSection('orders'), (req, res) => {
  const order = db.getOrder(parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Not found' });
  // Delete physical PDF if exists
  if (order.pdf_path && fs.existsSync(order.pdf_path)) {
    try { fs.unlinkSync(order.pdf_path); } catch (_) {}
  }
  if (order.invoice_file_path && fs.existsSync(order.invoice_file_path)) {
    try { fs.unlinkSync(order.invoice_file_path); } catch (_) {}
  }
  db.deleteOrder(order.id);
  res.json({ ok: true });
});

// Attach invoice to order
app.post('/api/orders/:id/invoice', requireSection('orders'),
  invoiceUpload.single('file'),
  (req, res) => {
    const order = db.getOrder(parseInt(req.params.id));
    if (!order) { try { fs.unlinkSync(req.file?.path); } catch (_) {} return res.status(404).json({ error: 'Not found' }); }
    const { invoiceNumber, invoiceDate } = req.body;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const storedName = uuidv4() + ext;
    const destPath = path.join(INVOICE_STORAGE_DIR, storedName);
    fs.renameSync(req.file.path, destPath);
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    db.updateOrderInvoice(order.id, {
      invoiceFilePath: destPath,
      invoiceOriginalName: originalName,
      invoiceDate: invoiceDate || null,
      invoiceNumber: invoiceNumber || null
    });
    res.json({ ok: true, originalName });
  }
);

// Serve order PDF
app.get('/api/orders/:id/pdf', requireSection('orders'), (req, res) => {
  const order = db.getOrder(parseInt(req.params.id));
  if (!order || !order.pdf_path) return res.status(404).send('Not found');
  if (!fs.existsSync(order.pdf_path)) return res.status(404).send('File not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(order.pdf_original_name || 'order.pdf')}"`);
  fs.createReadStream(order.pdf_path).pipe(res);
});

// Export orders to Excel
app.get('/api/orders/projects/:id/export/xlsx', requireSection('orders'), async (req, res) => {
  const project = db.getOrderProject(parseInt(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const orders = db.listOrders(project.id);
  const city = db.getOrderCity(project.city_id);

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('הזמנות', { views: [{ rightToLeft: true }] });

  ws.columns = [
    { header: 'מס׳', key: 'idx',     width: 6  },
    { header: 'מס׳ הזמנה',  key: 'order_number',    width: 18 },
    { header: 'תאריך',      key: 'order_date',       width: 13 },
    { header: 'גורם מזמין', key: 'ordering_entity',  width: 28 },
    { header: 'תיאור',      key: 'description',      width: 40 },
    { header: 'סכום לפני מעמ', key: 'amount_pre_vat', width: 16 },
    { header: 'חויבה',      key: 'is_invoiced',      width: 10 },
    { header: 'מס׳ חשבונית', key: 'invoice_number',  width: 18 },
    { header: 'תאריך חשבונית', key: 'invoice_date',  width: 15 },
    { header: 'הערות',      key: 'notes',            width: 30 },
  ];

  // Header row style
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  // Title row above headers
  ws.spliceRows(1, 0, [`הזמנות — ${city?.name || ''} / ${project.name}`]);
  ws.mergeCells('A1:J1');
  const titleCell = ws.getCell('A1');
  titleCell.font = { bold: true, size: 13 };
  titleCell.alignment = { horizontal: 'center' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFe8f0fe' } };

  let totalAmount = 0;
  orders.forEach((o, i) => {
    const row = ws.addRow({
      idx: i + 1,
      order_number: o.order_number || '',
      order_date: o.order_date || '',
      ordering_entity: o.ordering_entity || '',
      description: o.description || '',
      amount_pre_vat: o.amount_pre_vat != null ? o.amount_pre_vat : '',
      is_invoiced: o.is_invoiced ? 'כן' : 'לא',
      invoice_number: o.invoice_number || '',
      invoice_date: o.invoice_date || '',
      notes: o.notes || ''
    });
    if (o.amount_pre_vat) totalAmount += o.amount_pre_vat;
    // Stripe rows
    if (i % 2 === 1) {
      row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf8faff' } }; });
    }
    // Color invoiced
    const invCell = row.getCell('is_invoiced');
    invCell.font = { color: { argb: o.is_invoiced ? 'FF15803d' : 'FFc53030' } };
  });

  // Totals row
  const totalRow = ws.addRow({ idx: '', order_number: 'סה"כ', amount_pre_vat: totalAmount });
  totalRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${project.id}.xlsx"`);
  res.send(buf);
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
