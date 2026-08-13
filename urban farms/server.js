import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import XLSX from 'xlsx';
import twilio from 'twilio';
import { compareFaces, checkDeliveryProximity, detectSingleFace, isFaceVerificationAvailable } from './services/faceVerification.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvFile();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'urban-farms-secret-2026';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';
const ADMIN_BYPASS_CODE = process.env.ADMIN_BYPASS_CODE || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';
const WHATSAPP_UNAVAILABLE_CODES = new Set((process.env.WHATSAPP_UNAVAILABLE_ERROR_CODES || '').split(',').map(code => code.trim()).filter(Boolean));
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8'); }

global.__orders = readJSON('orders.json');
global.__workers = readJSON('workers.json').map(w => ({ ...w, approved: w.approved ?? true, status: w.status || (w.approved === false ? 'pending' : 'approved') }));
global.__customers = readJSON('customers.json');
global.__shops = readJSON('shops.json');
global.__tickets = readJSON('tickets.json');
global.__notifications = readJSON('notifications.json');
global.__auditLog = readJSON('audit-log.json');
const savedInventory = readJSON('inventory.json');
global.__inventory = savedInventory && !Array.isArray(savedInventory) ? savedInventory : { chicks: 200, chicken: 50, eggs: 120, sonali: 100, assel: 100, tn_assel: 100 };
function saveOrders() { writeJSON('orders.json', global.__orders); }
function saveWorkers() { writeJSON('workers.json', global.__workers); }
function saveCustomers() { writeJSON('customers.json', global.__customers); }
function saveShops() { writeJSON('shops.json', global.__shops); }
function saveTickets() { writeJSON('tickets.json', global.__tickets); }
function saveNotifications() { writeJSON('notifications.json', global.__notifications); }
function saveAuditLog() { writeJSON('audit-log.json', global.__auditLog); }
function saveInventory() { writeJSON('inventory.json', global.__inventory); }
global.__paymentSessions = readJSON('payment-sessions.json') || [];
function savePaymentSessions() { writeJSON('payment-sessions.json', global.__paymentSessions); }
const DELIVERY_SLOTS = ['08:00-11:00', '11:00-14:00', '14:00-17:00', '17:00-20:00'];
const DELIVERY_SLOT_CAPACITY = Math.max(1, Number(process.env.DELIVERY_SLOT_CAPACITY || 20));
const SERVICEABLE_PINCODES = new Set((process.env.SERVICEABLE_PINCODES || '').split(',').map(value => value.trim()).filter(Boolean));
function slotHasCapacity(date, slot, excludeOrderId = null) { return global.__orders.filter(order => order.id !== excludeOrderId && order.deliveryDate === date && order.deliverySlot === slot && !['cancelled', 'delivered'].includes(order.deliveryStatus)).length < DELIVERY_SLOT_CAPACITY; }
function addOrderEvent(order, type, message) {
  order.events = order.events || [];
  order.events.push({ type, message, at: new Date().toISOString() });
  if (order.customerId && ['assigned', 'out_for_delivery', 'delivered', 'cancelled', 'rescheduled', 'exception'].includes(type)) void sendOrderNotification(order, message);
}
function notify(userId, message, orderId = null) {
  global.__notifications.push({ id: generateId('NOT'), userId, message, orderId, read: false, createdAt: new Date().toISOString() });
  saveNotifications();
  const order = orderId ? global.__orders.find(item => item.id === orderId) : null;
  if (order && order.customerId === userId) void sendOrderNotification(order, message);
}
function audit(actorId, action, targetId, details = {}) { global.__auditLog.push({ id: generateId('AUD'), actorId, action, targetId, details, at: new Date().toISOString() }); if (global.__auditLog.length > 10000) global.__auditLog.splice(0, global.__auditLog.length - 10000); saveAuditLog(); }
function notifyWorker(workerId, message, orderId = null) {
  const worker = global.__workers.find(w => w.id === workerId);
  if (!worker) return;
  global.__notifications.push({ id: generateId('NOT'), userId: worker.id, message, orderId, read: false, createdAt: new Date().toISOString() });
  saveNotifications();
}
function getShop(shopId) { return global.__shops.find(s => s.id === shopId); }
function getWorkerShops(workerId) { return global.__shops.filter(s => s.registeredBy === workerId); }
function generateCredentials() { const password = Math.random().toString(36).slice(2, 10); return { password, passwordHash: bcrypt.hashSync(password, 10) }; }

function assignedDeliveryCount(workerId) {
  return global.__orders.filter(o => o.workerId === workerId && ['assigned', 'out_for_delivery'].includes(o.deliveryStatus)).length;
}
function selectAvailableWorker() {
  return global.__workers.filter(w => w.active !== false && w.approved === true && w.onShift === true && w.availability !== 'offline')
    .sort((a, b) => assignedDeliveryCount(a.id) - assignedDeliveryCount(b.id) || (a.deliveredToday || 0) - (b.deliveredToday || 0) || new Date(a.lastAssignedAt || 0) - new Date(b.lastAssignedAt || 0))[0];
}
function assignOrderToAvailableWorker(order) {
  const worker = selectAvailableWorker();
  if (!worker) return false;
  order.workerId = worker.id; order.workerName = worker.name; order.deliveryStatus = 'assigned'; order.assignedAt = new Date().toISOString();
  addOrderEvent(order, 'assigned', 'Delivery partner assigned');
  worker.lastAssignedAt = order.assignedAt;
  return true;
}
function autoAssignPendingOrders() {
  let changed = false;
  for (const order of global.__orders.filter(o => o.deliveryStatus === 'pending').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)))
    changed = assignOrderToAvailableWorker(order) || changed;
  if (changed) { saveOrders(); saveWorkers(); }
}
function validLocation(location) {
  if (!location || typeof location !== 'object') return null;
  const latitude = Number(location.latitude), longitude = Number(location.longitude), accuracy = Number(location.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, accuracy: Number.isFinite(accuracy) ? Math.max(0, Math.round(accuracy)) : null, recordedAt: new Date().toISOString() };
}
const LOCATION_STALE_AFTER_MS = 2 * 60 * 1000;
function hasFreshLiveLocation(worker) {
  if (!worker || !worker.liveLocation || !worker.lastLocationAt) return false;
  return Date.now() - new Date(worker.lastLocationAt).getTime() <= LOCATION_STALE_AFTER_MS;
}
// Worker delivery view includes payment status so the BE can collect and reconcile shop payments.
function workerDeliveryDetails(order, includeCompletionProof = false) {
  const details = {
    id: order.id, product: order.product, quantity: order.quantity, unit: order.unit,
    customerName: order.customerName, customerPhone: order.customerPhone,
    address: order.address, area: order.area, pincode: order.pincode, city: order.city, state: order.state,
    deliveryDate: order.deliveryDate, notes: order.notes, deliveryStatus: order.deliveryStatus, paymentStatus: order.paymentStatus || 'pending', createdAt: order.createdAt
  };
  if (includeCompletionProof) {
    details.deliveryPhoto = order.deliveryPhoto;
    details.deliveredAt = order.deliveredAt;
  }
  return details;
}

const OTP_STORE = new Map();
function normalizePhone(phone) { const digits = String(phone || '').replace(/\D/g, ''); return digits.length >= 10 ? digits.slice(-10) : digits; }
function getOtpKey(role, phone) { return `${role}:${normalizePhone(phone)}`; }
function createOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
function storeOtp(role, phone, otp) { const key = getOtpKey(role, phone); OTP_STORE.set(key, { otp, expiresAt: Date.now() + 5 * 60 * 1000 }); return otp; }
function verifyOtp(role, phone, otp) {
  const key = getOtpKey(role, phone); const entry = OTP_STORE.get(key);
  if (!entry) return false; if (Date.now() > entry.expiresAt) { OTP_STORE.delete(key); return false; }
  const isValid = String(entry.otp) === String(otp); if (isValid) OTP_STORE.delete(key); return isValid;
}
function formatPhoneForSms(phone) { const digits = normalizePhone(phone); if (!digits) return ''; if (digits.startsWith('+')) return digits; if (digits.length === 10) return `+91${digits}`; return `+${digits}`; }
async function sendSmsMessage(phone, message, purpose = 'notification') {
  const to = formatPhoneForSms(phone) || phone;
  if (!twilioClient || !TWILIO_SMS_FROM) { console.log(`[SMS ${purpose.toUpperCase()} PENDING] ${to} -> ${message}`); return { sent: false, provider: 'not_configured' }; }
  await twilioClient.messages.create({ from: TWILIO_SMS_FROM, to, body: message });
  return { sent: true, provider: 'twilio_sms' };
}
async function sendOrderNotification(order, message) {
  const to = formatPhoneForSms(order.customerPhone);
  if (!to) return { sent: false, channel: 'none' };
  if (!twilioClient || !TWILIO_WHATSAPP_FROM) { console.log(`[WHATSAPP ORDER PENDING] ${to} -> ${message}`); return { sent: false, channel: 'whatsapp_not_configured' }; }
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM.startsWith('whatsapp:') ? TWILIO_WHATSAPP_FROM : 'whatsapp:' + TWILIO_WHATSAPP_FROM, to: 'whatsapp:' + to, body: 'Urban Farms: ' + message });
    return { sent: true, channel: 'whatsapp' };
  } catch (error) {
    if (!WHATSAPP_UNAVAILABLE_CODES.has(String(error.code || ''))) { console.warn('[WhatsApp order notification failed; SMS not sent]', error.code || error.message); return { sent: false, channel: 'whatsapp_error' }; }
    const sms = await sendSmsMessage(order.customerPhone, 'Urban Farms: ' + message, 'order fallback');
    return { ...sms, channel: sms.sent ? 'sms_fallback' : 'sms_not_configured' };
  }
}
async function sendOtpSms(phone, otp, role) {
  const message = `Your Urban Farms ${role === 'worker' ? 'worker' : 'customer'} OTP is ${otp}. It is valid for 5 minutes.`;
  return sendSmsMessage(phone, message, 'otp');
}

(function ensureAdmin() {
  const normalizedPhone = normalizePhone(ADMIN_PHONE);
  if (!normalizedPhone || !ADMIN_PASSWORD) return;
  const admins = global.__customers.filter(c => c.role === 'admin');
  let changed = false;
  // Environment credentials are the source of truth. The old implementation
  // only replaced a missing hash, so changing ADMIN_PASSWORD in .env left the
  // previously stored password active and permanently locked out the admin.
  let admin = admins.find(a => a.id === 'admin-001') || admins.find(a => a.phone === normalizedPhone) || admins[0];
  if (!admin) {
    admin = { id: 'admin-001', name: ADMIN_NAME, phone: normalizedPhone, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10), role: 'admin', createdAt: new Date().toISOString() };
    global.__customers.push(admin);
    changed = true;
  } else {
    const passwordHash = String(admin.passwordHash || '');
    const passwordMatches = /^\$2[aby]\$\d{2}\$/.test(passwordHash) && bcrypt.compareSync(ADMIN_PASSWORD, passwordHash);
    if (admin.name !== ADMIN_NAME || admin.phone !== normalizedPhone || !passwordMatches) {
      admin.name = ADMIN_NAME;
      admin.phone = normalizedPhone;
      admin.passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      admin.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveCustomers();
})();

app.use(helmet({ contentSecurityPolicy: false }));
// ==================== CORS CONFIGURATION ====================
// Allow the deployed Render site, local development, and any additional
// domains supplied through the ALLOWED_ORIGINS environment variable.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://urban-feather-farms.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

const ENV_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...ENV_ALLOWED_ORIGINS
])];

console.log('[CORS] Allowed origins:', ALLOWED_ORIGINS);

