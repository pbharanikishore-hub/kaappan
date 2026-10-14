require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('Set SESSION_SECRET in .env to a random value of at least 32 characters.');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false })); // Tailwind CDN requires inline scripts/styles; tighten CSP before production.
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'kaappan_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'kaappan_db',
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 24 * 60 * 60 * 1000
});

app.use(session({
  name: 'kaappan.sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const sosLimiter = rateLimit({ windowMs: 60 * 1000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false });
const deliveryTestLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 1, standardHeaders: 'draft-7', legacyHeaders: false });

function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in again.' });
  next();
}
function cleanString(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validPhone(phone) { return /^\+?[0-9\s()\-]{7,20}$/.test(phone); }
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, phone: user.phone }; }

async function sendSms(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_SMS_FROM) {
    return { status: 'not_configured', message: 'SMS provider credentials missing' };
  }
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const result = await client.messages.create({ from: process.env.TWILIO_SMS_FROM, to, body });
    return { status: 'accepted_by_provider', providerId: result.sid };
  } catch (err) {
    console.error('SMS provider error:', err.message);
    return { status: 'failed', message: 'SMS provider rejected the request' };
  }
}

async function sendWhatsApp(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_FROM) {
    return { status: 'not_configured', message: 'WhatsApp provider credentials missing' };
  }
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const from = process.env.TWILIO_WHATSAPP_FROM.startsWith('whatsapp:')
      ? process.env.TWILIO_WHATSAPP_FROM
      : `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;
    const toWhatsApp = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const result = await client.messages.create({ from, to: toWhatsApp, body });
    return { status: 'accepted_by_provider', providerId: result.sid };
  } catch (err) {
    console.error('WhatsApp provider error:', err.message);
    return { status: 'failed', message: 'WhatsApp provider rejected the request; check opt-in, sandbox and template rules' };
  }
}

async function sendVoiceCall(to, name, trigger) {
  const from = process.env.TWILIO_VOICE_FROM;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !from) {
    return { status: 'not_configured', message: 'Voice call credentials missing' };
  }
  try {
    const safeName = String(name).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
    const reason = trigger === 'no_response'
      ? 'did not respond to a safety check'
      : trigger === 'test'
        ? 'requested a delivery test; this is not an emergency'
        : 'manually sent an SOS alert';
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const result = await client.calls.create({
      from,
      to,
      twiml: `<Response><Say language="en-US">KAAPPAN safety alert. ${safeName} ${reason}. Please call them and ask if they need help.</Say></Response>`
    });
    return { status: 'accepted_by_provider', providerId: result.sid };
  } catch (err) {
    console.error('Voice call provider error:', err.message);
    return { status: 'failed', message: 'Voice call provider rejected the request' };
  }
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    smsConfigured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM),
    whatsappConfigured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM),
    voiceConfigured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VOICE_FROM),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const name = cleanString(req.body.name, 80);
  const phone = cleanString(req.body.phone, 20);
  const email = cleanString(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (name.length < 2 || !validPhone(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid name, phone number and email.' });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be between 8 and 72 characters.' });
  }
  const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) return res.status(409).json({ error: 'An account with this email already exists.' });
  const passwordHash = await bcrypt.hash(password, 12);
  const [result] = await db.execute(
    'INSERT INTO users (name, phone, email, password_hash) VALUES (?, ?, ?, ?)',
    [name, phone, email, passwordHash]
  );
  const user = { id: result.insertId, name, phone, email };
  req.session.user = user;
  res.status(201).json({ success: true, user });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = cleanString(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const [rows] = await db.execute('SELECT id, name, phone, email, password_hash FROM users WHERE email = ?', [email]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const user = publicUser(rows[0]);
  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.user = user;
  res.json({ success: true, user });
}));

app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('kaappan.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ success: true });
  });
});

app.get('/api/contacts', requireAuth, asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    'SELECT id, name, phone, created_at FROM emergency_contacts WHERE user_id = ? ORDER BY id DESC',
    [req.session.user.id]
  );
  res.json({ contacts: rows });
}));

app.post('/api/contacts', requireAuth, asyncRoute(async (req, res) => {
  const name = cleanString(req.body.name, 80);
  const phone = cleanString(req.body.phone, 20);
  if (name.length < 2 || !validPhone(phone)) return res.status(400).json({ error: 'Enter a valid contact name and phone number.' });
  if (req.body.consent !== true) return res.status(400).json({ error: 'Confirm that this contact agreed to receive emergency alerts.' });
  const [result] = await db.execute(
    'INSERT INTO emergency_contacts (user_id, name, phone, consent_confirmed) VALUES (?, ?, ?, 1)',
    [req.session.user.id, name, phone]
  );
  res.status(201).json({ success: true, id: result.insertId });
}));

app.delete('/api/contacts/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid contact ID.' });
  await db.execute('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?', [id, req.session.user.id]);
  res.json({ success: true });
}));

app.post('/api/test-delivery', requireAuth, deliveryTestLimiter, asyncRoute(async (req, res) => {
  const phone = cleanString(req.session.user.phone, 20);
  if (!validPhone(phone)) return res.status(400).json({ error: 'Add a valid phone number to your account before testing delivery.' });
  const normalizedPhone = phone.replace(/[^\d+]/g, '');
  const message = `KAAPPAN DELIVERY TEST. This is a test message to ${req.session.user.name}; no emergency was triggered.`;
  const [sms, whatsapp, voice] = await Promise.all([
    sendSms(normalizedPhone, message),
    sendWhatsApp(normalizedPhone, message),
    sendVoiceCall(normalizedPhone, req.session.user.name, 'test')
  ]);
  res.json({
    phone,
    results: [
      { channel: 'SMS', ...sms },
      { channel: 'WhatsApp', ...whatsapp },
      { channel: 'Voice call', ...voice }
    ]
  });
}));

app.post('/api/sos', requireAuth, sosLimiter, asyncRoute(async (req, res) => {
  const trigger = req.body?.trigger;
  if (!['manual', 'no_response'].includes(trigger)) return res.status(400).json({ error: 'Invalid SOS trigger.' });
  const lat = Number(req.body?.location?.latitude);
  const lng = Number(req.body?.location?.longitude);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const location = hasLocation ? { latitude: lat, longitude: lng } : null;
  const accuracy = Number(req.body?.location?.accuracy);
  const locationAccuracy = Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100000 ? accuracy : null;
  const [contactRows] = await db.execute(
    'SELECT id, name, phone FROM emergency_contacts WHERE user_id = ? AND consent_confirmed = 1 ORDER BY id ASC',
    [req.session.user.id]
  );
  if (!contactRows.length) return res.status(400).json({ error: 'Add at least one consenting emergency contact first.' });

  const mapLink = location ? `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}` : 'Location unavailable (GPS permission not granted or position unavailable)';
  const alertNote = trigger === 'no_response'
    ? 'An automated safety check expired without a response. Please try to contact them now.'
    : 'The user manually requested emergency assistance. Please try to contact them now.';
  const message = `KAAPPAN SAFETY ALERT. ${alertNote} Name: ${req.session.user.name}. Location: ${mapLink}${locationAccuracy === null ? '' : ` (GPS accuracy approximately ${Math.round(locationAccuracy)} meters)`}`;
  const [eventResult] = await db.execute(
    'INSERT INTO sos_events (user_id, latitude, longitude, status) VALUES (?, ?, ?, ?)',
    [req.session.user.id, location?.latitude ?? null, location?.longitude ?? null, 'processing']
  );

  const results = [];
  for (const contact of contactRows) {
    const sms = await sendSms(contact.phone.replace(/[^\d+]/g, ''), message);
    results.push({ channel: 'SMS', contact: contact.name, ...sms });
    const wa = await sendWhatsApp(contact.phone.replace(/[^\d+]/g, ''), message);
    results.push({ channel: 'WhatsApp', contact: contact.name, ...wa });
    const call = await sendVoiceCall(contact.phone.replace(/[^\d+]/g, ''), req.session.user.name, trigger);
    results.push({ channel: 'Voice call', contact: contact.name, ...call });
  }
  const anyAccepted = results.some(r => r.status === 'accepted_by_provider');
  const status = anyAccepted ? 'provider_accepted_some' : 'attempted_no_provider_delivery';
  await db.execute('UPDATE sos_events SET status = ? WHERE id = ?', [status, eventResult.insertId]);
  res.json({ success: true, eventId: eventResult.insertId, locationIncluded: Boolean(location), results });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error. Check the Node.js terminal for details.' });
});

async function start() {
  await db.query('SELECT 1');
  console.log('MySQL connected.');
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = PORT + attempt;
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(port, '0.0.0.0', () => resolve(server));
        server.once('error', reject);
      });
      console.log(`KAAPPAN running at http://localhost:${port}`);
      return;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      console.warn(`Port ${port} is already in use; trying the next port.`);
    }
  }
  throw new Error(`No available port found between ${PORT} and ${PORT + 9}.`);
}
start().catch(err => {
  console.error('Startup failed. Check MySQL, database name, and .env settings:', err.message);
  process.exit(1);
});