app.use(cors({
  origin(origin, callback) {
    // Requests such as same-origin/server-to-server requests may not contain
    // an Origin header. These should be allowed.
    if (!origin) {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));
const PUBLIC_PAGES = ['index-1.html', 'login.html', 'customer-dashboard.html', 'worker-dashboard.html', 'admin-dashboard.html', 'shop-register.html'];
for (const page of PUBLIC_PAGES) {
  app.get(`/${page}`, (req, res) => { res.sendFile(path.join(__dirname, page)); });
}
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index-1.html')); });
app.get('/logo.jpeg', (req, res) => { res.sendFile(path.join(__dirname, 'logo.jpeg')); });
app.get('/favicon.ico', (req, res) => { res.sendFile(path.join(__dirname, 'logo.jpeg')); });

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false });

function generateId(prefix) { return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(); }
function authMiddleware(roles = []) { return (req, res, next) => { const header = req.get('Authorization'); if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid token' }); try { const token = header.slice(7); const decoded = jwt.verify(token, JWT_SECRET); if (roles.length > 0 && !roles.includes(decoded.role)) return res.status(403).json({ error: 'Insufficient permissions' }); req.user = decoded; next(); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); } }; }
function roleLabel(role) {
  if (role === 'worker') return 'Business Executive';
  if (role === 'customer') return 'Shop Owner';
  if (role === 'admin') return 'Admin';
  return role;
}
// Prices: try loading from data/prices.json, otherwise fall back to defaults
let PRICES = (function(){
  const saved = readJSON('prices.json');
  if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length > 0) return saved;
  return { chicks: 85, chicken: 650, eggs: 150, sonali: 650, assel: 650, tn_assel: 650 };
})();
const UNIT = { chicks: 'chick', chicken: 'bird', eggs: 'dozen', sonali: 'bird', assel: 'bird', tn_assel: 'bird' };
const PRODUCT_NAMES = { chicks: 'Sonali Breed Chicks', chicken: 'Live Country Chicken', eggs: 'Farm-Fresh Eggs', sonali: 'Sonali', assel: 'Assel', tn_assel: 'TN-Assel' };
app.get('/api/catalog', (req, res) => {
  return res.json({ ok: true, products: Object.keys(PRICES).map(key => ({ key, name: PRODUCT_NAMES[key], price: PRICES[key], stock: Math.max(0, Number(global.__inventory[key] || 0)), unit: UNIT[key] })), deliverySlots: DELIVERY_SLOTS });
});

// Admin: get & update prices without changing code
app.get('/api/admin/prices', authMiddleware(['admin']), (req, res) => {
  return res.json({ ok: true, prices: PRICES, unit: UNIT });
});

app.post('/api/admin/prices', authMiddleware(['admin']), (req, res) => {
  const { prices } = req.body || {};
  if (!prices || typeof prices !== 'object') return res.status(400).json({ error: 'Invalid payload' });
  // validate and update
  for (const k of Object.keys(prices)) {
    const v = Number(prices[k]);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `Invalid price for ${k}` });
    PRICES[k] = v;
  }
  try { writeJSON('prices.json', PRICES); } catch (e) { console.warn('Failed to save prices.json', e); }
  audit(req.user.id, 'prices_updated', null, { prices: PRICES });
  return res.json({ ok: true, prices: PRICES });
});

// Admin: get & update inventory (stock)
app.get('/api/admin/inventory', authMiddleware(['admin']), (req, res) => {
  return res.json({ ok: true, inventory: global.__inventory || {} });
});

app.post('/api/admin/inventory', authMiddleware(['admin']), (req, res) => {
  const { inventory } = req.body || {};
  if (!inventory || typeof inventory !== 'object') return res.status(400).json({ error: 'Invalid payload' });
  for (const k of Object.keys(inventory)) {
    const v = Number(inventory[k]);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `Invalid inventory for ${k}` });
    global.__inventory[k] = Math.max(0, Math.floor(v));
  }
  try { saveInventory(); } catch (e) { console.warn('Failed to save inventory.json', e); }
  audit(req.user.id, 'inventory_updated', null, { inventory: global.__inventory });
  return res.json({ ok: true, inventory: global.__inventory });
});

// Admin: payment gateway configuration (store credentials later)
app.get('/api/admin/payment-config', authMiddleware(['admin']), (req, res) => {
  const cfg = readJSON('payment-config.json') || {};
  return res.json({ ok: true, config: cfg });
});

app.post('/api/admin/payment-config', authMiddleware(['admin']), (req, res) => {
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Invalid config' });
  try { writeJSON('payment-config.json', config); } catch (e) { console.warn('Failed to save payment-config.json', e); }
  audit(req.user.id, 'payment_config_updated', null, { provider: config.provider || 'none' });
  return res.json({ ok: true, config });
});

// ========== AUTH ROUTES ==========
app.post('/api/auth/customer/register', authLimiter, async (req, res) => {
  return res.status(403).json({ error: 'Customer self-registration is disabled. Contact your BE for credentials.' });
});
app.post('/api/auth/customer/send-otp', authLimiter, async (req, res) => {
  return res.status(403).json({ error: 'Customer OTP login is disabled. Use your password provided by your BE.' });
});
app.post('/api/auth/customer/login', authLimiter, (req, res) => {
  const { phone, password } = req.body;
  const normPhone = normalizePhone(phone);
  const customer = global.__customers.find(c => (c.role === 'customer' || c.role === 'shop') && c.phone === normPhone);
  if (!customer || !customer.passwordHash) return res.status(401).json({ error: 'Invalid mobile number or password' });
  if (!password || !bcrypt.compareSync(String(password), customer.passwordHash)) return res.status(401).json({ error: 'Invalid mobile number or password' });
  const token = jwt.sign({ id: customer.id, phone: customer.phone, name: customer.name, role: customer.role }, JWT_SECRET, { expiresIn: '30d' });
  return res.json({ ok: true, token, user: { id: customer.id, name: customer.name, phone: customer.phone, role: customer.role } });
});
app.post('/api/auth/worker/register', authLimiter, async (req, res) => {
  const { name, phone, selfie, password, pin } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Worker name is required' });
  const normPhone = normalizePhone(phone);
  if (!/^[6-9]\d{9}$/.test(normPhone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number starting with 6-9' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Choose a password with at least 8 characters' });
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'Choose a 4 to 6 digit PIN' });
  if (!selfie || !/^data:image\/jpeg;base64,/.test(selfie) || selfie.length > 8000000) return res.status(400).json({ error: 'A clear camera selfie is required to register' });
  const faceCheck = await detectSingleFace(selfie);
  if (!faceCheck.ok) return res.status(400).json({ error: faceCheck.error });
  const exists = global.__workers.find(w => w.phone === normPhone);
  if (exists) return res.status(409).json({ error: 'A worker is already registered with this mobile number' });
  for (const enrolledWorker of global.__workers.filter(w => w.enrollmentSelfie)) {
    const comparison = await compareFaces(enrolledWorker.enrollmentSelfie, selfie);
    if (comparison.matched && comparison.similarity >= 90) return res.status(409).json({ error: 'This face is already registered to another worker account' });
  }
  const worker = { id: generateId('WRK'), name: name.trim(), phone: normPhone, passwordHash: bcrypt.hashSync(String(password), 10), pinHash: bcrypt.hashSync(String(pin), 10), approved: false, active: false, status: 'pending', onShift: false, availability: 'offline', shopsVisited: 0, deliveredToday: 0, enrollmentSelfie: selfie, selfieUpdatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  global.__workers.push(worker); saveWorkers();
  return res.status(201).json({ ok: true, registered: true, pendingApproval: true, phone: normPhone, workerId: worker.id, message: 'Registration submitted. Your account will be available after admin approval.' });
});
app.post('/api/auth/worker/send-otp', authLimiter, async (req, res) => {
  const { phone } = req.body; const normPhone = normalizePhone(phone);
  const worker = global.__workers.find(w => w.phone === normPhone);
  if (!worker) return res.status(404).json({ error: 'No worker account found for this mobile number' });
  if (worker.approved !== true) return res.status(403).json({ error: 'Your worker request is still pending admin approval' });
  const otp = storeOtp('worker', normPhone, createOtp());
  try { await sendOtpSms(normPhone, otp, 'worker'); return res.json({ ok: true, otpSent: true, phone: normPhone, message: 'OTP sent to your phone for verification.' }); }
  catch (error) { return res.status(502).json({ error: 'Unable to send OTP right now. Please try again later.' }); }
});
app.post('/api/auth/worker/login', authLimiter, (req, res) => {
  try {
    const { phone, otp, bypassCode, password, pin } = req.body; const normPhone = normalizePhone(phone);
    if (normPhone && bypassCode && String(bypassCode) === String(ADMIN_BYPASS_CODE) && normalizePhone(ADMIN_PHONE) === normPhone) {
      const admin = global.__customers.find(c => c.phone === normPhone && c.role === 'admin');
      if (!admin) return res.status(401).json({ error: 'Admin account not found' });
      const token = jwt.sign({ id: admin.id, phone: admin.phone, name: admin.name, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ ok: true, token, user: { id: admin.id, name: admin.name, phone: admin.phone, role: 'admin', bypass: true } });
    }
    const worker = global.__workers.find(w => w.phone === normPhone);
    if (!worker) return res.status(401).json({ error: 'Invalid mobile number' });
    if (worker.approved !== true) return res.status(403).json({ error: 'Your worker request is still pending admin approval' });
    if (worker.active === false) return res.status(403).json({ error: 'Your worker account is inactive' });
    if (password || pin) {
      const passwordHash = String(worker.passwordHash || '');
      const pinHash = String(worker.pinHash || '');
      const validPasswordHash = /^\$2[aby]\$\d{2}\$/.test(passwordHash);
      const validPinHash = /^\$2[aby]\$\d{2}\$/.test(pinHash);
      if (!validPasswordHash || !validPinHash) return res.status(409).json({ error: 'Your account needs new credentials from the admin' });
      if (!bcrypt.compareSync(password || '', passwordHash) || !bcrypt.compareSync(pin || '', pinHash)) return res.status(401).json({ error: 'Invalid worker credentials' });
    } else if (!otp || !verifyOtp('worker', normPhone, otp)) return res.status(401).json({ error: 'Enter your worker password and PIN' });
    const token = jwt.sign({ id: worker.id, phone: worker.phone, name: worker.name, role: 'worker' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, user: { id: worker.id, name: worker.name, phone: worker.phone, role: 'worker' } });
  } catch (error) {
    console.error('[Worker login failed]', error.message);
    return res.status(500).json({ error: 'Unable to complete BE login. Check the server logs and try again.' });
  }
});
app.post('/api/auth/shop/send-otp', authLimiter, async (req, res) => {
  const { phone } = req.body; const normPhone = normalizePhone(phone);
  const shopOwner = global.__customers.find(c => c.phone === normPhone && ['shop','customer'].includes(c.role));
  if (!shopOwner) return res.status(404).json({ error: 'No shop account found for this mobile number' });
  const otp = storeOtp('shop', normPhone, createOtp());
  try { await sendOtpSms(normPhone, otp, 'customer'); return res.json({ ok: true, otpSent: true, phone: normPhone, message: 'OTP sent to your phone for verification.' }); }
  catch (error) { return res.status(502).json({ error: 'Unable to send OTP right now. Please try again later.' }); }
});
app.post('/api/auth/shop/login', authLimiter, (req, res) => {
  const { phone, otp, password } = req.body; const normPhone = normalizePhone(phone);
  const shopOwner = global.__customers.find(c => c.phone === normPhone && ['shop','customer'].includes(c.role));
  if (!shopOwner) return res.status(401).json({ error: 'Invalid mobile number' });
  if (password) {
    if (!shopOwner.passwordHash || !bcrypt.compareSync(password || '', shopOwner.passwordHash)) return res.status(401).json({ error: 'Invalid shop account credentials' });
  } else if (!otp || !verifyOtp('shop', normPhone, otp)) return res.status(401).json({ error: 'Invalid or expired OTP' });
  const token = jwt.sign({ id: shopOwner.id, phone: shopOwner.phone, name: shopOwner.name, role: shopOwner.role || 'shop' }, JWT_SECRET, { expiresIn: '30d' });
  return res.json({ ok: true, token, user: { id: shopOwner.id, name: shopOwner.name, phone: shopOwner.phone, role: shopOwner.role || 'shop' } });
});
app.post('/api/auth/admin/login', authLimiter, (req, res) => {
  try {
    const { phone, password } = req.body; const normPhone = normalizePhone(phone);
    const admin = global.__customers.find(c => c.phone === normPhone && c.role === 'admin');
    const passwordHash = String(admin?.passwordHash || '');
    const isValidHash = /^\$2[aby]\$\d{2}\$/.test(passwordHash);
    if (!admin || !isValidHash || !bcrypt.compareSync(password || '', passwordHash)) return res.status(401).json({ error: 'Invalid admin credentials' });
    const token = jwt.sign({ id: admin.id, phone: admin.phone, name: admin.name, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, token, user: { id: admin.id, name: admin.name, phone: admin.phone, role: 'admin' } });
  } catch (error) {
    console.error('[Admin login failed]', error.message);
    return res.status(500).json({ error: 'Unable to complete admin login. Check the server logs and try again.' });
  }
});

// ========== WORKER MANAGEMENT (ADMIN) ==========
app.get('/api/admin/workers', authMiddleware(['admin']), (req, res) => {
  const workers = global.__workers.map(w => ({ id: w.id, name: w.name, phone: w.phone, active: w.active !== false && w.approved === true, approved: w.approved === true, status: w.status || (w.approved === false ? 'pending' : 'approved'), createdAt: w.createdAt, deliveredCount: (global.__orders || []).filter(o => o.workerId === w.id && o.deliveryStatus === 'delivered').length, assignedCount: assignedDeliveryCount(w.id), onShift: w.onShift === true, availability: w.availability || 'offline', shiftStartedAt: w.shiftStartedAt || null, lastLocationAt: w.lastLocationAt || null, liveLocation: w.onShift === true ? w.liveLocation || null : null, shopsVisited: w.shopsVisited || 0, deliveredToday: w.deliveredToday || 0, assignedArea: w.assignedArea || null, enrollmentSelfie: w.enrollmentSelfie || null, hasEnrollmentSelfie: !!w.enrollmentSelfie }));
  return res.json({ ok: true, workers });
});
app.post('/api/admin/worker', authMiddleware(['admin']), (req, res) => {
  const { name, phone, password, pin, assignedArea } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Worker name required' });
  const normPhone = normalizePhone(phone);
  if (!/^[6-9]\d{9}$/.test(normPhone)) return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Worker password must be at least 8 characters' });
  if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'Worker PIN must be at least 4 characters' });
  const exists = global.__workers.find(w => w.phone === normPhone);
  if (exists) return res.status(409).json({ error: 'Worker with this mobile number already exists' });
  const worker = { id: generateId('WRK'), name: name.trim(), phone: normPhone, passwordHash: bcrypt.hashSync(String(password), 10), pinHash: bcrypt.hashSync(String(pin), 10), approved: true, active: true, status: 'approved', onShift: false, availability: 'offline', shopsVisited: 0, deliveredToday: 0, enrollmentSelfie: null, assignedArea: assignedArea ? String(assignedArea).trim() : null, createdAt: new Date().toISOString() };
  global.__workers.push(worker); saveWorkers();
  return res.json({ ok: true, worker: { id: worker.id, name: worker.name, phone: worker.phone, active: true, approved: true, assignedArea: worker.assignedArea, createdAt: worker.createdAt } });
});
app.patch('/api/admin/worker/:id/area', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const assignedArea = String(req.body.assignedArea || '').trim();
  worker.assignedArea = assignedArea || null;
  saveWorkers();
  audit(req.user.id, 'worker_area_assigned', worker.id, { assignedArea: worker.assignedArea });
  return res.json({ ok: true, worker: { id: worker.id, assignedArea: worker.assignedArea } });
});
app.patch('/api/admin/worker/:id/approve', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  worker.approved = true; worker.active = true; worker.status = 'approved'; saveWorkers();
  return res.json({ ok: true, approved: true, worker });
});
app.patch('/api/admin/worker/:id/reject', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  worker.approved = false; worker.active = false; worker.status = 'rejected'; saveWorkers();
  return res.json({ ok: true, approved: false, worker });
});
app.post('/api/admin/worker/:id/block', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const reason = (req.body.reason || '').trim() || 'Blocked by admin';
  worker.active = false; worker.blockedReason = reason; worker.blockedAt = new Date().toISOString(); worker.blockedBy = req.user.id;
  worker.onShift = false; worker.availability = 'offline'; worker.liveLocation = null; saveWorkers();
  return res.json({ ok: true, blocked: true, active: false, reason });
});
app.post('/api/admin/worker/:id/unblock', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  worker.active = true; worker.blockedReason = null; worker.blockedAt = null; worker.blockedBy = null; saveWorkers();
  return res.json({ ok: true, unblocked: true, active: true });
});
app.get('/api/admin/worker/:id/voice-notes', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const shopNotes = global.__shops.flatMap(shop => (shop.voiceNotes || []).filter(note => note.workerId === worker.id).map(note => ({ ...note, shopId: shop.id, shopName: shop.shopName, type: note.type || 'shop' })));
  const orderNotes = global.__orders.flatMap(order => (order.beVerificationVoiceNotes || []).filter(note => note.workerId === worker.id).map(note => ({ ...note, orderId: order.id, type: 'order_verification' })));
  const deliveryNotes = global.__orders.flatMap(order => (order.deliveryVoiceNotes || []).filter(note => note.workerId === worker.id).map(note => ({ ...note, orderId: order.id, type: 'delivery' })));
  return res.json({ ok: true, worker: { id: worker.id, name: worker.name, assignedArea: worker.assignedArea || null }, notes: [...shopNotes, ...orderNotes, ...deliveryNotes].sort((a, b) => new Date(b.at) - new Date(a.at)) });
});
app.get('/api/admin/shop/:id/voice-notes', authMiddleware(['admin']), (req, res) => {
  const shop = global.__shops.find(s => s.id === req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  return res.json({ ok: true, shop: { id: shop.id, shopName: shop.shopName, area: shop.area, registeredByName: shop.registeredByName }, voiceNotes: (shop.voiceNotes || []).sort((a, b) => new Date(b.at) - new Date(a.at)) });
});
app.delete('/api/admin/worker/:id', authMiddleware(['admin']), (req, res) => {
  const idx = global.__workers.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Worker not found' });
  global.__workers.splice(idx, 1); saveWorkers();
  return res.json({ ok: true });
});

// ========== WORKER SHOP REGISTRATION ==========
app.get('/api/worker/shops', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker) return res.status(404).json({ error: 'Worker profile not found' });
  const shops = global.__shops.filter(s => s.registeredBy === req.user.id || (worker.assignedArea && String(s.area || '').toLowerCase() === String(worker.assignedArea || '').toLowerCase()));
  return res.json({ ok: true, shops });
});
app.get('/api/worker/area/shops', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker) return res.status(404).json({ error: 'Worker profile not found' });
  const shops = global.__shops.filter(s => s.registeredBy === req.user.id || (worker.assignedArea && String(s.area || '').toLowerCase() === String(worker.assignedArea || '').toLowerCase()));
  return res.json({ ok: true, assignedArea: worker.assignedArea || null, shops: shops.map(s => ({ id: s.id, shopName: s.shopName, ownerName: s.ownerName, ownerPhone: s.ownerPhone, address: s.address, area: s.area, pincode: s.pincode, city: s.city, state: s.state, status: s.status, registeredBy: s.registeredBy, registeredByName: s.registeredByName, lastVisit: s.lastVisit, voiceNoteCount: (s.voiceNotes || []).length })) });
});
app.post('/api/worker/shop/register', authMiddleware(['worker']), (req, res) => {
  const { shopName, ownerName, ownerPhone, address, area, pincode, city, state, shopPhoto, ownerPhoto, latitude, longitude, voiceNote, ownerConsent } = req.body;
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker || worker.active === false || worker.approved !== true) return res.status(403).json({ error: 'Your worker account is not active' });
  if (worker.onShift !== true) return res.status(409).json({ error: 'Start your shift before registering a shop' });
  if (!hasFreshLiveLocation(worker)) return res.status(409).json({ error: 'Location must be current while on shift' });
  if (!shopName || shopName.trim().length < 3) return res.status(400).json({ error: 'Shop name is required' });
  if (!ownerName || ownerName.trim().length < 3) return res.status(400).json({ error: 'Owner name is required' });
  const shopPhone = normalizePhone(ownerPhone);
  if (!/^[6-9]\d{9}$/.test(shopPhone)) return res.status(400).json({ error: 'Owner phone must be a valid 10-digit mobile number' });
  if (!address || address.trim().length < 10) return res.status(400).json({ error: 'Full shop address is required' });
  if (!pincode || !/^\d{6}$/.test(pincode)) return res.status(400).json({ error: 'Valid 6-digit pincode is required' });
  if (!shopPhoto || !/^data:image\/(jpeg|png);base64,/.test(shopPhoto) || shopPhoto.length > 10000000) return res.status(400).json({ error: 'A clear camera photo of the shop and owner is required' });
  if (!ownerPhoto || !/^data:image\/(jpeg|png);base64,/.test(ownerPhoto) || ownerPhoto.length > 10000000) return res.status(400).json({ error: 'A camera photo of the shop owner is required' });
  if (!voiceNote || typeof voiceNote !== 'string' || !voiceNote.startsWith('data:audio/')) return res.status(400).json({ error: 'A voice note recording is required to register a shop' });
  if (ownerConsent !== true) return res.status(400).json({ error: 'Owner must accept to take orders from our farm' });
  if (worker.assignedArea && String(area || '').trim().toLowerCase() !== String(worker.assignedArea || '').toLowerCase()) return res.status(400).json({ error: 'Shop must be registered in your assigned area' });
  const existingShop = global.__shops.find(s => s.ownerPhone === shopPhone || s.shopPhone === shopPhone);
  if (existingShop) return res.status(409).json({ error: 'This shop owner is already registered' });
  const existingCustomer = global.__customers.find(c => c.phone === shopPhone && c.role === 'customer');
  if (existingCustomer) return res.status(409).json({ error: 'A customer account already exists with this phone number' });
  const shopLocation = validLocation({ latitude, longitude, accuracy: 0 });
  if (!shopLocation) return res.status(400).json({ error: 'Location is required to verify shop registration' });
  const credentials = generateCredentials();
  const shopOwner = { id: generateId('SHP'), name: ownerName.trim(), phone: shopPhone, role: 'shop', passwordHash: credentials.passwordHash, createdAt: new Date().toISOString() };
  global.__customers.push(shopOwner); saveCustomers();
  const shop = {
    id: generateId('SHOP'), shopName: shopName.trim(), ownerName: ownerName.trim(), ownerPhone: shopPhone,
    address: address.trim(), area: (area || '').trim(), pincode: pincode.trim(), city: city || 'Hyderabad', state: state || 'Telangana',
    shopPhone: shopPhone, ownerId: shopOwner.id, registeredBy: req.user.id, registeredByName: req.user.name, createdAt: new Date().toISOString(),
    shopPhoto, ownerPhoto, location: shopLocation, status: 'active', ownerConsent: true, lastVisit: null, visitNotes: [], voiceNotes: [{ id: generateId('AUD'), workerId: req.user.id, workerName: req.user.name, type: 'registration', voiceNote, at: new Date().toISOString() }], registrationVoiceNote: { id: generateId('AUD'), workerId: req.user.id, workerName: req.user.name, voiceNote, at: new Date().toISOString() }
  };
  global.__shops.push(shop); saveShops(); audit(req.user.id, 'shop_registered', shop.id, { shopName: shop.shopName, ownerPhone: shop.ownerPhone, shopOwnerId: shopOwner.id, assignedArea: worker.assignedArea, ownerConsent: true });
  return res.status(201).json({ ok: true, shop: { id: shop.id, shopName: shop.shopName, ownerName: shop.ownerName, ownerPhone: shop.ownerPhone, address: shop.address, area: shop.area, city: shop.city, pincode: shop.pincode, status: shop.status, ownerConsent: true }, credentials: { phone: shopPhone, password: credentials.password } });
});
app.post('/api/worker/shop/:id/visit', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker || worker.active === false || worker.approved !== true) return res.status(403).json({ error: 'Your worker account is not active' });
  if (worker.onShift !== true) return res.status(409).json({ error: 'Start your shift before updating a shop visit' });
  if (!hasFreshLiveLocation(worker)) return res.status(409).json({ error: 'Location must be current while on shift' });
  const shop = global.__shops.find(s => s.id === req.params.id && s.registeredBy === req.user.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (worker.assignedArea && String(shop.area || '').trim().toLowerCase() !== String(worker.assignedArea || '').toLowerCase()) return res.status(400).json({ error: 'You can only update shops in your assigned area' });
  const { status, note, voiceNote, closedPhoto, latitude, longitude } = req.body;
  if (!['visited', 'closed', 'owner_unavailable'].includes(status)) return res.status(400).json({ error: 'Invalid visit status' });
  if (status === 'closed' && (!closedPhoto || !/^data:image\/(jpeg|png);base64,/.test(closedPhoto))) return res.status(400).json({ error: 'A camera photo is required when the shop is closed' });
  if (!voiceNote || typeof voiceNote !== 'string' || !voiceNote.startsWith('data:audio/')) return res.status(400).json({ error: 'A voice note upload is required for every visit' });
  const visitLocation = validLocation({ latitude, longitude, accuracy: 0 });
  if (!visitLocation) return res.status(400).json({ error: 'Current GPS location is required for the visit update' });
  const visit = { id: generateId('VIS'), workerId: req.user.id, workerName: req.user.name, status, note: note || '', voiceNote, closedPhoto: closedPhoto || null, location: visitLocation, at: new Date().toISOString() };
  shop.lastVisit = visit.at; shop.visitNotes.push(visit); shop.voiceNotes.push(visit);
  if (status === 'closed') shop.status = 'closed';
  saveShops(); audit(req.user.id, 'shop_visit', shop.id, { status, note: visit.note });
  return res.json({ ok: true, visit });
});

// ========== ADMIN SHOP MANAGEMENT ==========
app.get('/api/admin/shops', authMiddleware(['admin']), (req, res) => {
  const shops = global.__shops.map(shop => ({
    id: shop.id, shopName: shop.shopName, ownerName: shop.ownerName, ownerPhone: shop.ownerPhone,
    address: shop.address, area: shop.area, city: shop.city, pincode: shop.pincode, state: shop.state,
    registeredBy: shop.registeredBy, registeredByName: shop.registeredByName, status: shop.status,
    createdAt: shop.createdAt, lastVisit: shop.lastVisit, visits: shop.visitNotes.length
  }));
  return res.json({ ok: true, shops });
});

// Admin: get a single shop with owner details
app.get('/api/admin/shop/:id', authMiddleware(['admin']), (req, res) => {
  const shop = global.__shops.find(s => s.id === req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const owner = global.__customers.find(c => c.id === shop.ownerId) || null;
  const ownerSafe = owner ? { id: owner.id, name: owner.name, phone: owner.phone, role: owner.role, createdAt: owner.createdAt } : null;
  const shopOrders = global.__orders.filter(o => o.customerId === shop.ownerId);
  const stats = { totalOrders: shopOrders.length, delivered: shopOrders.filter(o => o.deliveryStatus === 'delivered').length, pendingPayments: shopOrders.filter(o => o.paymentStatus === 'pending').length, partialPayments: shopOrders.filter(o => o.paymentStatus === 'partial').length, completedPayments: shopOrders.filter(o => o.paymentStatus === 'paid').length, revenue: shopOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0) };
  return res.json({ ok: true, shop: { ...shop, owner: ownerSafe, stats } });
});

// Admin: list orders for a shop (by ownerId)
app.get('/api/admin/shop/:id/orders', authMiddleware(['admin']), (req, res) => {
  const shop = global.__shops.find(s => s.id === req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const ownerId = shop.ownerId;
  const orders = global.__orders.filter(o => o.customerId === ownerId).map(o => ({ id: o.id, product: o.product, productKey: o.productKey, quantity: o.quantity, unit: o.unit, total: o.total, paymentStatus: o.paymentStatus, deliveryStatus: o.deliveryStatus, createdAt: o.createdAt }));
  return res.json({ ok: true, orders });
});

// Admin: reset shop owner credentials (generate new password) and return plaintext credentials
app.post('/api/admin/shop/:id/reset-credentials', authMiddleware(['admin']), (req, res) => {
  const shop = global.__shops.find(s => s.id === req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const owner = global.__customers.find(c => c.id === shop.ownerId && (c.role === 'shop' || c.role === 'customer'));
  if (!owner) return res.status(404).json({ error: 'Shop owner account not found' });
  const creds = generateCredentials();
  owner.passwordHash = creds.passwordHash; owner.updatedAt = new Date().toISOString(); saveCustomers();
  audit(req.user.id, 'shop_credentials_reset', shop.id, { ownerId: owner.id });
  return res.json({ ok: true, credentials: { phone: owner.phone, password: creds.password } });
});

// ========== CUSTOMER ROUTES ==========
app.get('/api/customer/me', authMiddleware(['customer','shop']), (req, res) => {
  return res.json({ ok: true, user: { id: req.user.id, name: req.user.name, phone: req.user.phone, role: req.user.role || 'customer' } });
});
app.post('/api/order/submit', apiLimiter, authMiddleware(['customer','shop']), (req, res) => {
  const { items, product, quantity, address, area, pincode, city, state, notes, deliveryDate, deliverySlot, latitude, longitude, paymentStatus } = req.body;
  const orderItems = Array.isArray(items) ? items : [{ product, quantity }];
  if (!orderItems.length || orderItems.length > 10) return res.status(400).json({ error: 'Add between 1 and 10 products to your order' });
  const normalizedItems = orderItems.map(item => ({ product: item?.product, quantity: parseInt(item?.quantity), cleaning: item?.cleaning === true }));
  if (normalizedItems.some(item => !['chicks', 'chicken', 'eggs', 'sonali', 'assel', 'tn_assel'].includes(item.product))) return res.status(400).json({ error: 'Invalid product' });
  if (normalizedItems.some(item => !item.quantity || item.quantity < 1 || item.quantity > 100)) return res.status(400).json({ error: 'Each quantity must be between 1 and 100' });
  const requestedByProduct = normalizedItems.reduce((totals, item) => ({ ...totals, [item.product]: (totals[item.product] || 0) + item.quantity }), {});
  if (Object.entries(requestedByProduct).some(([productKey, quantity]) => (global.__inventory[productKey] ?? 0) < quantity)) return res.status(409).json({ error: 'One or more products are out of stock or have insufficient quantity' });
  if (normalizedItems.some(item => item.cleaning && item.product !== 'chicken')) return res.status(400).json({ error: 'Cleaning is available only for chicken' });
  if (!address || address.trim().length < 10) return res.status(400).json({ error: 'Complete address required' });
  if (!pincode || !/^\d{6}$/.test(pincode)) return res.status(400).json({ error: 'Valid 6-digit pincode required' });
  if (SERVICEABLE_PINCODES.size && !SERVICEABLE_PINCODES.has(pincode.trim())) return res.status(400).json({ error: 'We do not currently deliver to this pincode' });
  if (!deliveryDate || deliveryDate < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Choose a current or future delivery date' });
  if (!DELIVERY_SLOTS.includes(deliverySlot)) return res.status(400).json({ error: 'Choose a valid delivery slot' });
  if (!slotHasCapacity(deliveryDate, deliverySlot)) return res.status(409).json({ error: 'This delivery slot is full. Please choose another slot.' });
  const shopLat = Number(latitude); const shopLng = Number(longitude);
  if (!Number.isFinite(shopLat) || !Number.isFinite(shopLng) || shopLat < -90 || shopLat > 90 || shopLng < -180 || shopLng > 180) {
    return res.status(400).json({ error: 'Share your GPS location so we can verify delivery. Please enable location access.' });
  }
  const batchId = 'UFB-' + Date.now().toString().slice(-6) + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const orders = normalizedItems.map(({ product: productKey, quantity: qty, cleaning }) => {
    const unitPrice = PRICES[productKey] + (cleaning ? 40 : 0);
    const total = unitPrice * qty;
    const isShopOwner = req.user && req.user.role === 'shop';
    // shop orders must explicitly pass paymentStatus in the request
    if (isShopOwner && !['pending','partial','paid'].includes(String(paymentStatus || '').toLowerCase())) return res.status(400).json({ error: 'Shop orders must include paymentStatus: pending|partial|paid' });
    const advanceAmount = isShopOwner ? Math.round(total * 0.5) : 0;
    const balanceAmount = total - advanceAmount;
    const order = {
      id: 'UF-' + Date.now().toString().slice(-6) + '-' + Math.random().toString(36).slice(2, 5).toUpperCase(), batchId,
      customerId: req.user.id, customerName: req.user.name, customerPhone: req.user.phone,
      product: PRODUCT_NAMES[productKey], productKey, quantity: qty, unit: UNIT[productKey], cleaning, unitPrice, total,
      advance: advanceAmount, balance: balanceAmount,
      address: address.trim(), area: (area || '').trim(), pincode: pincode.trim(), city: city || 'Hyderabad', state: state || 'Telangana', notes: notes || '', deliveryDate: deliveryDate || '', deliverySlot: deliverySlot || '',
      paymentStatus: isShopOwner ? String(paymentStatus || 'partial') : 'pending', deliveryStatus: 'pending', workerId: null, workerName: null, shopLatitude: shopLat, shopLongitude: shopLng,
      deliveryPhoto: null, deliveryPhotoAt: null, deliverySelfie: null, faceVerified: false, faceSimilarity: null, gpsDistance: null, deliveryVerified: false,
      adminReviewRequired: false, reviewStatus: 'none', reviewNotes: null, reviewedAt: null, reviewedBy: null, deliveredAt: null, createdAt: new Date().toISOString()
    };
    addOrderEvent(order, 'placed', 'Order placed');
    if (isShopOwner) {
      order.adminReviewRequired = true;
      order.reviewStatus = 'pending_be_verification';
      addOrderEvent(order, 'verification_required', 'Order requires BE verification');
    } else {
      assignOrderToAvailableWorker(order);
    }
    return order;
  });
  global.__orders.push(...orders); saveOrders(); saveWorkers(); audit(req.user.id, 'order_created', batchId, { itemCount: orders.length });
  normalizedItems.forEach(item => { global.__inventory[item.product] -= item.quantity; }); saveInventory();
  const total = orders.reduce((sum, order) => sum + order.total, 0);

  // Notify BE (workers) for verification when a shop places an order
  if (req.user && req.user.role === 'shop') {
    try {
      for (const o of orders) {
        const last = o.beNotifiedAt ? new Date(o.beNotifiedAt).getTime() : 0;
        if (!last || Date.now() - last > 5 * 60 * 1000) {
          for (const w of global.__workers) {
            try { notifyWorker(w.id, `New shop order ${o.id} requires verification`, o.id); } catch (e) { }
          }
          o.beNotifiedAt = new Date().toISOString();
          o.beNotifiedCount = global.__workers.length;
        }
      }
      saveOrders(); saveNotifications();
    } catch (e) { /* non-fatal */ }
  }
  return res.json({ ok: true, batchId, orders: orders.map(order => ({ id: order.id, product: order.product, quantity: order.quantity, unit: order.unit, total: order.total, advance: order.advance, balance: order.balance, paymentStatus: order.paymentStatus, deliveryStatus: order.deliveryStatus })), total, advance: orders.reduce((sum, o) => sum + o.advance, 0), balance: orders.reduce((sum, o) => sum + o.balance, 0) });
});
app.patch('/api/order/:id/reschedule', authMiddleware(['customer','shop']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  const { deliveryDate, deliverySlot } = req.body;
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending', 'assigned'].includes(order.deliveryStatus)) return res.status(409).json({ error: 'This order is already out for delivery and cannot be rescheduled online' });
  if (!deliveryDate || deliveryDate < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Choose a current or future delivery date' });
  if (!DELIVERY_SLOTS.includes(deliverySlot)) return res.status(400).json({ error: 'Choose a valid delivery slot' });
  if (!slotHasCapacity(deliveryDate, deliverySlot, order.id)) return res.status(409).json({ error: 'This delivery slot is full. Please choose another slot.' });
  order.deliveryDate = deliveryDate; order.deliverySlot = deliverySlot; order.rescheduledAt = new Date().toISOString(); addOrderEvent(order, 'rescheduled', 'Delivery rescheduled to ' + deliveryDate + ' ' + deliverySlot); saveOrders();
  return res.json({ ok: true, order: { id: order.id, deliveryDate, deliverySlot } });
});
app.get('/api/customer/notifications', authMiddleware(['customer','shop']), (req, res) => {
  const notifications = global.__notifications.filter(n => n.userId === req.user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30);
  return res.json({ ok: true, notifications });
});
app.post('/api/customer/support', authMiddleware(['customer','shop']), (req, res) => {
  const { orderId, subject, message } = req.body;
  const order = global.__orders.find(o => o.id === orderId && o.customerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!subject || String(subject).trim().length < 3 || !message || String(message).trim().length < 5) return res.status(400).json({ error: 'Enter a subject and a detailed message' });
  const ticket = { id: generateId('SUP'), orderId, customerId: req.user.id, customerName: req.user.name, subject: String(subject).trim(), message: String(message).trim(), status: 'open', createdAt: new Date().toISOString() };
  global.__tickets.push(ticket); saveTickets(); addOrderEvent(order, 'support', 'Customer support request opened'); saveOrders();
  return res.status(201).json({ ok: true, ticket });
});
app.post('/api/order/:id/rating', authMiddleware(['customer','shop']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  const rating = Number(req.body.rating); const comment = String(req.body.comment || '').trim();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.deliveryStatus !== 'delivered') return res.status(409).json({ error: 'You can rate an order after delivery' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  order.rating = rating; order.ratingComment = comment.slice(0, 500); order.ratedAt = new Date().toISOString(); addOrderEvent(order, 'rated', 'Customer submitted a delivery rating'); saveOrders();
  return res.json({ ok: true, rating: order.rating });
});
app.patch('/api/order/:id/pay', authMiddleware(['customer','shop']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.status(409).json({ error: 'Online payments are not configured yet. Please contact Urban Farms to arrange payment.' });
});
app.patch('/api/order/:id/pay-advance', authMiddleware(['customer','shop']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.status(409).json({ error: 'Online payments are not configured yet. Please contact Urban Farms to arrange payment.' });
});
app.patch('/api/order/:id/cancel', authMiddleware(['customer','shop']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.deliveryStatus === 'delivered') return res.status(400).json({ error: 'Delivered orders cannot be cancelled' });
  if (order.deliveryStatus !== 'pending') return res.status(409).json({ error: 'This order has been dispatched and cannot be cancelled or refunded.' });
  if (order.deliveryStatus === 'cancelled') return res.json({ ok: true, message: 'Order already cancelled' });
  order.deliveryStatus = 'cancelled'; order.cancelledAt = new Date().toISOString(); global.__inventory[order.productKey] = (global.__inventory[order.productKey] || 0) + order.quantity; saveInventory(); order.refundEligible = ['paid', 'partial'].includes(order.paymentStatus); order.refundStatus = order.refundEligible ? 'manual_review' : 'not_applicable'; addOrderEvent(order, 'cancelled', 'Order cancelled before dispatch'); saveOrders(); audit(req.user.id, 'order_cancelled', order.id, { stockRestored: order.quantity });
  return res.json({ ok: true, order: { id: order.id, deliveryStatus: order.deliveryStatus, refundEligible: order.refundEligible, refundStatus: order.refundStatus } });
});
app.post('/api/order/:id/damage-claim', authMiddleware(['customer','shop']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.customerId === req.user.id);
  const description = String(req.body.description || '').trim(); const photo = req.body.photo || null;
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.deliveryStatus !== 'delivered') return res.status(409).json({ error: 'Damage claims can only be submitted after delivery' });
  if (!order.deliveredAt || Date.now() - new Date(order.deliveredAt).getTime() > 24 * 60 * 60 * 1000) return res.status(409).json({ error: 'Damage claims must be submitted within 24 hours of delivery' });
  if (description.length < 10 || description.length > 1000) return res.status(400).json({ error: 'Describe the damage in 10 to 1000 characters' });
  if (!photo || !/^data:image\/(jpeg|png);base64,/.test(photo) || photo.length > 8000000) return res.status(400).json({ error: 'Attach a clear JPEG or PNG photo of the damaged product' });
  if (order.damageClaim?.status === 'pending') return res.status(409).json({ error: 'A damage claim is already under review' });
  order.damageClaim = { description, photo, status: 'pending', submittedAt: new Date().toISOString() }; addOrderEvent(order, 'damage_claim', 'Customer submitted a damaged-product claim'); saveOrders(); audit(req.user.id, 'damage_claim_created', order.id);
  return res.status(201).json({ ok: true, claim: order.damageClaim });
});
app.get('/api/customer/orders', authMiddleware(['customer','shop']), (req, res) => {
  const orders = global.__orders.filter(o => o.customerId === req.user.id).map(o => {
    const worker = global.__workers.find(w => w.id === o.workerId);
    const liveLocation = o.deliveryStatus === 'out_for_delivery' && hasFreshLiveLocation(worker)
      ? { latitude: worker.liveLocation.latitude, longitude: worker.liveLocation.longitude, updatedAt: worker.lastLocationAt }
      : null;
    return {
      id: o.id, batchId: o.batchId || null, product: o.product, quantity: o.quantity, unit: o.unit,
      total: o.total, advance: o.advance, balance: o.balance,
      paymentStatus: o.paymentStatus, deliveryStatus: o.deliveryStatus,
      address: o.address, area: o.area, pincode: o.pincode, city: o.city, state: o.state,
      deliveryDate: o.deliveryDate, deliverySlot: o.deliverySlot || '', notes: o.notes, workerName: o.workerName, events: o.events || [],
      assignedAt: o.assignedAt || null, deliveryStartedAt: o.deliveryStartedAt || null,
      liveLocation, deliveryPhoto: o.deliveryPhoto, deliveredAt: o.deliveredAt, createdAt: o.createdAt,
      faceVerified: o.faceVerified, faceSimilarity: o.faceSimilarity,
      gpsDistance: o.gpsDistance, deliveryVerified: o.deliveryVerified,
      adminReviewRequired: o.adminReviewRequired, reviewStatus: o.reviewStatus
      , rating: o.rating || null, ratingComment: o.ratingComment || '', deliveryException: o.deliveryException || null, refundEligible: o.refundEligible === true, refundStatus: o.refundStatus || null, damageClaim: o.damageClaim || null
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ ok: true, orders });
});

// ========== WORKER ROUTES ==========
app.get('/api/worker/status', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker) return res.status(404).json({ error: 'Worker profile not found' });
  return res.json({ ok: true, status: { onShift: worker.onShift === true, availability: worker.availability || 'offline', shiftStartedAt: worker.shiftStartedAt || null, activeDeliveryId: worker.activeDeliveryId || null, lastLocationAt: worker.lastLocationAt || null, locationFresh: hasFreshLiveLocation(worker), shopsVisited: worker.shopsVisited || 0, deliveredToday: worker.deliveredToday || 0, assignedArea: worker.assignedArea || null } });
});
app.post('/api/worker/shift/start', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  const location = validLocation(req.body.location);
  if (!worker || worker.active === false || worker.approved !== true) return res.status(403).json({ error: 'Your worker account is not active' });
  if (!location) return res.status(400).json({ error: 'Current location permission is required to start a shift' });
  worker.onShift = true; worker.availability = 'available'; worker.shiftStartedAt = new Date().toISOString(); worker.shiftEndedAt = null;
  worker.liveLocation = location; worker.lastLocationAt = location.recordedAt; worker.shopsVisited = 0; worker.deliveredToday = 0;
  saveWorkers(); autoAssignPendingOrders();
  return res.json({ ok: true, message: 'Shift started. Location sharing is active while you are on shift.' });
});
app.post('/api/worker/shift/end', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker) return res.status(404).json({ error: 'Worker profile not found' });
  if (worker.activeDeliveryId) return res.status(409).json({ error: 'Complete the active delivery before ending your shift' });
  worker.onShift = false; worker.availability = 'offline'; worker.shiftEndedAt = new Date().toISOString(); worker.liveLocation = null;
  saveWorkers();
  return res.json({ ok: true, message: 'Shift ended. Live location sharing has stopped.' });
});
app.post('/api/worker/location', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  const location = validLocation(req.body.location);
  if (!worker || worker.onShift !== true) return res.status(409).json({ error: 'Start your shift before sharing location' });
  if (!location) return res.status(400).json({ error: 'Invalid location data' });
  worker.liveLocation = location; worker.lastLocationAt = location.recordedAt; saveWorkers();
  return res.json({ ok: true });
});
app.get('/api/worker/deliveries', authMiddleware(['worker']), (req, res) => {
  const orders = global.__orders.filter(o => o.workerId === req.user.id && ['assigned', 'out_for_delivery'].includes(o.deliveryStatus))
    .map(o => workerDeliveryDetails(o))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return res.json({ ok: true, deliveries: orders });
});

// BE: list orders that require BE verification (placed by shops)
app.get('/api/worker/verifications', authMiddleware(['worker']), (req, res) => {
  const pending = global.__orders.filter(o => o.reviewStatus && String(o.reviewStatus).toLowerCase().startsWith('pending'))
    .map(o => ({ id: o.id, createdAt: o.createdAt, customerName: o.customerName, customerPhone: o.customerPhone, product: o.product, productKey: o.productKey, quantity: o.quantity, unit: o.unit, total: o.total, address: o.address, area: o.area, city: o.city, pincode: o.pincode, deliveryDate: o.deliveryDate, deliverySlot: o.deliverySlot, notes: o.notes, beNotifiedAt: o.beNotifiedAt || null, beNotifiedCount: o.beNotifiedCount || 0 }));
  return res.json({ ok: true, verifications: pending });
});

// BE (worker) confirms a shop order after calling the shop owner
app.post('/api/worker/order/:id/verify', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker || worker.active === false || worker.approved !== true) return res.status(403).json({ error: 'Your worker account is not active' });
  if (worker.onShift !== true) return res.status(409).json({ error: 'Start your shift before verifying orders' });
  if (!hasFreshLiveLocation(worker)) return res.status(409).json({ error: 'Location must be current while on shift' });
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.adminReviewRequired || !String(order.reviewStatus).toLowerCase().includes('pending')) return res.status(409).json({ error: 'This order does not require BE verification' });
  const notes = String(req.body?.notes || '').trim();
  const voiceNote = req.body?.voiceNote;
  if (!voiceNote || typeof voiceNote !== 'string' || !voiceNote.startsWith('data:audio/')) return res.status(400).json({ error: 'A voice note recording is required for BE verification' });
  order.reviewStatus = 'verified_by_be'; order.adminReviewRequired = false; order.verifiedBy = req.user.id; order.verifiedByName = req.user.name || null; order.verifiedAt = new Date().toISOString();
  if (notes) order.beVerificationNotes = notes;
  order.beVerificationVoiceNotes = order.beVerificationVoiceNotes || [];
  order.beVerificationVoiceNotes.push({ id: generateId('AUD'), workerId: req.user.id, workerName: req.user.name, voiceNote, at: new Date().toISOString() });
  // optional: BE can mark payment while verifying
  const { paymentStatus, amount } = req.body || {};
  if (paymentStatus && ['paid','partial'].includes(String(paymentStatus).toLowerCase())) {
    if (String(paymentStatus).toLowerCase() === 'paid') { order.paymentStatus = 'paid'; order.advance = order.total; order.balance = 0; }
    else { const a = Number(amount) || Math.round(order.total * 0.25); order.advance = Math.min(order.total, Math.round(a)); order.balance = Math.max(0, order.total - order.advance); order.paymentStatus = order.advance >= order.total ? 'paid' : 'partial'; }
    addOrderEvent(order, 'payment_marked', 'Payment marked by BE during verification');
    audit(req.user.id, 'payment_marked_by_be', order.id, { paymentStatus: order.paymentStatus, advance: order.advance });
  }
  addOrderEvent(order, 'be_verified', 'Order verified by BE ' + (req.user.name || req.user.id));
  audit(req.user.id, 'be_verified', order.id, { notes: notes });
  saveOrders();
  try { notify(order.customerId, 'Your order ' + order.id + ' has been verified by our team and will be scheduled for delivery.', order.id); } catch (e) { }
  return res.json({ ok: true, order: { id: order.id, reviewStatus: order.reviewStatus, verifiedBy: order.verifiedBy, verifiedByName: order.verifiedByName, verifiedAt: order.verifiedAt } });
});
app.get('/api/worker/history', authMiddleware(['worker']), (req, res) => {
  const orders = global.__orders.filter(o => o.workerId === req.user.id && o.deliveryStatus === 'delivered')
    .map(o => workerDeliveryDetails(o, true))
    .sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt));
  return res.json({ ok: true, history: orders });
});
app.post('/api/worker/deliver/:id/start', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  const order = global.__orders.find(o => o.id === req.params.id && o.workerId === req.user.id);
  const location = validLocation(req.body.location);
  if (!worker || worker.onShift !== true) return res.status(409).json({ error: 'Start your shift before beginning a delivery' });
  if (!order || order.deliveryStatus !== 'assigned') return res.status(400).json({ error: 'This delivery cannot be started' });
  if (worker.activeDeliveryId) return res.status(409).json({ error: 'Complete your current delivery first' });
  if (!location) return res.status(400).json({ error: 'Your current GPS location is required to start a delivery. Enable location and try again.' });
  worker.liveLocation = location; worker.lastLocationAt = location.recordedAt;
  order.deliveryStatus = 'out_for_delivery'; order.deliveryStartedAt = new Date().toISOString(); order.deliveryStartLocation = location; addOrderEvent(order, 'out_for_delivery', 'Order is out for delivery'); worker.activeDeliveryId = order.id; worker.availability = 'delivering';
  saveOrders(); saveWorkers();
  return res.json({ ok: true, order: { id: order.id, deliveryStatus: order.deliveryStatus } });
});
app.post('/api/worker/deliver/:id/exception', authMiddleware(['worker']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.workerId === req.user.id);
  const reason = String(req.body.reason || '').trim();
  if (!order) return res.status(404).json({ error: 'Delivery not found' });
  if (!['assigned', 'out_for_delivery'].includes(order.deliveryStatus)) return res.status(409).json({ error: 'This delivery cannot be updated' });
  if (reason.length < 5 || reason.length > 500) return res.status(400).json({ error: 'Enter a delivery exception between 5 and 500 characters' });
  order.deliveryException = { reason, reportedAt: new Date().toISOString(), reportedBy: req.user.id, resolved: false }; addOrderEvent(order, 'exception', 'Delivery exception reported'); saveOrders(); notify(order.customerId, 'There is an update on your delivery. Our team will contact you shortly.', order.id);
  return res.json({ ok: true });
});
app.post('/api/worker/deliver/:id', authMiddleware(['worker']), async (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id && o.workerId === req.user.id);
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!order || !worker) return res.status(404).json({ error: 'Delivery not found or not assigned to you' });
  if (order.deliveryStatus !== 'out_for_delivery' || worker.activeDeliveryId !== order.id) return res.status(409).json({ error: 'Start this delivery before completing it' });
  if (worker.onShift !== true) return res.status(409).json({ error: 'Start your shift before completing a delivery' });
  if (!hasFreshLiveLocation(worker)) return res.status(409).json({ error: 'Location must be current while on shift' });
  const { photo, selfie, location, note, voiceNote } = req.body;
  if (!photo || !/^data:image\/jpeg;base64,/.test(photo) || photo.length > 8000000) return res.status(400).json({ error: 'A camera JPEG delivery photo (shop + face) is required' });
  if (!selfie || !/^data:image\/jpeg;base64,/.test(selfie) || selfie.length > 8000000) return res.status(400).json({ error: 'A camera JPEG selfie is required for face verification' });
  if (!voiceNote || typeof voiceNote !== 'string' || !voiceNote.startsWith('data:audio/')) return res.status(400).json({ error: 'A voice note recording is required to complete delivery' });
  const deliveryLocation = validLocation(location);
  if (!deliveryLocation) return res.status(400).json({ error: 'A fresh current GPS location is required to complete delivery. Enable location and try again.' });
  const enrollmentSelfie = worker.enrollmentSelfie;
  if (!enrollmentSelfie) return res.status(409).json({ error: 'Worker has no enrollment selfie on file. Contact admin.' });
  const faceResult = await compareFaces(enrollmentSelfie, selfie);
  const faceVerified = faceResult.matched;
  const faceSimilarity = faceResult.similarity;
  let gpsDistance = null; let gpsVerified = false;
  if (order.shopLatitude && order.shopLongitude) {
    const proximity = checkDeliveryProximity({ latitude: deliveryLocation.latitude, longitude: deliveryLocation.longitude }, { latitude: order.shopLatitude, longitude: order.shopLongitude }, 150);
    gpsDistance = proximity.distance; gpsVerified = proximity.withinRange;
  }
  const deliveryVerified = faceVerified && gpsVerified;
  const adminReviewRequired = !deliveryVerified;
  order.deliveryPhoto = photo; order.deliveryPhotoAt = new Date().toISOString();
  order.deliverySelfie = selfie; order.faceVerified = faceVerified;
  order.faceSimilarity = faceSimilarity; order.gpsDistance = gpsDistance;
  order.deliveryLocation = deliveryLocation; order.deliveryVerified = deliveryVerified;
  order.adminReviewRequired = adminReviewRequired;
  order.deliveryVoiceNotes = order.deliveryVoiceNotes || [];
  order.deliveryVoiceNotes.push({ id: generateId('AUD'), workerId: req.user.id, workerName: req.user.name, voiceNote, note: note || '', at: new Date().toISOString() });
  if (adminReviewRequired) {
    order.deliveryStatus = 'out_for_delivery'; order.reviewStatus = 'pending';
    order.reviewNotes = note || 'Auto-flagged: ' + (faceVerified ? 'Face OK' : 'Face: ' + faceSimilarity.toFixed(1) + '%') + ', ' + (gpsVerified ? 'GPS OK' : 'GPS: ' + (gpsDistance || 'N/A') + 'm');
    worker.availability = 'available'; worker.activeDeliveryId = null;
    saveOrders(); saveWorkers();
    return res.json({ ok: true, flagged: true, message: 'Delivery submitted for admin review.', order: { id: order.id, deliveryStatus: order.deliveryStatus, faceSimilarity, gpsDistance, adminReviewRequired: true } });
  }
  order.deliveryStatus = 'delivered'; order.deliveredAt = new Date().toISOString(); addOrderEvent(order, 'delivered', 'Delivery completed with proof');
  worker.liveLocation = deliveryLocation; worker.lastLocationAt = deliveryLocation.recordedAt;
  worker.activeDeliveryId = null; worker.availability = 'available';
  worker.shopsVisited = (worker.shopsVisited || 0) + 1; worker.deliveredToday = (worker.deliveredToday || 0) + 1;
  saveOrders(); saveWorkers(); autoAssignPendingOrders();
  return res.json({ ok: true, verified: true, order: { id: order.id, deliveryStatus: 'delivered', deliveredAt: order.deliveredAt, faceSimilarity, gpsDistance } });
});

// Worker: mark payment collected for an order (BE collects cash/UPI on verification)
app.post('/api/worker/order/:id/mark-payment', authMiddleware(['worker']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // only assigned worker or any BE when verifying shop orders can mark payment
  if (order.workerId && order.workerId !== req.user.id) return res.status(403).json({ error: 'Not assigned to you' });
  const { paymentStatus, amount } = req.body;
  if (!['paid','partial'].includes(String(paymentStatus || '').toLowerCase())) return res.status(400).json({ error: 'Invalid paymentStatus (paid|partial)' });
  if (String(paymentStatus).toLowerCase() === 'paid') {
    order.paymentStatus = 'paid'; order.advance = order.total; order.balance = 0;
  } else {
    const a = Number(amount) || Math.round(order.total * 0.25);
    order.advance = Math.min(order.total, Math.max(0, Math.round(a)));
    order.balance = Math.max(0, order.total - order.advance);
    order.paymentStatus = order.advance >= order.total ? 'paid' : 'partial';
  }
  addOrderEvent(order, 'payment_marked', 'Payment marked by BE ' + req.user.id);
  audit(req.user.id, 'payment_marked', order.id, { paymentStatus: order.paymentStatus, advance: order.advance, balance: order.balance });
  saveOrders();
  try { notify(order.customerId, 'Payment status updated for your order ' + order.id + '.'); } catch (e) {}
  return res.json({ ok: true, id: order.id, paymentStatus: order.paymentStatus, advance: order.advance, balance: order.balance });
});

// Generate a payment link + QR for an order (signed token)
app.get('/api/order/:id/payment-link', authMiddleware(['customer','shop','worker','admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // only admin or related customer/worker may request
  if (req.user.role !== 'admin' && order.customerId !== req.user.id && order.workerId !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  const token = jwt.sign({ orderId: order.id, amount: order.total }, JWT_SECRET, { expiresIn: '2h' });
  const link = `${req.protocol}://${req.get('host')}/pay?token=${token}`;
  const qr = `https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=${encodeURIComponent(link)}`;
  return res.json({ ok: true, link, token, qr });
});

// Public preview of a payment token (decodes token server-side without requiring auth)
app.get('/api/payment/preview', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const order = global.__orders.find(o => o.id === decoded.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const link = `${req.protocol}://${req.get('host')}/pay?token=${token}`;
    const qr = `https://chart.googleapis.com/chart?cht=qr&chs=300x300&chl=${encodeURIComponent(link)}`;
    return res.json({ ok: true, orderId: order.id, amount: decoded.amount || order.total, qr });
  } catch (e) { return res.status(400).json({ error: 'Invalid or expired token' }); }
});

// Create a sandbox payment session (demo provider)
app.post('/api/order/:id/create-payment', authMiddleware(['customer','shop','worker','admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const amount = Number(req.body?.amount || order.total || 0);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const sessionId = generateId('PAY');
  const token = jwt.sign({ orderId: order.id, amount, sessionId }, JWT_SECRET, { expiresIn: '2h' });
  const session = { id: sessionId, orderId: order.id, amount, token, provider: 'sandbox', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() };
  global.__paymentSessions.push(session); try { savePaymentSessions(); } catch (e) { console.warn('Failed to save payment-sessions.json', e); }
  const paymentUrl = `${req.protocol}://${req.get('host')}/sandbox/session/${sessionId}`;
  audit(req.user.id, 'sandbox_payment_session_created', order.id, { sessionId, amount });
  return res.json({ ok: true, paymentUrl, sessionId });
});

// Sandbox provider session UI (simple demo payment page)
app.get('/sandbox/session/:id', (req, res) => {
  const session = global.__paymentSessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).send('<h3>Payment session not found</h3>');
  const order = global.__orders.find(o => o.id === session.orderId) || { id: session.orderId, total: session.amount };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sandbox Payment</title><style>body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px} .card{max-width:700px;margin:auto;border:1px solid #ddd;padding:18px;border-radius:8px}</style></head><body><div class="card"><h2>Sandbox Payment Provider</h2><p>Order: <strong>${order.id}</strong></p><p>Amount: <strong>${session.amount}</strong></p><p>Provider: <strong>Sandbox (demo)</strong></p><div style="margin-top:18px"><button id="pay">Simulate Full Payment</button><button id="partial" style="margin-left:8px">Simulate Partial Payment</button></div><div id="res" style="margin-top:16px"></div></div><script>const sessionToken=${JSON.stringify(session.token)}; async function notify(status, amt){ document.getElementById('res').innerText='Processing...'; try{ const r = await fetch('/api/payment/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ token: sessionToken, paymentStatus: status, amount: amt })}); const j = await r.json(); document.getElementById('res').innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>'; }catch(e){ document.getElementById('res').innerText='Network error'; } } document.getElementById('pay').addEventListener('click', ()=> notify('paid', ${session.amount})); document.getElementById('partial').addEventListener('click', ()=> notify('partial', Math.max(1, Math.round(${session.amount}*0.25))));</script></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(html);
});

// Payment gateway/webhook: notify server about payment completion (accepts signed token)
app.post('/api/payment/notify', express.json({ limit: '1mb' }), (req, res) => {
  const { token, paymentStatus, amount } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const orderId = decoded.orderId;
    const order = global.__orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // validate amounts loosely
    const paid = Number(amount || decoded.amount || order.total);
    if (!Number.isFinite(paid) || paid <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (String(paymentStatus || '').toLowerCase() === 'paid' || paid >= order.total) {
      order.paymentStatus = 'paid'; order.advance = order.total; order.balance = 0;
    } else {
      order.advance = Math.min(order.total, Math.round(paid)); order.balance = Math.max(0, order.total - order.advance);
      order.paymentStatus = order.advance >= order.total ? 'paid' : 'partial';
    }
    addOrderEvent(order, 'payment_confirmed', 'Payment confirmed via gateway');
    audit('system', 'payment_confirmed', order.id, { paymentStatus: order.paymentStatus, amount: paid });
    saveOrders();
    try { notify(order.customerId, 'Payment received for order ' + order.id + '. Thank you!'); } catch (e) {}
    return res.json({ ok: true, id: order.id, paymentStatus: order.paymentStatus, advance: order.advance, balance: order.balance });
  } catch (e) { return res.status(400).json({ error: 'Invalid or expired token' }); }
});

// ========== ADMIN ORDER MANAGEMENT ==========
app.get('/api/admin/stats', authMiddleware(['admin']), (req, res) => {
  const o = global.__orders;
  const pendingBeVerifications = o.filter(x => x.reviewStatus && String(x.reviewStatus).toLowerCase().startsWith('pending_be')).length;
  return res.json({ ok: true, stats: { totalOrders: o.length, totalRevenue: o.reduce((s, x) => s + (x.total || 0), 0), totalAdvance: o.reduce((s, x) => s + (x.advance || 0), 0), totalBalance: o.reduce((s, x) => s + (x.balance || 0), 0), pendingDeliveries: o.filter(x => x.deliveryStatus !== 'delivered').length, deliveredCount: o.filter(x => x.deliveryStatus === 'delivered').length, paidOrders: o.filter(x => x.paymentStatus === 'paid').length, partialOrders: o.filter(x => x.paymentStatus === 'partial').length, pendingOrders: o.filter(x => x.paymentStatus === 'pending').length, workerCount: global.__workers.filter(w => w.active !== false).length, customerCount: global.__customers.filter(c => c.role === 'customer').length, pendingBeVerifications } });
});
app.get('/api/admin/delivery-overview', authMiddleware(['admin']), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const deliveries = global.__orders.map(order => {
    const worker = global.__workers.find(w => w.id === order.workerId);
    const liveLocation = hasFreshLiveLocation(worker) ? { ...worker.liveLocation, updatedAt: worker.lastLocationAt } : null;
    const scheduledToday = order.deliveryDate === today;
    const overdue = !!order.deliveryDate && order.deliveryDate < today && !['delivered', 'cancelled'].includes(order.deliveryStatus);
    const trackingStale = order.deliveryStatus === 'out_for_delivery' && !liveLocation;
    const needsAttention = overdue || trackingStale || (order.reviewStatus && String(order.reviewStatus).startsWith('pending')) || order.deliveryException?.resolved === false;
    return {
      id: order.id, batchId: order.batchId || null, product: order.product, quantity: order.quantity, unit: order.unit,
      customerName: order.customerName, customerPhone: order.customerPhone, address: order.address, area: order.area, city: order.city, pincode: order.pincode,
      deliveryStatus: order.deliveryStatus, deliveryDate: order.deliveryDate || null, deliverySlot: order.deliverySlot || null, workerId: order.workerId, workerName: order.workerName,
      assignedAt: order.assignedAt || null, deliveryStartedAt: order.deliveryStartedAt || null, deliveredAt: order.deliveredAt || null,
      deliveryVerified: order.deliveryVerified === true, reviewStatus: order.reviewStatus || 'none', deliveryPhoto: !!order.deliveryPhoto,
      liveLocation, overdue, trackingStale, deliveryException: order.deliveryException || null, needsAttention, scheduledToday
    };
  });
  const active = deliveries.filter(d => ['assigned', 'out_for_delivery'].includes(d.deliveryStatus));
  const attention = deliveries.filter(d => d.needsAttention);
  return res.json({ ok: true, summary: { active: active.length, outForDelivery: active.filter(d => d.deliveryStatus === 'out_for_delivery').length, attention: attention.length, scheduledToday: deliveries.filter(d => d.scheduledToday && !['delivered', 'cancelled'].includes(d.deliveryStatus)).length }, active, attention });
});
app.get('/api/admin/inventory', authMiddleware(['admin']), (req, res) => {
  return res.json({ ok: true, inventory: Object.keys(PRICES).map(key => ({ key, name: PRODUCT_NAMES[key], stock: Math.max(0, Number(global.__inventory[key] || 0)), unit: UNIT[key] })) });
});
app.patch('/api/admin/order/:id/exception', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order || !order.deliveryException) return res.status(404).json({ error: 'Delivery exception not found' });
  order.deliveryException.resolved = true; order.deliveryException.resolvedAt = new Date().toISOString(); order.deliveryException.resolvedBy = req.user.id; addOrderEvent(order, 'exception_resolved', 'Delivery exception resolved by admin'); saveOrders(); notify(order.customerId, 'Your delivery issue has been reviewed by our team.', order.id);
  return res.json({ ok: true });
});
app.get('/api/admin/support', authMiddleware(['admin']), (req, res) => {
  return res.json({ ok: true, tickets: [...global.__tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});
app.get('/api/admin/damage-claims', authMiddleware(['admin']), (req, res) => {
  const claims = global.__orders.filter(o => o.damageClaim).map(o => ({ id: o.id, customerName: o.customerName, product: o.product, total: o.total, paymentStatus: o.paymentStatus, damageClaim: o.damageClaim, deliveredAt: o.deliveredAt }));
  return res.json({ ok: true, claims });
});
app.patch('/api/admin/damage-claims/:id', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id); const status = req.body.status;
  if (!order || !order.damageClaim) return res.status(404).json({ error: 'Damage claim not found' });
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid claim status' });
  order.damageClaim.status = status; order.damageClaim.reviewedAt = new Date().toISOString(); order.damageClaim.reviewedBy = req.user.id;
  if (status === 'approved') { order.refundEligible = true; order.refundStatus = 'manual_review'; }
  addOrderEvent(order, 'damage_claim_' + status, 'Damaged-product claim ' + status); saveOrders(); notify(order.customerId, 'Your damaged-product claim for order ' + order.id + ' was ' + status + '.', order.id);
  return res.json({ ok: true, order: { id: order.id, damageClaim: order.damageClaim, refundEligible: order.refundEligible, refundStatus: order.refundStatus } });
});
app.patch('/api/admin/support/:id', authMiddleware(['admin']), (req, res) => {
  const ticket = global.__tickets.find(t => t.id === req.params.id); const status = req.body.status;
  if (!ticket) return res.status(404).json({ error: 'Support ticket not found' });
  if (!['open', 'in_progress', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid support status' });
  ticket.status = status; ticket.updatedAt = new Date().toISOString(); ticket.updatedBy = req.user.id; saveTickets(); notify(ticket.customerId, 'Your support request ' + ticket.id + ' is now ' + status.replace('_', ' ') + '.', ticket.orderId);
  return res.json({ ok: true, ticket });
});
app.patch('/api/admin/inventory/:product', authMiddleware(['admin']), (req, res) => {
  const product = req.params.product; const stock = Number(req.body.stock);
  if (!Object.hasOwn(PRICES, product)) return res.status(400).json({ error: 'Invalid product' });
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return res.status(400).json({ error: 'Stock must be a whole number between 0 and 100000' });
  global.__inventory[product] = stock; saveInventory();
  return res.json({ ok: true, product, stock });
});
app.get('/api/admin/orders', authMiddleware(['admin']), (req, res) => {
  const { status, payment, worker, search } = req.query;
  let orders = [...global.__orders];
  if (status && status !== 'all') orders = orders.filter(o => o.deliveryStatus === status);
  if (payment && payment !== 'all') orders = orders.filter(o => o.paymentStatus === payment);
  if (worker && worker !== 'all') orders = orders.filter(o => o.workerId === worker);
  if (search) { const q = search.toLowerCase(); orders = orders.filter(o => o.id.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q) || o.address.toLowerCase().includes(q) || o.product.toLowerCase().includes(q)); }
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ ok: true, orders: orders.map(o => ({ ...o, deliveryPhoto: !!o.deliveryPhoto })), total: orders.length });
});

// Admin: audit of BE verifications (who verified which order)
app.get('/api/admin/verification-audit', authMiddleware(['admin']), (req, res) => {
  const audit = global.__orders.filter(o => o.verifiedAt).map(o => ({ id: o.id, verifiedBy: o.verifiedBy, verifiedByName: o.verifiedByName || null, verifiedAt: o.verifiedAt, notes: o.beVerificationNotes || null }));
  return res.json({ ok: true, audit });
});

// Admin: system audit log (recent entries)
app.get('/api/admin/audit-log', authMiddleware(['admin']), (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));
  const entries = Array.isArray(global.__auditLog) ? [...global.__auditLog].sort((a,b) => new Date(b.at) - new Date(a.at)).slice(0, limit) : [];
  return res.json({ ok: true, entries, total: entries.length });
});
app.get('/api/admin/order/:id', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const worker = global.__workers.find(w => w.id === order.workerId);
  const liveLocation = hasFreshLiveLocation(worker) ? { ...worker.liveLocation, updatedAt: worker.lastLocationAt } : null;
  return res.json({ ok: true, order: { ...order, liveLocation } });
});
app.patch('/api/admin/order/:id/assign', authMiddleware(['admin']), (req, res) => {
  const { workerId } = req.body; const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const worker = global.__workers.find(w => w.id === workerId);
  if (!worker || worker.active === false || worker.approved !== true || worker.onShift !== true || worker.availability === 'offline') return res.status(409).json({ error: 'Select a worker who is active and currently on shift' });
  order.workerId = worker.id; order.workerName = worker.name; order.deliveryStatus = 'assigned'; order.assignedAt = new Date().toISOString(); worker.lastAssignedAt = order.assignedAt; saveOrders(); saveWorkers();
  return res.json({ ok: true, order: { id: order.id, workerId, workerName: worker.name, deliveryStatus: 'assigned' } });
});
app.patch('/api/admin/order/:id/payment', authMiddleware(['admin']), (req, res) => {
  const { paymentStatus } = req.body; const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending', 'partial', 'paid'].includes(paymentStatus)) return res.status(400).json({ error: 'Invalid payment status' });
  if (paymentStatus === 'paid') { order.advance = order.total; order.balance = 0; }
  else if (paymentStatus === 'partial' && order.paymentStatus === 'pending') { const a = Math.round(order.total * 0.25); order.advance = a; order.balance = order.total - a; }
  order.paymentStatus = paymentStatus; saveOrders();
  return res.json({ ok: true, order: { id: order.id, paymentStatus } });
});
app.patch('/api/admin/order/:id/delivery-status', authMiddleware(['admin']), (req, res) => {
  const { deliveryStatus } = req.body; const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['pending', 'assigned'].includes(deliveryStatus)) return res.status(400).json({ error: 'Only a worker with photo proof can complete a delivery' });
  order.deliveryStatus = deliveryStatus; saveOrders();
  return res.json({ ok: true, order: { id: order.id, deliveryStatus } });
});
app.patch('/api/admin/order/:id/notes', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.notes = (req.body.notes || ''); saveOrders();
  return res.json({ ok: true });
});

// Admin can re-notify all BEs about an order requiring BE verification
app.post('/api/admin/order/:id/notify-bes', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const last = order.beNotifiedAt ? new Date(order.beNotifiedAt).getTime() : 0;
    if (!last || Date.now() - last > 5 * 60 * 1000) {
      for (const w of global.__workers) {
        try { notifyWorker(w.id, `Order ${order.id} requires BE verification`, order.id); } catch (e) { }
      }
      order.beNotifiedAt = new Date().toISOString();
      order.beNotifiedCount = global.__workers.length;
      saveOrders(); saveNotifications();
      return res.json({ ok: true, notified: order.beNotifiedAt });
    }
    return res.json({ ok: true, notified: order.beNotifiedAt, message: 'Recently notified — rate-limited' });
  } catch (e) { return res.status(500).json({ error: 'Failed to notify BEs' }); }
});
app.get('/api/admin/order/:id/photo', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.deliveryPhoto) return res.status(404).json({ error: 'No delivery photo' });
  return res.json({ ok: true, photo: order.deliveryPhoto, deliveredAt: order.deliveredAt });
});

// ========== ADMIN REVIEW QUEUE ==========
app.get('/api/admin/reviews', authMiddleware(['admin']), (req, res) => {
  const reviews = global.__orders.filter(o => o.adminReviewRequired === true && o.reviewStatus === 'pending').map(o => ({
    id: o.id, customerName: o.customerName, customerPhone: o.customerPhone,
    product: o.product, quantity: o.quantity, unit: o.unit,
    address: o.address, area: o.area,
    deliveryPhoto: o.deliveryPhoto, deliverySelfie: o.deliverySelfie,
    faceSimilarity: o.faceSimilarity, faceVerified: o.faceVerified,
    gpsDistance: o.gpsDistance, deliveryLocation: o.deliveryLocation,
    shopLatitude: o.shopLatitude, shopLongitude: o.shopLongitude,
    reviewNotes: o.reviewNotes, reviewStatus: o.reviewStatus,
    workerId: o.workerId, workerName: o.workerName, createdAt: o.createdAt
  }));
  return res.json({ ok: true, reviews });
});
app.post('/api/admin/review/:id/approve', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const worker = global.__workers.find(w => w.id === order.workerId);
  order.deliveryStatus = 'delivered'; order.deliveredAt = new Date().toISOString();
  order.reviewStatus = 'approved'; order.reviewedAt = new Date().toISOString(); order.reviewedBy = req.user.id;
  order.reviewNotes = (req.body.notes || order.reviewNotes || '') + ' [Approved by admin]';
  if (worker) {
    worker.shopsVisited = (worker.shopsVisited || 0) + 1; worker.deliveredToday = (worker.deliveredToday || 0) + 1;
  }
  saveOrders(); saveWorkers();
  return res.json({ ok: true, approved: true, order: { id: order.id, deliveryStatus: 'delivered', deliveredAt: order.deliveredAt } });
});
app.post('/api/admin/review/:id/reject', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const worker = global.__workers.find(w => w.id === order.workerId);
  order.reviewStatus = 'rejected'; order.reviewedAt = new Date().toISOString(); order.reviewedBy = req.user.id;
  order.reviewNotes = (req.body.notes || order.reviewNotes || '') + ' [Rejected by admin]';
  order.deliveryStatus = 'pending'; order.workerId = null; order.workerName = null;
  if (worker) { worker.activeDeliveryId = null; worker.availability = 'available'; }
  saveOrders(); saveWorkers(); autoAssignPendingOrders();
  return res.json({ ok: true, rejected: true, order: { id: order.id, deliveryStatus: 'pending', reAssigned: true } });
});
app.get('/api/admin/review/:id/selfie', authMiddleware(['admin']), (req, res) => {
  const order = global.__orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.deliverySelfie) return res.status(404).json({ error: 'No delivery selfie available' });
  return res.json({ ok: true, selfie: order.deliverySelfie, faceSimilarity: order.faceSimilarity, faceVerified: order.faceVerified });
});

// ========== WORKER SELFIE MANAGEMENT ==========
app.post('/api/admin/worker/:id/selfie', authMiddleware(['admin']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  const { selfie } = req.body;
  if (!selfie || !/^data:image\/jpeg;base64,/.test(selfie) || selfie.length > 8000000) return res.status(400).json({ error: 'A valid JPEG selfie is required' });
  worker.enrollmentSelfie = selfie; worker.selfieUpdatedAt = new Date().toISOString(); saveWorkers();
  return res.json({ ok: true, selfieUpdated: true, message: 'Enrollment selfie saved for face comparison at delivery time.' });
});
app.get('/api/worker/selfie/status', authMiddleware(['worker']), (req, res) => {
  const worker = global.__workers.find(w => w.id === req.user.id);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });
  return res.json({ ok: true, hasSelfie: !!worker.enrollmentSelfie, selfieUpdatedAt: worker.selfieUpdatedAt || null });
});

// ========== EXPORTS ==========
app.get('/api/admin/export/orders', authMiddleware(['admin']), (req, res) => {
  const orders = global.__orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const data = orders.map((o, i) => ({
    '#': i + 1, 'Order ID': o.id, 'Date': new Date(o.createdAt).toLocaleDateString('en-IN'),
    'Customer Name': o.customerName || '-', 'Customer Phone': o.customerPhone || '-',
    'Product': o.product, 'Quantity': `${o.quantity} ${o.unit}${o.quantity > 1 ? 's' : ''}`,
    'Unit Price': '\u20B9' + o.unitPrice, 'Total': '\u20B9' + o.total, 'Advance Paid': '\u20B9' + o.advance, 'Balance Due': '\u20B9' + o.balance,
    'Payment Status': o.paymentStatus.charAt(0).toUpperCase() + o.paymentStatus.slice(1),
    'Delivery Status': o.deliveryStatus.charAt(0).toUpperCase() + o.deliveryStatus.slice(1),
    'Address': o.address, 'Area': o.area, 'Pincode': o.pincode, 'City': o.city, 'State': o.state,
    'Delivery Date': o.deliveryDate || '-', 'Assigned Worker': o.workerName || '-',
    'Delivered At': o.deliveredAt ? new Date(o.deliveredAt).toLocaleString('en-IN') : '-', 'Notes': o.notes || '-',
    'Face Verified': o.faceVerified ? 'Yes' : o.faceSimilarity ? o.faceSimilarity.toFixed(0) + '%' : 'N/A',
    'GPS Distance': o.gpsDistance ? o.gpsDistance + 'm' : 'N/A', 'Admin Review': o.reviewStatus
  }));
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  ws['!cols'] = Object.keys(data[0] || {}).map(k => ({ wch: Math.max(k.length, 12) }));
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=UrbanFarms_Orders_${new Date().toISOString().slice(0,10)}.xlsx`);
  res.send(buffer);
});

// ========== EXPORT WORKERS ==========
app.get('/api/admin/export/workers', authMiddleware(['admin']), (req, res) => {
  const workers = global.__workers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const data = workers.map((w, i) => ({
    '#': i + 1, 'Worker ID': w.id, 'Name': w.name, 'Phone': w.phone,
    'Status': w.active !== false ? 'Active' : 'Inactive', 'Created At': new Date(w.createdAt).toLocaleDateString('en-IN'),
    'Delivered Orders': (global.__orders || []).filter(o => o.workerId === w.id && o.deliveryStatus === 'delivered').length,
    'Assigned Orders': (global.__orders || []).filter(o => o.workerId === w.id && o.deliveryStatus === 'assigned').length,
    'Has Selfie': w.enrollmentSelfie ? 'Yes' : 'No'
  }));
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Workers');
  ws['!cols'] = Object.keys(data[0] || {}).map(k => ({ wch: Math.max(k.length, 12) }));
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=UrbanFarms_Workers_${new Date().toISOString().slice(0,10)}.xlsx`);
  res.send(buffer);
});

// ========== EXPORT CUSTOMERS ==========
app.get('/api/admin/export/customers', authMiddleware(['admin']), (req, res) => {
  const customers = global.__customers.filter(c => c.role === 'customer').map(c => {
    const custOrders = global.__orders.filter(o => o.customerId === c.id);
    return { 'Name': c.name, 'Phone': c.phone, 'Registered': new Date(c.createdAt).toLocaleDateString('en-IN'), 'Total Orders': custOrders.length, 'Total Spent': custOrders.reduce((s, o) => s + (o.total || 0), 0), 'Paid Orders': custOrders.filter(o => o.paymentStatus === 'paid').length };
  }).sort((a, b) => b['Total Spent'] - a['Total Spent']);
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(customers);
  XLSX.utils.book_append_sheet(wb, ws, 'Customers');
  ws['!cols'] = Object.keys(customers[0] || {}).map(k => ({ wch: Math.max(k.length, 14) }));
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=UrbanFarms_Customers_${new Date().toISOString().slice(0,10)}.xlsx`);
  res.send(buffer);
});

app.listen(PORT, () => { console.log(`[Urban Farms] Server running → http://localhost:${PORT}`); });
