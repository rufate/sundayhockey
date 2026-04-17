const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Database setup
const HAS_DB = !!process.env.DATABASE_URL;

// IMPORTANT: Render (and many hosts) will NOT have Postgres listening on localhost.
// If DATABASE_URL is not set, we run in "file mode" and skip all DB calls.
const pool = HAS_DB ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 5),
    min: 0,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 10000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
    maxUses: Number(process.env.PG_MAX_USES || 5000),
    keepAlive: true,
    keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_INITIAL_DELAY_MS || 10000),
    allowExitOnIdle: true,
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 8000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 8000)
}) : null;

const STRICT_DATABASE_MODE = HAS_DB && String(process.env.STRICT_DATABASE_MODE || 'true').toLowerCase() !== 'false';
const DB_GUARD_RETRIES = Math.max(1, Number(process.env.DB_GUARD_RETRIES || 3));
const DB_GUARD_RETRY_DELAY_MS = Math.max(250, Number(process.env.DB_GUARD_RETRY_DELAY_MS || 1500));
const DB_GUARD_PATH_EXCLUSIONS = new Set([
    '/api/verify-code',
    '/api/register-init',
    '/api/admin/check-session',
    '/api/admin/login',
    '/api/admin/logout',
    '/api/admin/logout-all',
    '/api/admin/players',
    '/api/admin/players-full',
    '/api/admin/settings',
    '/api/admin/app-settings',
    '/api/admin/download-backup'
]);

function shouldEnforceDurableMutation(req) {
    if (!STRICT_DATABASE_MODE || !HAS_DB) return false;
    const method = String(req.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
    const pathValue = String(req.path || req.originalUrl || '').split('?')[0];
    if (!pathValue.startsWith('/api/')) return false;
    if (DB_GUARD_PATH_EXCLUSIONS.has(pathValue)) return false;
    return true;
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pingDatabaseWithRetry(retries = DB_GUARD_RETRIES, delayMs = DB_GUARD_RETRY_DELAY_MS) {
    let last = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const result = await pingDatabase();
        last = result;
        if (result.ok || result.mode === 'file') {
            return { ...result, attempt };
        }
        if (attempt < retries) await waitMs(delayMs);
    }
    return { ...(last || { ok: false, mode: 'postgres', error: 'Database unavailable' }), attempt: retries };
}


if (pool) {
    // Handle pool errors
    pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err.message);
    });

    // Log connection events in development
    if (process.env.NODE_ENV !== 'production') {
        pool.on('connect', () => {
            console.log('New PostgreSQL connection created. Total:', pool.totalCount);
        });
        pool.on('remove', () => {
            console.log('PostgreSQL connection removed. Total:', pool.totalCount);
        });
    }
}

async function pingDatabase() {
    if (!pool) {
        return { ok: false, mode: 'file', latencyMs: null };
    }

    const startedAt = Date.now();
    try {
        await pool.query('SELECT 1');
        consecutiveDbFailures = 0;
        return { ok: true, mode: 'postgres', latencyMs: Date.now() - startedAt };
    } catch (err) {
        consecutiveDbFailures += 1;
        console.error('Database ping failed:', err.message);
        return { ok: false, mode: 'postgres', latencyMs: Date.now() - startedAt, error: err.message };
    }
}

// Middleware
const apiLimiterConfig = {
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
};

const verifyCodeLimiter = rateLimit({
    ...apiLimiterConfig,
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RL_VERIFY_CODE_MAX || 12)
});

const adminLoginLimiter = rateLimit({
    ...apiLimiterConfig,
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RL_ADMIN_LOGIN_MAX || 8)
});

const cancelRegistrationLimiter = rateLimit({
    ...apiLimiterConfig,
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RL_CANCEL_MAX || 8)
});

const registrationLimiter = rateLimit({
    ...apiLimiterConfig,
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.RL_REGISTRATION_MAX || 16)
});

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.static('public'));

function shouldTriggerSchedulerOnRequest(req) {
    const method = String(req.method || '').toUpperCase();
    if (!['GET', 'HEAD', 'POST'].includes(method)) return false;

    const url = String(req.path || req.originalUrl || '').toLowerCase();
    if (!url || url === '/favicon.ico') return false;

    // Skip obvious static assets. HTML routes and API routes should still trigger catch-up logic.
    if (/\.(css|js|map|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot)$/i.test(url)) return false;

    return true;
}


async function durableMutationGuardMiddleware(req, res, next) {
    if (!shouldEnforceDurableMutation(req)) {
        next();
        return;
    }

    try {
        const db = await pingDatabaseWithRetry();
        if (db.ok || db.mode === 'file') {
            next();
            return;
        }

        res.status(503).json({
            error: 'Database is temporarily unavailable. No changes were saved. Please try again in a moment.',
            code: 'DATABASE_UNAVAILABLE',
            database: db,
            strictDatabaseMode: STRICT_DATABASE_MODE
        });
    } catch (err) {
        res.status(503).json({
            error: 'Database check failed. No changes were saved. Please try again in a moment.',
            code: 'DATABASE_CHECK_FAILED',
            detail: err && err.message ? err.message : 'Unknown database check error',
            strictDatabaseMode: STRICT_DATABASE_MODE
        });
    }
}

async function schedulerCatchupMiddleware(req, res, next) {
    if (!shouldTriggerSchedulerOnRequest(req)) {
        next();
        return;
    }

    try {
        await runSchedulerTick();
        maybeRunRequestSelfHeal(req);
        maybeSnapshotOnRequest(req);
    } catch (err) {
        console.error('Request scheduler catch-up error:', err);
    }

    next();
}

app.use(durableMutationGuardMiddleware);
app.use(schedulerCatchupMiddleware);

// --- DATA STORE ---
let playerSpots = 20;
let players = []; 
let waitlist = [];
let cancelledRegistrations = [];
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_TOKEN_SECRET = String(process.env.ADMIN_TOKEN_SECRET || '').trim() || crypto.randomBytes(48).toString('hex');
if (!String(process.env.ADMIN_TOKEN_SECRET || '').trim()) {
    console.warn('ADMIN_TOKEN_SECRET is not configured. Using an ephemeral secret for this server process.');
}
const ADMIN_REMEMBER_TOKEN_TTL_DAYS = Number(process.env.ADMIN_TOKEN_TTL_DAYS || 30);
const ADMIN_SESSION_TOKEN_TTL_HOURS = Number(process.env.ADMIN_SESSION_HOURS || 12);
const ADMIN_SESSION_FILE = './admin-sessions.json';

// Game details - FRIDAY HOCKEY
let gameLocation = "Capri Recreation Complex";
let gameTime = "Friday 9:30 PM";
let gameDate = "";

// ---- Game-day helpers (dynamic Friday/Sunday etc.) ----

const MAX_ANNOUNCEMENT_IMAGE_BYTES = 900 * 1024;
const MAX_ANNOUNCEMENT_IMAGES = 1;
const ALLOWED_ANNOUNCEMENT_IMAGE_PREFIXES = [
    'data:image/jpeg;base64,',
    'data:image/jpg;base64,',
    'data:image/png;base64,',
    'data:image/webp;base64,'
];

function normalizeAnnouncementImages(input) {
    if (!Array.isArray(input)) return [];
    const normalized = [];

    for (const raw of input.slice(0, MAX_ANNOUNCEMENT_IMAGES)) {
        const value = String(raw || '').trim();
        if (!value) continue;

        const lower = value.toLowerCase();
        const isAllowed = ALLOWED_ANNOUNCEMENT_IMAGE_PREFIXES.some(prefix => lower.startsWith(prefix));
        if (!isAllowed) continue;

        const commaIndex = value.indexOf(',');
        if (commaIndex === -1) continue;

        const base64Part = value.slice(commaIndex + 1).replace(/\s+/g, '');
        const byteLength = Buffer.byteLength(base64Part, 'base64');
        if (!byteLength || byteLength > MAX_ANNOUNCEMENT_IMAGE_BYTES) {
            throw new Error('Announcement image is too large. Please use a smaller image.');
        }

        normalized.push(value);
    }

    return normalized;
}

async function saveAppSetting(key, value) {
    if (pool) {
        await pool.query(
            'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, value]
        );
        return;
    }

    const payload = fs.existsSync(DATA_FILE)
        ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
        : {};

    payload[key] = value;
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    writeSettingsBackup(`app-setting:${key}`);
}

const DAY_NAME_TO_INDEX = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6
};
const INDEX_TO_DAY_NAME = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function parseGameTimeString(gameTimeStr) {
    // Expected formats: "Friday 9:30 PM", "Sunday 10:00 AM"
    const m = String(gameTimeStr || "").trim().match(/^([A-Za-z]+)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (!m) {
        return { dayName: "Friday", dayIndex: 5, hour24: 21, minute: 30 }; // safe fallback
    }
    const dayNameRaw = m[1].toLowerCase();
    const dayIndex = DAY_NAME_TO_INDEX[dayNameRaw] ?? 5;
    const hour12 = parseInt(m[2], 10);
    const minute = m[3] ? parseInt(m[3], 10) : 0;
    const ampm = m[4].toUpperCase();
    let hour24 = hour12 % 12;
    if (ampm === "PM") hour24 += 12;
    return { dayName: INDEX_TO_DAY_NAME[dayIndex], dayIndex, hour24, minute };
}

function getGameDayName() {
    return parseGameTimeString(gameTime).dayName;
}


const FRIDAY_SIGNUP_CODE = '9855';
const SUNDAY_SIGNUP_CODE = '7666';
const DEFAULT_SIGNUP_CODE = FRIDAY_SIGNUP_CODE;
let customSignupCode = '';

function getDynamicSignupCode(dayName = getGameDayName()) {
    const custom = String(customSignupCode || '').trim();
    if (/^\d{4}$/.test(custom)) return custom;

    const day = String(dayName || '').trim().toLowerCase();
    if (day === 'friday') return FRIDAY_SIGNUP_CODE;
    if (day === 'sunday') return SUNDAY_SIGNUP_CODE;
    return DEFAULT_SIGNUP_CODE;
}

function refreshDynamicSignupCode() {
    playerSignupCode = getDynamicSignupCode();
    return playerSignupCode;
}

function calculateNextGameDate() {
    // Calculate next occurrence of the configured game day/time in America/New_York
    const now = new Date();
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const { dayIndex, hour24, minute } = parseGameTimeString(gameTime);

    const currentDow = etNow.getDay();
    let daysAhead = (dayIndex - currentDow + 7) % 7;

    // If it's the same day but already past game time, move to next week
    const pastGameTimeToday =
        daysAhead === 0 &&
        (etNow.getHours() > hour24 || (etNow.getHours() === hour24 && etNow.getMinutes() >= minute));

    if (pastGameTimeToday) daysAhead = 7;

    const next = new Date(etNow);
    next.setDate(etNow.getDate() + daysAhead);
    return next.toISOString().split("T")[0];
}

// Player signup password protection - dynamic by game day
let playerSignupCode = DEFAULT_SIGNUP_CODE;
let requirePlayerCode = true;
let manualOverride = false;
let manualOverrideState = null;

// Exact schedule timestamps saved from admin (ET wall-clock strings)
let signupLockStartAt = '';
let signupLockEndAt = '';
let rosterReleaseAt = '';
let resetWeekAt = '';
let lastExactResetRunAt = '';
let lastExactRosterReleaseRunAt = '';
let lastExactResetMinuteKey = '';
let lastExactRosterReleaseMinuteKey = '';

const AUTO_BUILD_WEEKLY_SCHEDULES_FROM_GAMETIME = true;
const AUTO_SCHEDULE_LOCK_HOUR = 17;
const AUTO_SCHEDULE_LOCK_MINUTE = 0;
const AUTO_SCHEDULE_RESET_HOUR = 0;
const AUTO_SCHEDULE_RESET_MINUTE = 0;

// Admin-configurable schedules (interpreted in America/New_York, repeats weekly)
let signupLockSchedule = {
    enabled: false,
    start: null,
    end: null
};

let rosterReleaseSchedule = {
    enabled: false,
    at: null
};

let resetWeekSchedule = {
    enabled: false,
    at: null
};



function hasConfiguredAdminPassword() {
    return !!ADMIN_PASSWORD;
}

function isValidAdminPassword(password) {
    return hasConfiguredAdminPassword() && String(password || '').trim() === ADMIN_PASSWORD;
}

let adminSessionState = {
    revokedJtis: {},
    logoutAllAfter: 0,
    audit: []
};

function loadAdminSessionState() {
    try {
        if (!fs.existsSync(ADMIN_SESSION_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ADMIN_SESSION_FILE, 'utf8'));
        if (raw && typeof raw === 'object') {
            adminSessionState = {
                revokedJtis: raw.revokedJtis || {},
                logoutAllAfter: Number(raw.logoutAllAfter || 0),
                audit: Array.isArray(raw.audit) ? raw.audit.slice(-200) : []
            };
        }
    } catch (err) {
        console.error('Error loading admin session state:', err.message);
    }
}

function saveAdminSessionState() {
    try {
        fs.writeFileSync(ADMIN_SESSION_FILE, JSON.stringify(adminSessionState, null, 2));
    } catch (err) {
        console.error('Error saving admin session state:', err.message);
    }
}

function pruneAdminSessionState() {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of Object.entries(adminSessionState.revokedJtis || {})) {
        if (!exp || Number(exp) < nowSec) delete adminSessionState.revokedJtis[jti];
    }
    adminSessionState.audit = (adminSessionState.audit || []).slice(-200);
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function addAdminAuditEntry(action, req, details = {}) {
    try {
        const entry = {
            at: new Date().toISOString(),
            action,
            ip: req ? getClientIp(req) : 'server',
            ua: req?.headers?.['user-agent'] || '',
            details
        };
        adminSessionState.audit = Array.isArray(adminSessionState.audit) ? adminSessionState.audit : [];
        adminSessionState.audit.push(entry);
        pruneAdminSessionState();
        saveAdminSessionState();
    } catch (err) {
        console.error('Error writing admin audit entry:', err.message);
    }
}

function decodeAdminSession(token) {
    const value = String(token || '').trim();
    if (!value) return null;
    try {
        const decoded = jwt.verify(value, ADMIN_TOKEN_SECRET);
        return decoded && decoded.role === 'admin' ? decoded : null;
    } catch (err) {
        return null;
    }
}

function createAdminSessionToken(rememberMe = true) {
    const jti = crypto.randomUUID();
    const remember = !!rememberMe;
    const expiresIn = remember ? `${ADMIN_REMEMBER_TOKEN_TTL_DAYS}d` : `${ADMIN_SESSION_TOKEN_TTL_HOURS}h`;
    return jwt.sign(
        { role: 'admin', jti, remember },
        ADMIN_TOKEN_SECRET,
        { expiresIn }
    );
}

function getAdminAuthToken(req) {
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';

    return (
        req.headers['x-admin-auth'] ||
        req.headers['x-admin-token'] ||
        req.headers['x-admin-password'] ||
        bearerToken ||
        (req.body && (req.body.sessionToken || req.body.password)) ||
        (req.query && (req.query.sessionToken || req.query.password)) ||
        ''
    );
}

function isValidAdminSession(token) {
    const decoded = decodeAdminSession(token);
    if (!decoded) return false;
    if (decoded.jti && adminSessionState.revokedJtis && adminSessionState.revokedJtis[decoded.jti]) return false;
    if (adminSessionState.logoutAllAfter && decoded.iat && decoded.iat < Number(adminSessionState.logoutAllAfter)) return false;
    return true;
}

function isAuthorizedAdminRequest(req) {
    const token = getAdminAuthToken(req);
    if (isValidAdminSession(token)) return true;
    return isValidAdminPassword(token);
}

// Store admin sessions
let adminSessions = {};
loadAdminSessionState();
pruneAdminSessionState();
saveAdminSessionState();

// Weekly reset tracking
let lastResetWeek = null;
let rosterReleased = false;
let resetArmed = false;
let currentWeekData = {
    weekNumber: null,
    year: null,
    releaseDate: null,
    rosterReleaseTime: null,
    whiteTeam: [],
    darkTeam: []
};

const MAX_GOALIES = 2;
const NO_SHOW_POLICY_TEXT = 'Cancellation must be done prior to roster release. Late cancel / no-show owes.';

const GAME_RULES = [
    "No contact. Board tie-ups only.",
    "No slashing. Lift sticks. Injury = done + possible ban.",
    "Move the puck. Don’t hog it.",
    "Control slapshots. Head shots = no more slapshots.",
    "Short shifts. Be fair with ice time.",
    "No negativity. Keep it positive.",
    "Skate hard, change often.",
    "No excessive aggression. It’s pickup.",
    "Don’t be “that guy.” You know who you are.",
    "Handshake/fist bump after the game. Have fun.",
    "Cancellation must be done prior to roster release. This gives waitlist players a chance for a spot. No-show owes.",
    "Respect the game and players — or you’re done."
];

// ============================================
// NEW CONFIGURATION SECTION - ADD THESE HERE
// ============================================

// --- AUTO-ADD PLAYERS CONFIG ---
const AUTO_ADD_CORE_PLAYERS = [
    {
        firstName: "Phan",
        lastName: "Ly",
        phone: "(519) 566-9288",
        rating: 6,
        isGoalie: false,
        isFree: true,
        paymentMethod: "FREE",
        protected: true  // Cannot be cancelled from signup page
    }
];

const REGULAR_GOALIES_BY_DAY = {
    friday: [
        {
            firstName: "Craig",
            lastName: "Scolack",
            phone: "(519) 982-6311",
            rating: 9,
            isGoalie: true,
            isFree: false,
            paymentMethod: "N/A"
        },
        {
            firstName: "Hao",
            lastName: "Chau",
            phone: "(519) 995-9884",
            rating: 8,
            isGoalie: true,
            isFree: false,
            paymentMethod: "N/A"
        }
    ],
    sunday: [
        {
            firstName: "Craig",
            lastName: "Scolack",
            phone: "(519) 982-6311",
            rating: 9,
            isGoalie: true,
            isFree: false,
            paymentMethod: "N/A"
        },
        {
            firstName: "Mat",
            lastName: "Carriere",
            phone: "(226) 350-0217",
            rating: 7,
            isGoalie: true,
            isFree: false,
            paymentMethod: "N/A"
        }
    ]
};

// --- REGULAR SKATERS FOR WEEKLY RESET AUTO-ADD ---
// Supported keys: everyday, friday, sunday, wednesday, saturday, etc.
// protected: false is recommended for most regulars so they can still cancel from the signup page.
const DEFAULT_REGULAR_SKATERS_BY_DAY = {
    everyday: [],
    friday: [],
    sunday: []
};

let regularSkatersByDay = JSON.parse(JSON.stringify(DEFAULT_REGULAR_SKATERS_BY_DAY));

function normalizeRegularSkaterEntry(input = {}) {
    const firstName = String(input.firstName || '').trim();
    const lastName = String(input.lastName || '').trim();
    const phone = String(input.phone || '').trim();
    const ratingNumber = Number(input.rating);
    const rating = Number.isFinite(ratingNumber) ? Math.max(1, Math.min(10, Number(ratingNumber.toFixed(1)))) : 5;
    const paymentMethodRaw = String(input.paymentMethod || 'N/A').trim();

    return {
        firstName,
        lastName,
        phone,
        rating,
        isGoalie: false,
        isFree: !!input.isFree,
        paymentMethod: paymentMethodRaw || 'N/A',
        protected: !!input.protected
    };
}

function normalizeRegularSkatersByDayMap(input = {}) {
    const allowedKeys = new Set([
        'everyday','sunday','monday','tuesday','wednesday','thursday','friday','saturday'
    ]);

    const merged = { ...DEFAULT_REGULAR_SKATERS_BY_DAY };
    if (!input || typeof input !== 'object') return merged;

    for (const [rawKey, rawList] of Object.entries(input)) {
        const key = String(rawKey || '').trim().toLowerCase();
        if (!allowedKeys.has(key)) continue;
        const list = Array.isArray(rawList) ? rawList : [];
        merged[key] = list
            .map(normalizeRegularSkaterEntry)
            .filter(player => player.firstName && player.lastName && normalizePhoneDigits(player.phone).length === 10);
    }

    return merged;
}

function getRegularSkatersForDay(dayName = getGameDayName()) {
    const dayKey = String(dayName || '').trim().toLowerCase();
    const everydayPlayers = Array.isArray(regularSkatersByDay.everyday)
        ? regularSkatersByDay.everyday
        : [];
    const dayPlayers = Array.isArray(regularSkatersByDay[dayKey])
        ? regularSkatersByDay[dayKey]
        : [];
    return [...everydayPlayers, ...dayPlayers];
}

function getWeeklyAutoAddPlayers(dayName = getGameDayName()) {
    const dayKey = String(dayName || '').trim().toLowerCase();
    const goalieList = REGULAR_GOALIES_BY_DAY[dayKey] || REGULAR_GOALIES_BY_DAY.friday;
    const skaterList = getRegularSkatersForDay(dayKey);
    return [...AUTO_ADD_CORE_PLAYERS, ...goalieList, ...skaterList].map(player => ({ ...player }));
}

function buildRosterReleasePaymentAnnouncement() {
    const email = String(paymentEmail || '').trim();
    return email
        ? `Payments must be received prior to stepping on the ice. E-transfer to ${email}.`
        : 'Payments must be received prior to stepping on the ice.';
}

function clearAnnouncementState() {
    announcementEnabled = false;
    announcementText = '';
    announcementImages = [];
}

// --- BACKUP GOALIES FOR SUBSTITUTION ---
const BACKUP_GOALIES = [
    {
        firstName: "Mat",
        lastName: "Carriere",
        phone: "(226) 350-0217",
        rating: 7,
        isGoalie: true
    },
    {
        firstName: "Jesse",
        lastName: "Laframboise",
        phone: "(519) 566-6711",
        rating: 7,
        isGoalie: true
    },
    {
        firstName: "Kent",
        lastName: "Nelson",
        phone: "(250) 884-6609",
        rating: 7,
        isGoalie: true
    }
];

// --- ARENA OPTIONS ---
const ARENA_OPTIONS = [
    "WFCU Bowl",
    "WFCU Greenshield", 
    "WFCU Grenon",
    "WFCU AM800",
    "Capri Recreation Complex",
    "Vollmer Lasalle Arena",
    "Atlas Tube Lakeshore"
];

// --- DAY/TIME OPTIONS FOR TITLE ---
const DAY_TIME_OPTIONS = [
    "Sunday 8:30 PM",
    "Sunday 9:30 PM",
    "Sunday 10:00 PM",
    "Friday 8:30 PM",
    "Friday 9:30 PM",
    "Friday 10:00 PM",
    "Wednesday 8:30 PM",
    "Wednesday 9:30 PM",
    "Wednesday 10:00 PM",
    "Saturday 8:30 PM",
    "Saturday 9:30 PM",
    "Saturday 10:00 PM"
];

// --- APP SETTINGS ---
let maintenanceMode = false;
let customTitle = `Phan's ${getGameDayName()} Hockey`;
let announcementEnabled = false;
let announcementText = '';
let announcementImages = [];
let paymentEmail = String(process.env.PAYMENT_EMAIL || '').trim();

// ============================================
// END NEW CONFIGURATION SECTION
// ============================================

// --- TIME FUNCTIONS ---

function getCurrentETTime() {
    const now = new Date();
    const etString = now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    const [datePart, timePart] = etString.split(', ');
    const [month, day, year] = datePart.split('/').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    
    const etDate = new Date(year, month - 1, day, hour, minute, second);
    return etDate;
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return {
        week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7),
        year: d.getUTCFullYear()
    };
}

// FRIDAY HOCKEY SCHEDULE: Locked Friday 5pm - Monday 6pm

function clampInt(n, fallback) {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : fallback;
}


function parseDatetimeLocalToDowTime(dtLocalStr) {
    // Treat admin-entered datetime-local as ET wall-clock exactly as entered.
    if (!dtLocalStr || typeof dtLocalStr !== 'string' || !dtLocalStr.includes('T')) return null;
    const [dPart, tPart] = dtLocalStr.split('T');
    const [y, m, d] = dPart.split('-').map(v => clampInt(v, NaN));
    const [hh, mm] = tPart.split(':').map(v => clampInt(v, NaN));
    if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { dow, hour: hh, minute: mm };
}

function parseDatetimeLocalToETDate(dtLocalStr) {
    // Returns ET wall-clock parts exactly as entered by admin.
    if (!dtLocalStr || typeof dtLocalStr !== 'string' || !dtLocalStr.includes('T')) return null;
    const [dPart, tPart] = dtLocalStr.split('T');
    const [y, m, d] = dPart.split('-').map(v => clampInt(v, NaN));
    const [hh, mm] = tPart.split(':').map(v => clampInt(v, NaN));
    if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
    return { year: y, month: m, day: d, hour: hh, minute: mm };
}

function etPartsToMinuteKey(parts) {
    if (!parts) return null;
    return (
        parts.year * 100000000 +
        parts.month * 1000000 +
        parts.day * 10000 +
        parts.hour * 100 +
        parts.minute
    );
}

function nowETMinuteKey(etDate) {
    return (
        etDate.getFullYear() * 100000000 +
        (etDate.getMonth() + 1) * 1000000 +
        etDate.getDate() * 10000 +
        etDate.getHours() * 100 +
        etDate.getMinutes()
    );
}

function getEtDowHourMinute(etDate = getCurrentETTime()) {
    return {
        dow: etDate.getDay(),
        hour: etDate.getHours(),
        minute: etDate.getMinutes()
    };
}

function minuteOfWeekFromParts(dow, hour, minute) {
    return (Number(dow) * 24 * 60) + (Number(hour) * 60) + Number(minute);
}

function minuteOfWeekNow(etDate = getCurrentETTime()) {
    return minuteOfWeekFromParts(etDate.getDay(), etDate.getHours(), etDate.getMinutes());
}

function sameDowHourMinute(a, b) {
    return !!a && !!b &&
        Number(a.dow) === Number(b.dow) &&
        Number(a.hour) === Number(b.hour) &&
        Number(a.minute) === Number(b.minute);
}

function isNowAtSchedule(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return false;
    const now = getEtDowHourMinute(etDate);
    return sameDowHourMinute(scheduleAt, now);
}

function isNowInWindow(start, end, etDate = getCurrentETTime()) {
    if (!start || !end) return false;

    const now = minuteOfWeekNow(etDate);
    const startMin = minuteOfWeekFromParts(start.dow, start.hour, start.minute);
    const endMin = minuteOfWeekFromParts(end.dow, end.hour, end.minute);

    if (startMin === endMin) return false;

    if (startMin < endMin) {
        return now >= startMin && now < endMin;
    }

    return now >= startMin || now < endMin;
}

function getScheduleOccurrenceKey(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return '';
    const weekInfo = getWeekNumber(etDate);
    return `${weekInfo.year}-W${weekInfo.week}-${scheduleAt.dow}-${scheduleAt.hour}-${scheduleAt.minute}`;
}

function hasScheduleAlreadyPassedThisWeek(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return false;
    const scheduleMinute = minuteOfWeekFromParts(scheduleAt.dow, scheduleAt.hour, scheduleAt.minute);
    const nowMinute = minuteOfWeekNow(etDate);
    return scheduleMinute <= nowMinute;
}

function armScheduleGuardForCurrentWeek(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return { occurrenceKey: '', minuteKey: '' };
    if (!hasScheduleAlreadyPassedThisWeek(scheduleAt, etDate)) {
        return { occurrenceKey: '', minuteKey: '' };
    }
    return {
        occurrenceKey: getScheduleOccurrenceKey(scheduleAt, etDate),
        minuteKey: String(nowETMinuteKey(etDate))
    };
}

function minutesSinceLatestWeeklyOccurrence(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return null;
    const nowMinute = minuteOfWeekNow(etDate);
    const scheduleMinute = minuteOfWeekFromParts(scheduleAt.dow, scheduleAt.hour, scheduleAt.minute);
    return (nowMinute - scheduleMinute + (7 * 24 * 60)) % (7 * 24 * 60);
}

function canSafelyRunWeeklyReset(etTime = getCurrentETTime()) {
    const registeredPlayerCount = Array.isArray(players) ? players.length : 0;
    const waitlistCount = Array.isArray(waitlist) ? waitlist.length : 0;

    if (!resetArmed) {
        return {
            ok: false,
            reason: 'Blocked weekly reset because reset arm is OFF.'
        };
    }

    if (registeredPlayerCount > 0) {
        return {
            ok: false,
            reason: `Blocked weekly reset because ${registeredPlayerCount} registered player${registeredPlayerCount === 1 ? '' : 's'} still exist.`
        };
    }

    if (waitlistCount > 0) {
        return {
            ok: false,
            reason: `Blocked weekly reset because ${waitlistCount} waitlist player${waitlistCount === 1 ? '' : 's'} still exist.`
        };
    }

    return { ok: true, reason: 'Reset arm is ON and there are no registered players or waitlist entries to reset.' };
}

function getNextOccurrenceEtParts(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return null;

    const nowDow = etDate.getDay();
    const nowMinutes = (etDate.getHours() * 60) + etDate.getMinutes();
    const targetMinutes = (Number(scheduleAt.hour) * 60) + Number(scheduleAt.minute);

    let daysAhead = (Number(scheduleAt.dow) - nowDow + 7) % 7;
    if (daysAhead === 0 && targetMinutes <= nowMinutes) {
        daysAhead = 7;
    }

    const next = new Date(etDate);
    next.setDate(etDate.getDate() + daysAhead);
    next.setHours(Number(scheduleAt.hour), Number(scheduleAt.minute), 0, 0);

    return {
        year: next.getFullYear(),
        month: next.getMonth() + 1,
        day: next.getDate(),
        hour: next.getHours(),
        minute: next.getMinutes()
    };
}

function getCurrentOrNextOccurrenceEtParts(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return null;
    if (isNowAtSchedule(scheduleAt, etDate)) {
        return {
            year: etDate.getFullYear(),
            month: etDate.getMonth() + 1,
            day: etDate.getDate(),
            hour: etDate.getHours(),
            minute: etDate.getMinutes()
        };
    }
    return getNextOccurrenceEtParts(scheduleAt, etDate);
}

function getLatestOccurrenceEtParts(scheduleAt, etDate = getCurrentETTime()) {
    if (!scheduleAt) return null;

    const latest = new Date(etDate);
    latest.setHours(Number(scheduleAt.hour), Number(scheduleAt.minute), 0, 0);

    const currentDow = latest.getDay();
    let daysBack = (currentDow - Number(scheduleAt.dow) + 7) % 7;

    const nowMinutes = (etDate.getHours() * 60) + etDate.getMinutes();
    const targetMinutes = (Number(scheduleAt.hour) * 60) + Number(scheduleAt.minute);
    if (daysBack === 0 && nowMinutes < targetMinutes) {
        daysBack = 7;
    }

    latest.setDate(latest.getDate() - daysBack);
    latest.setHours(Number(scheduleAt.hour), Number(scheduleAt.minute), 0, 0);

    return {
        year: latest.getFullYear(),
        month: latest.getMonth() + 1,
        day: latest.getDate(),
        hour: latest.getHours(),
        minute: latest.getMinutes()
    };
}

function getOccurrenceKeyFromEtParts(scheduleAt, occurrenceParts) {
    if (!scheduleAt || !occurrenceParts) return '';
    const anchor = new Date(
        occurrenceParts.year,
        occurrenceParts.month - 1,
        occurrenceParts.day,
        occurrenceParts.hour,
        occurrenceParts.minute,
        0,
        0
    );
    const weekInfo = getWeekNumber(anchor);
    return `${weekInfo.year}-W${weekInfo.week}-${scheduleAt.dow}-${scheduleAt.hour}-${scheduleAt.minute}`;
}

function minutesSinceEtParts(occurrenceParts, etDate = getCurrentETTime()) {
    if (!occurrenceParts) return null;
    const occurrence = new Date(
        occurrenceParts.year,
        occurrenceParts.month - 1,
        occurrenceParts.day,
        occurrenceParts.hour,
        occurrenceParts.minute,
        0,
        0
    );
    return Math.floor((etDate.getTime() - occurrence.getTime()) / 60000);
}

function shouldRunScheduledAction(scheduleAt, lastRunOccurrenceKey, etDate = getCurrentETTime(), maxCatchUpMinutes = 360) {
    if (!scheduleAt) {
        return { shouldRun: false, reason: 'missing_schedule', occurrenceKey: '', minuteKey: '', lagMinutes: null };
    }

    const occurrenceParts = getLatestOccurrenceEtParts(scheduleAt, etDate);
    const occurrenceKey = getOccurrenceKeyFromEtParts(scheduleAt, occurrenceParts);
    const minuteKey = String(nowETMinuteKey(etDate));
    const lagMinutes = minutesSinceEtParts(occurrenceParts, etDate);

    if (!Number.isFinite(lagMinutes) || lagMinutes < 0) {
        return { shouldRun: false, reason: 'before_schedule', occurrenceKey, minuteKey, lagMinutes };
    }

    if (lagMinutes > maxCatchUpMinutes) {
        return { shouldRun: false, reason: 'outside_catchup_window', occurrenceKey, minuteKey, lagMinutes };
    }

    if (lastRunOccurrenceKey === occurrenceKey) {
        return { shouldRun: false, reason: 'already_ran_occurrence', occurrenceKey, minuteKey, lagMinutes };
    }

    return {
        shouldRun: true,
        reason: lagMinutes === 0 ? 'exact_minute' : 'catchup',
        occurrenceKey,
        minuteKey,
        lagMinutes
    };
}

function formatScheduleDowTime(scheduleAt) {
    if (!scheduleAt) return '';
    const dayName = INDEX_TO_DAY_NAME[Number(scheduleAt.dow)] || 'Unknown';
    const hour24 = Number(scheduleAt.hour) || 0;
    const minute = Number(scheduleAt.minute) || 0;
    const hour12 = ((hour24 + 11) % 12) + 1;
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    return `${dayName} ${hour12}:${String(minute).padStart(2, '0')} ${ampm} ET`;
}

function shouldAutoBuildMissingSchedules(scheduleSettings = {}) {
    if (!AUTO_BUILD_WEEKLY_SCHEDULES_FROM_GAMETIME) return false;
    const hasStoredSignupLockSchedule = !!scheduleSettings.signupLockSchedule;
    const hasStoredRosterReleaseSchedule = !!scheduleSettings.rosterReleaseSchedule;
    const hasStoredResetWeekSchedule = !!scheduleSettings.resetWeekSchedule;
    return !hasStoredSignupLockSchedule && !hasStoredRosterReleaseSchedule && !hasStoredResetWeekSchedule;
}

function buildAutoSchedulesFromGameTime(selectedGameTime = gameTime, anchorDate = gameDate) {
    const parsed = parseGameTimeString(selectedGameTime);
    const gameDow = parsed.dayIndex;
    const resetDow = (gameDow + 1) % 7;

    const previousSignupLockEnabled = !!(signupLockSchedule && signupLockSchedule.enabled);
    const previousRosterReleaseEnabled = !!(rosterReleaseSchedule && rosterReleaseSchedule.enabled);
    const previousResetWeekEnabled = !!(resetWeekSchedule && resetWeekSchedule.enabled);

    signupLockSchedule = {
        enabled: previousSignupLockEnabled,
        start: { dow: gameDow, hour: AUTO_SCHEDULE_LOCK_HOUR, minute: AUTO_SCHEDULE_LOCK_MINUTE },
        end: { dow: resetDow, hour: AUTO_SCHEDULE_RESET_HOUR, minute: AUTO_SCHEDULE_RESET_MINUTE }
    };

    rosterReleaseSchedule = {
        enabled: previousRosterReleaseEnabled,
        at: { dow: gameDow, hour: AUTO_SCHEDULE_LOCK_HOUR, minute: AUTO_SCHEDULE_LOCK_MINUTE }
    };

    resetWeekSchedule = {
        enabled: previousResetWeekEnabled,
        at: { dow: resetDow, hour: AUTO_SCHEDULE_RESET_HOUR, minute: AUTO_SCHEDULE_RESET_MINUTE }
    };

    const safeDate = anchorDate || calculateNextGameDate();
    const [year, month, day] = String(safeDate).split('-').map(v => parseInt(v, 10));
    const hasAnchor = [year, month, day].every(Number.isFinite);

    const buildFromAnchor = (dow, hour, minute) => {
        if (!hasAnchor) {
            return getNextOccurrenceEtParts({ dow, hour, minute });
        }
        const anchor = new Date(year, month - 1, day, hour, minute, 0, 0);
        let daysOffset = (dow - anchor.getDay() + 7) % 7;
        if (daysOffset !== 0) {
            anchor.setDate(anchor.getDate() + daysOffset);
        }
        return {
            year: anchor.getFullYear(),
            month: anchor.getMonth() + 1,
            day: anchor.getDate(),
            hour: anchor.getHours(),
            minute: anchor.getMinutes()
        };
    };

    const lockStartParts = buildFromAnchor(gameDow, AUTO_SCHEDULE_LOCK_HOUR, AUTO_SCHEDULE_LOCK_MINUTE);
    const lockEndParts = buildFromAnchor(resetDow, AUTO_SCHEDULE_RESET_HOUR, AUTO_SCHEDULE_RESET_MINUTE);
    const rosterReleaseParts = buildFromAnchor(gameDow, AUTO_SCHEDULE_LOCK_HOUR, AUTO_SCHEDULE_LOCK_MINUTE);
    const resetParts = buildFromAnchor(resetDow, AUTO_SCHEDULE_RESET_HOUR, AUTO_SCHEDULE_RESET_MINUTE);

    const toLocalString = (parts) => parts
        ? `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
        : '';

    signupLockStartAt = toLocalString(lockStartParts);
    signupLockEndAt = toLocalString(lockEndParts);
    rosterReleaseAt = toLocalString(rosterReleaseParts);
    resetWeekAt = toLocalString(resetParts);
}

function shouldBeLocked() {
    if (!signupLockSchedule || !signupLockSchedule.enabled) return false;
    if (!signupLockSchedule.start || !signupLockSchedule.end) return false;
    return isNowInWindow(signupLockSchedule.start, signupLockSchedule.end);
}

function checkAutoLock() {
    refreshDynamicSignupCode();
    const etTime = getCurrentETTime();

    const shouldLock = shouldBeLocked();

    if (manualOverride && manualOverrideState) {
        if (manualOverrideState === 'locked') {
            if (!requirePlayerCode) {
                requirePlayerCode = true;
                saveData();
            }
            return {
                requirePlayerCode: true,
                manualOverride: true,
                manualOverrideState: 'locked',
                isLockedWindow: shouldLock,
                rosterReleased
            };
        } else if (manualOverrideState === 'open') {
            if (requirePlayerCode) {
                requirePlayerCode = false;
                saveData();
            }
            return {
                requirePlayerCode: false,
                manualOverride: true,
                manualOverrideState: 'open',
                isLockedWindow: shouldLock,
                rosterReleased
            };
        }
    }

    if (shouldLock) {
        if (!requirePlayerCode) {
            requirePlayerCode = true;
            saveData();
        }
    } else if (requirePlayerCode) {
        requirePlayerCode = false;
        saveData();
    }

    return {
        requirePlayerCode,
        manualOverride: false,
        manualOverrideState: null,
        isLockedWindow: shouldLock,
        rosterReleased
    };
}


// Auto-release roster using recurring weekly ET schedule
async function autoReleaseRoster() {
    const etTime = getCurrentETTime();

    if (!rosterReleaseSchedule || !rosterReleaseSchedule.enabled) return false;
    if (!rosterReleaseSchedule.at) return false;
    if (rosterReleased || players.length === 0) return false;

    const releaseCheck = shouldRunScheduledAction(
        rosterReleaseSchedule.at,
        lastExactRosterReleaseRunAt,
        etTime,
        Number(process.env.ROSTER_RELEASE_CATCHUP_MINUTES || (31 * 60))
    );
    if (!releaseCheck.shouldRun) return false;

    lastExactRosterReleaseRunAt = releaseCheck.occurrenceKey;
    lastExactRosterReleaseMinuteKey = releaseCheck.minuteKey;
    await saveData();

    try {
        const { week, year } = getWeekNumber(etTime);
        const teams = generateFairTeams();

        rosterReleased = true;
        resetArmed = true;

        announcementEnabled = true;
        announcementText = buildRosterReleasePaymentAnnouncement();

        currentWeekData = {
            weekNumber: week,
            year: year,
            releaseDate: new Date().toISOString(),
            rosterReleaseTime: Date.now(),
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam
        };

        if (pool) {
            for (const player of players) {
                await pool.query('UPDATE players SET team = $1 WHERE id = $2', [player.team, player.id]);
            }

            await saveWeekHistory(year, week, teams.whiteTeam, teams.darkTeam);

            await pool.query(
                'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                ['announcementEnabled', announcementEnabled.toString()]
            );
            await pool.query(
                'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                ['announcementText', announcementText]
            );
        }

        await saveData();
        return true;
    } catch (error) {
        console.error('Auto-release error:', error);
        return false;
    }
}

// --- AUTO-ADD PLAYERS FUNCTION ---
async function addAutoPlayers() {
    const autoPlayers = getWeeklyAutoAddPlayers();
    console.log(`Adding auto-players for new week (${getGameDayName()}): ${autoPlayers.map(p => `${p.firstName} ${p.lastName}`).join(', ')}`);
    let addedCount = 0;

    for (const autoPlayer of autoPlayers) {
        const normalizedName = (autoPlayer.firstName + ' ' + autoPlayer.lastName).toLowerCase().trim();
        const normalizedPhone = normalizePhoneDigits(autoPlayer.phone);

        const exists = players.find(p =>
            (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
            normalizePhoneDigits(p.phone) === normalizedPhone
        );

        if (exists) {
            console.log(`${autoPlayer.firstName} ${autoPlayer.lastName} already exists, skipping.`);
            continue;
        }

        const newPlayer = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            firstName: autoPlayer.firstName,
            lastName: autoPlayer.lastName,
            phone: autoPlayer.phone,
            paymentMethod: autoPlayer.paymentMethod,
            paid: autoPlayer.isFree ? true : false,
            paidAmount: autoPlayer.isFree ? 0 : null,
            rating: autoPlayer.rating,
            isGoalie: autoPlayer.isGoalie,
            team: null,
            registeredAt: new Date().toISOString(),
            rulesAgreed: true,
            protected: autoPlayer.protected || false
        };

        try {
            if (pool) {
                await pool.query(
                    `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                     newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating,
                     autoPlayer.isGoalie, null, true]
                );
            }

            players.push(newPlayer);

            if (!autoPlayer.isGoalie) {
                playerSpots = Math.max(0, playerSpots - 1);
            }

            addedCount++;
            console.log(`Added ${autoPlayer.firstName} ${autoPlayer.lastName}`);
        } catch (err) {
            console.error(`Error adding ${autoPlayer.firstName} ${autoPlayer.lastName}:`, err);
        }
    }

    if (addedCount > 0) {
        await saveData();
    }
    console.log(`Auto-added ${addedCount} players`);
    return addedCount;
}



function checkMaintenanceModeSchedule() {
    const etTime = getCurrentETTime();
    const day = etTime.getDay();
    const hour = etTime.getHours();
    const minute = etTime.getMinutes();

    if (day === 6 && hour === 0 && minute === 0 && maintenanceMode !== true) {
        maintenanceMode = true;
        saveData();
        return true;
    }

    if (day === 6 && hour === 12 && minute === 0 && maintenanceMode !== false) {
        maintenanceMode = false;
        saveData();
        return true;
    }

    return false;
}


// Weekly reset using recurring weekly ET schedule
async function checkWeeklyReset() {
    const etTime = getCurrentETTime();
    const { week: currentWeek, year: currentYear } = getWeekNumber(etTime);

    if (!resetWeekSchedule || !resetWeekSchedule.enabled) return false;
    if (!resetWeekSchedule.at) return false;

    const resetCheck = shouldRunScheduledAction(
        resetWeekSchedule.at,
        lastExactResetRunAt,
        etTime,
        Number(process.env.WEEKLY_RESET_CATCHUP_MINUTES || (18 * 60))
    );
    if (!resetCheck.shouldRun) return false;

    const resetSafety = canSafelyRunWeeklyReset(etTime);
    if (!resetSafety.ok) {
        console.warn(`[SAFETY] Weekly reset skipped at ${resetCheck.minuteKey}: ${resetSafety.reason}`);
        return false;
    }

    lastExactResetRunAt = resetCheck.occurrenceKey;
    lastExactResetMinuteKey = resetCheck.minuteKey;
    await saveData();

    await savePaymentReportSnapshot('scheduled_reset');

    if (
        rosterReleased &&
        currentWeekData.weekNumber &&
        (currentWeekData.whiteTeam.length > 0 || currentWeekData.darkTeam.length > 0) &&
        pool
    ) {
        await saveWeekHistory(
            currentWeekData.year,
            currentWeekData.weekNumber,
            currentWeekData.whiteTeam,
            currentWeekData.darkTeam
        );
    }

    playerSpots = 20;
    players = [];
    waitlist = [];
    rosterReleased = false;
    resetArmed = false;
    lastResetWeek = currentWeek;
    gameDate = calculateNextGameDate();

    currentWeekData = {
        weekNumber: currentWeek,
        year: currentYear,
        releaseDate: null,
        whiteTeam: [],
        darkTeam: []
    };

    manualOverride = false;
    manualOverrideState = null;
    requirePlayerCode = true;
    maintenanceMode = false;
    clearAnnouncementState();
    refreshDynamicSignupCode();

    // Keep weekly schedules intact
    lastExactRosterReleaseRunAt = '';
    lastExactRosterReleaseMinuteKey = '';

    if (pool) {
        try {
            await pool.query('DELETE FROM players');
            await pool.query('DELETE FROM waitlist');
        } catch (err) {
            console.error('Error clearing data during scheduled reset:', err);
        }
    }

    await addAutoPlayers();
    await saveData();
    return true;
}

const CHECK_INTERVAL = process.env.NODE_ENV === 'production' ? 15000 : 5000;
let schedulerRunning = false;
let lastSchedulerMinuteKey = null;
let lastSchedulerRunAt = null;
let lastSchedulerDurationMs = null;
let lastSchedulerError = '';
let lastCronHeartbeatAt = null;
let lastHealthPingAt = null;
let lastCronUserAgent = '';
let consecutiveDbFailures = 0;

async function runSchedulerTick() {
    if (schedulerRunning) return;

    const startedAt = Date.now();
    const etTime = getCurrentETTime();
    const minuteKey = nowETMinuteKey(etTime);
    if (process.env.NODE_ENV === 'production' && lastSchedulerMinuteKey === minuteKey) return;

    schedulerRunning = true;
    lastSchedulerMinuteKey = minuteKey;

    try {
        checkMaintenanceModeSchedule();
        checkAutoLock();
        await autoReleaseRoster();
        await checkWeeklyReset();
        await saveData();
        lastSchedulerRunAt = new Date().toISOString();
        lastSchedulerDurationMs = Date.now() - startedAt;
        lastSchedulerError = '';
    } catch (err) {
        console.error('Scheduler tick error:', err);
        lastSchedulerRunAt = new Date().toISOString();
        lastSchedulerDurationMs = Date.now() - startedAt;
        lastSchedulerError = err && err.message ? err.message : String(err || 'Unknown scheduler error');
    } finally {
        schedulerRunning = false;
    }
}

setInterval(runSchedulerTick, CHECK_INTERVAL);

// --- DATABASE FUNCTIONS ---

async function initDatabase() {
    if (!pool) {
        loadDataFromFile();
        return;
    }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value JSONB NOT NULL
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                paid BOOLEAN DEFAULT false,
                paid_amount NUMERIC(10,2),
                rating NUMERIC(4,1) NOT NULL,
                skating_rating NUMERIC(4,1),
                puck_skills_rating NUMERIC(4,1),
                hockey_sense_rating NUMERIC(4,1),
                conditioning_rating NUMERIC(4,1),
                effort_rating NUMERIC(4,1),
                level_played VARCHAR(30),
                peer_comparison VARCHAR(20),
                confidence_level VARCHAR(20),
                self_rating_raw NUMERIC(4,1),
                derived_rating NUMERIC(4,1),
                admin_rating NUMERIC(4,1),
                admin_adjustment NUMERIC(4,1),
                final_rating NUMERIC(4,1),
                is_goalie BOOLEAN DEFAULT false,
                team VARCHAR(10),
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                rules_agreed BOOLEAN DEFAULT false
            )
        `);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS skating_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS puck_skills_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS hockey_sense_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS conditioning_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS effort_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS level_played VARCHAR(30)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS peer_comparison VARCHAR(20)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS confidence_level VARCHAR(20)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS self_rating_raw NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS derived_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS admin_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS admin_adjustment NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS final_rating NUMERIC(4,1)`);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS waitlist (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                rating NUMERIC(4,1) NOT NULL,
                skating_rating NUMERIC(4,1),
                puck_skills_rating NUMERIC(4,1),
                hockey_sense_rating NUMERIC(4,1),
                conditioning_rating NUMERIC(4,1),
                effort_rating NUMERIC(4,1),
                level_played VARCHAR(30),
                peer_comparison VARCHAR(20),
                confidence_level VARCHAR(20),
                self_rating_raw NUMERIC(4,1),
                derived_rating NUMERIC(4,1),
                final_rating NUMERIC(4,1),
                is_goalie BOOLEAN DEFAULT false,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS skating_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS puck_skills_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS hockey_sense_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS conditioning_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS effort_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS level_played VARCHAR(30)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS peer_comparison VARCHAR(20)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS confidence_level VARCHAR(20)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS self_rating_raw NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS derived_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS final_rating NUMERIC(4,1)`);
        await pool.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS bypass_auto_promote BOOLEAN DEFAULT false`);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS history (
                id SERIAL PRIMARY KEY,
                week_number INTEGER NOT NULL,
                year INTEGER NOT NULL,
                release_date TIMESTAMP NOT NULL,
                game_location VARCHAR(200),
                game_time VARCHAR(50),
                game_date DATE,
                white_team JSONB,
                dark_team JSONB,
                white_avg NUMERIC(3,1),
                dark_avg NUMERIC(3,1)
            )
        `);
        
        // ============================================
        // ADD THIS NEW TABLE FOR APP SETTINGS
        // ============================================
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS payment_reports (
                id SERIAL PRIMARY KEY,
                report_name VARCHAR(255) NOT NULL,
                report_csv TEXT NOT NULL,
                trigger_source VARCHAR(50) NOT NULL,
                game_location VARCHAR(200),
                game_time VARCHAR(50),
                game_date DATE,
                roster_released BOOLEAN DEFAULT false,
                week_number INTEGER,
                year INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS data_audit (
                id SERIAL PRIMARY KEY,
                event_type VARCHAR(100) NOT NULL,
                status VARCHAR(30) NOT NULL,
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS data_snapshots (
                id SERIAL PRIMARY KEY,
                snapshot_name VARCHAR(255),
                snapshot_json JSONB NOT NULL,
                snapshot_reason VARCHAR(100),
                snapshot_version INTEGER DEFAULT 1,
                players_count INTEGER DEFAULT 0,
                waitlist_count INTEGER DEFAULT 0,
                snapshot_saved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`ALTER TABLE data_snapshots ADD COLUMN IF NOT EXISTS snapshot_reason VARCHAR(100)`);
        await pool.query(`ALTER TABLE data_snapshots ADD COLUMN IF NOT EXISTS snapshot_version INTEGER DEFAULT 1`);
        await pool.query(`ALTER TABLE data_snapshots ADD COLUMN IF NOT EXISTS players_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE data_snapshots ADD COLUMN IF NOT EXISTS waitlist_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE data_snapshots ADD COLUMN IF NOT EXISTS snapshot_saved_at TIMESTAMP`);
        
        await loadDataFromDB();
        await loadRecentDataAudit();
        await pruneDataAuditIfNeeded(true);
    } catch (err) {
        console.error('Database initialization error:', err);
        loadDataFromFile();
    }
}

async function loadDataFromDB() {
    if (!pool) return;
    try {
        const settingsRes = await pool.query('SELECT * FROM settings');
        const settings = {};
        settingsRes.rows.forEach(row => {
            settings[row.key] = row.value;
        });
        
        if (settings.playerSpots) playerSpots = settings.playerSpots;
        if (settings.gameLocation) gameLocation = settings.gameLocation;
        if (settings.gameTime) gameTime = settings.gameTime;
        if (settings.gameDate) gameDate = settings.gameDate;
        else gameDate = calculateNextGameDate();
        if (settings.playerSignupCode) playerSignupCode = settings.playerSignupCode;
        if (settings.requirePlayerCode !== undefined) requirePlayerCode = settings.requirePlayerCode;
        if (settings.manualOverride !== undefined) manualOverride = settings.manualOverride;
        if (settings.manualOverrideState !== undefined) manualOverrideState = settings.manualOverrideState;
        if (settings.lastResetWeek) lastResetWeek = settings.lastResetWeek;
        if (settings.rosterReleased !== undefined) rosterReleased = settings.rosterReleased;
        if (settings.resetArmed !== undefined) resetArmed = !!settings.resetArmed;
        if (settings.currentWeekData) currentWeekData = settings.currentWeekData;
        if (settings.cancelledRegistrations) cancelledRegistrations = Array.isArray(settings.cancelledRegistrations) ? settings.cancelledRegistrations : [];
        if (settings.customSignupCode !== undefined) customSignupCode = String(settings.customSignupCode || '').trim();
        if (settings.signupLockStartAt !== undefined) signupLockStartAt = settings.signupLockStartAt || '';
        if (settings.signupLockEndAt !== undefined) signupLockEndAt = settings.signupLockEndAt || '';
        if (settings.rosterReleaseAt !== undefined) rosterReleaseAt = settings.rosterReleaseAt || '';
        if (settings.resetWeekAt !== undefined) resetWeekAt = settings.resetWeekAt || '';
        if (settings.lastExactResetRunAt !== undefined) lastExactResetRunAt = settings.lastExactResetRunAt || '';
        if (settings.lastExactRosterReleaseRunAt !== undefined) lastExactRosterReleaseRunAt = settings.lastExactRosterReleaseRunAt || '';
        if (settings.lastExactResetMinuteKey !== undefined) lastExactResetMinuteKey = settings.lastExactResetMinuteKey || '';
        if (settings.lastExactRosterReleaseMinuteKey !== undefined) lastExactRosterReleaseMinuteKey = settings.lastExactRosterReleaseMinuteKey || '';
        if (settings.signupLockSchedule) signupLockSchedule = settings.signupLockSchedule;
        if (settings.rosterReleaseSchedule) rosterReleaseSchedule = settings.rosterReleaseSchedule;
        if (settings.resetWeekSchedule) resetWeekSchedule = settings.resetWeekSchedule;
        if (shouldAutoBuildMissingSchedules(settings)) {
            buildAutoSchedulesFromGameTime(gameTime, gameDate);
        }
        refreshDynamicSignupCode();
        
        const playersRes = await pool.query('SELECT * FROM players ORDER BY registered_at');
        players = playersRes.rows.map(p => hydratePlayerRatingProfile({
            id: Number(p.id),
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            paid: !!p.paid,
            paidAmount: p.paid_amount == null ? null : Number(p.paid_amount),
            rating: p.rating == null ? null : Number(p.rating),
            skatingRating: p.skating_rating == null ? null : Number(p.skating_rating),
            puckSkillsRating: p.puck_skills_rating == null ? null : Number(p.puck_skills_rating),
            hockeySenseRating: p.hockey_sense_rating == null ? null : Number(p.hockey_sense_rating),
            conditioningRating: p.conditioning_rating == null ? null : Number(p.conditioning_rating),
            effortRating: p.effort_rating == null ? null : Number(p.effort_rating),
            levelPlayed: p.level_played,
            peerComparison: p.peer_comparison,
            confidenceLevel: p.confidence_level,
            selfRatingRaw: p.self_rating_raw == null ? null : Number(p.self_rating_raw),
            derivedRating: p.derived_rating == null ? null : Number(p.derived_rating),
            adminRating: p.admin_rating == null ? null : Number(p.admin_rating),
            adminAdjustment: p.admin_adjustment == null ? null : Number(p.admin_adjustment),
            finalRating: p.final_rating == null ? null : Number(p.final_rating),
            isGoalie: !!p.is_goalie,
            team: p.team,
            registeredAt: p.registered_at,
            rulesAgreed: !!p.rules_agreed
        }));
        
        // FIX: Recalculate playerSpots based on actual player count
        const nonGoalieCount = players.filter(p => !p.isGoalie).length;
        playerSpots = Math.max(0, 20 - nonGoalieCount);
                
        const waitlistRes = await pool.query('SELECT * FROM waitlist ORDER BY joined_at');
        waitlist = waitlistRes.rows.map(p => hydratePlayerRatingProfile({
            id: Number(p.id),
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            rating: p.rating == null ? null : Number(p.rating),
            skatingRating: p.skating_rating == null ? null : Number(p.skating_rating),
            puckSkillsRating: p.puck_skills_rating == null ? null : Number(p.puck_skills_rating),
            hockeySenseRating: p.hockey_sense_rating == null ? null : Number(p.hockey_sense_rating),
            conditioningRating: p.conditioning_rating == null ? null : Number(p.conditioning_rating),
            effortRating: p.effort_rating == null ? null : Number(p.effort_rating),
            levelPlayed: p.level_played,
            peerComparison: p.peer_comparison,
            confidenceLevel: p.confidence_level,
            selfRatingRaw: p.self_rating_raw == null ? null : Number(p.self_rating_raw),
            derivedRating: p.derived_rating == null ? null : Number(p.derived_rating),
            finalRating: p.final_rating == null ? null : Number(p.final_rating),
            isGoalie: !!p.is_goalie,
            bypassAutoPromote: !!p.bypass_auto_promote,
            joinedAt: p.joined_at
        }));
        
        // ============================================
        // ADD THIS: Load app settings
        // ============================================
        const appSettingsRes = await pool.query('SELECT * FROM app_settings');
        const appSettings = {};
        appSettingsRes.rows.forEach(row => {
            appSettings[row.key] = row.value;
        });
        
        if (appSettings.maintenanceMode) maintenanceMode = appSettings.maintenanceMode === 'true';
        if (appSettings.customTitle) customTitle = appSettings.customTitle;
        if (appSettings.selectedDayTime) gameTime = appSettings.selectedDayTime;
        if (appSettings.selectedArena) gameLocation = appSettings.selectedArena;
        if (appSettings.announcementEnabled !== undefined) announcementEnabled = appSettings.announcementEnabled === 'true';
        if (appSettings.announcementText !== undefined) announcementText = appSettings.announcementText || '';
        if (appSettings.paymentEmail !== undefined) paymentEmail = String(appSettings.paymentEmail || '').trim() || paymentEmail;
        if (appSettings.announcementImages !== undefined) {
            try {
                announcementImages = JSON.parse(appSettings.announcementImages || '[]');
                if (!Array.isArray(announcementImages)) announcementImages = [];
            } catch {
                announcementImages = [];
            }
        }
        if (appSettings.regularSkatersByDay !== undefined) {
            try {
                regularSkatersByDay = normalizeRegularSkatersByDayMap(JSON.parse(appSettings.regularSkatersByDay || '{}'));
            } catch {
                regularSkatersByDay = normalizeRegularSkatersByDayMap({});
            }
        }

        if (!STRICT_DATABASE_MODE) {
            await reconcileFromFileBackup();
        }
        
    } catch (err) {
        console.error('Error loading from DB:', err);
        throw err;
    }
}

async function saveSetting(key, value) {
    if (!pool) return;
    try {
        await pool.query(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, JSON.stringify(value)]
        );
    } catch (err) {
        console.error('Error saving setting:', err);
    }
}

const DATA_FILE = './data.json';
const SETTINGS_BACKUP_FILE = './app-settings.backup.json';
const SNAPSHOT_DIR = './data-backups';
const SNAPSHOT_RETENTION = Number(process.env.LOCAL_SNAPSHOT_RETENTION || 100);
const DB_SNAPSHOT_RETENTION = Number(process.env.DB_SNAPSHOT_RETENTION || 100);
const DB_SNAPSHOT_FORCE_ON_EVERY_SAVE = String(process.env.DB_SNAPSHOT_FORCE_ON_EVERY_SAVE || 'false').toLowerCase() === 'true';
const REQUEST_SNAPSHOT_ENABLED = String(process.env.REQUEST_SNAPSHOT_ENABLED || 'false').toLowerCase() === 'true';
const REQUEST_SNAPSHOT_MIN_INTERVAL_MS = Number(process.env.REQUEST_SNAPSHOT_MIN_INTERVAL_MS || 60000);
const REQUEST_SELF_HEAL_ENABLED = String(process.env.REQUEST_SELF_HEAL_ENABLED || 'false').toLowerCase() === 'true';
const REQUEST_SELF_HEAL_MIN_INTERVAL_MS = Number(process.env.REQUEST_SELF_HEAL_MIN_INTERVAL_MS || 300000);
const DATA_AUDIT_RECENT_LIMIT = Number(process.env.DATA_AUDIT_RECENT_LIMIT || 25);
const DATA_AUDIT_RETENTION_DAYS = Number(process.env.DATA_AUDIT_RETENTION_DAYS || 14);
const DATA_AUDIT_MAX_ROWS = Number(process.env.DATA_AUDIT_MAX_ROWS || 5000);
const DATA_AUDIT_PRUNE_INTERVAL_MS = Number(process.env.DATA_AUDIT_PRUNE_INTERVAL_MS || 21600000);
let lastRequestSnapshotAt = 0;
let lastRequestSelfHealAt = 0;
let lastAuditPruneAt = 0;
let latestLocalSnapshotMeta = { exists: false, savedAt: null, file: null, players: 0, waitlist: 0, source: 'memory' };
let saveQueue = Promise.resolve();
let recentDataAudit = [];

const DURABLE_SNAPSHOT_REASONS = new Set([
    'player-signup',
    'player-cancel',
    'manual-create-snapshot',
    'pre-restore-safety'
]);

function shouldCreateDurableSnapshot(reason = '') {
    const normalized = String(reason || '').trim().toLowerCase();
    if (!normalized) return !!DB_SNAPSHOT_FORCE_ON_EVERY_SAVE;
    return DURABLE_SNAPSHOT_REASONS.has(normalized) || normalized.startsWith('pre-') || normalized.includes('pre-mutation') || DB_SNAPSHOT_FORCE_ON_EVERY_SAVE;
}


function ensureDirSync(dirPath) {
    try {
        fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
        console.error('Error ensuring directory exists:', dirPath, err.message);
    }
}

function atomicWriteTextFile(filePath, text) {
    const dir = path.dirname(filePath);
    ensureDirSync(dir);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, text);
    fs.renameSync(tempPath, filePath);
}

function safeIsoStamp(date = new Date()) {
    return new Date(date).toISOString().replace(/[:.]/g, '-');
}


function sanitizeFileSegment(value, fallback = 'backup') {
    const cleaned = String(value == null ? '' : value)
        .trim()
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return cleaned || fallback;
}

function getEtDateParts(date = new Date()) {
    const source = date instanceof Date ? date : new Date(date);
    const etString = source.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const [datePart, timePart] = etString.split(', ');
    const [monthRaw, dayRaw, yearRaw] = datePart.split('/');
    const [hourRaw, minuteRaw, secondRaw] = timePart.split(':');

    const year = Number(yearRaw);
    const month = String(monthRaw).padStart(2, '0');
    const day = String(dayRaw).padStart(2, '0');
    let hour24 = Number(hourRaw);
    const minute = String(minuteRaw).padStart(2, '0');
    const second = String(secondRaw).padStart(2, '0');
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    let hour12 = hour24 % 12;
    if (hour12 === 0) hour12 = 12;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const etDate = new Date(year, Number(month) - 1, Number(day), hour24, Number(minute), Number(second));
    const dayName = dayNames[etDate.getDay()];

    return {
        year,
        yy: String(year).slice(-2),
        month,
        day,
        mmddyy: `${month}${day}${String(year).slice(-2)}`,
        hour24,
        hour12: String(hour12),
        minute,
        second,
        ampm,
        dayName
    };
}

function getFormattedBackupBaseName(date = new Date(), options = {}) {
    const includeSeconds = !!options.includeSeconds;
    const parts = getEtDateParts(date);
    const configuredDay = getGameDayName();
    const timeCore = `${parts.hour12}${parts.minute}${parts.ampm}`;
    const timeValue = includeSeconds ? `${timeCore}${parts.second}` : timeCore;
    return `${configuredDay}-${parts.mmddyy}-${timeValue}`;
}

function buildBackupFileName(options = {}) {
    const {
        date = new Date(),
        reason = '',
        ext = 'json',
        includeSeconds = false
    } = options || {};
    const base = getFormattedBackupBaseName(date, { includeSeconds });
    const suffix = reason ? `-${sanitizeFileSegment(reason, 'backup')}` : '';
    const safeExt = String(ext || 'json').replace(/^\./, '') || 'json';
    return `${base}${suffix}.${safeExt}`;
}


function getGameDayBackupDownloadName(ext = 'json') {
    const safeExt = String(ext || 'json').replace(/^\./, '') || 'json';
    return `${getFormattedBackupBaseName(new Date())}.${safeExt}`;
}

function isSnapshotBackupFilename(name = '') {
    const value = String(name || '');
    return /^snapshot-.*\.json$/i.test(value) || /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)-\d{6}-\d{3,8}(AM|PM)(-[a-z0-9_-]+)?\.json$/i.test(value);
}


function updateLatestSnapshotMeta(snapshot, filePath, source = 'memory') {
    latestLocalSnapshotMeta = {
        exists: true,
        savedAt: snapshot?.savedAt || new Date().toISOString(),
        file: filePath,
        players: Array.isArray(snapshot?.players) ? snapshot.players.length : 0,
        waitlist: Array.isArray(snapshot?.waitlist) ? snapshot.waitlist.length : 0,
        source,
        sourceType: source === 'database' ? 'database' : 'local'
    };
}

function getSnapshotCounts(snapshot) {
    return {
        players: Array.isArray(snapshot?.players) ? snapshot.players.length : 0,
        waitlist: Array.isArray(snapshot?.waitlist) ? snapshot.waitlist.length : 0
    };
}

function buildSnapshotMetadata(snapshot, reason = 'saveData') {
    const counts = getSnapshotCounts(snapshot);
    return {
        version: 2,
        reason: String(reason || 'saveData'),
        playersCount: counts.players,
        waitlistCount: counts.waitlist,
        rosterReleased: !!snapshot?.rosterReleased,
        gameDate: snapshot?.gameDate || null,
        gameTime: snapshot?.gameTime || null,
        gameLocation: snapshot?.gameLocation || null,
        savedAt: snapshot?.savedAt || new Date().toISOString()
    };
}

async function pruneDatabaseSnapshotsIfNeeded(clientOrPool = pool) {
    if (!clientOrPool || DB_SNAPSHOT_RETENTION <= 0) return;
    await clientOrPool.query(
        `DELETE FROM data_snapshots
         WHERE id IN (
             SELECT id FROM data_snapshots
             ORDER BY id DESC
             OFFSET $1
         )`,
        [DB_SNAPSHOT_RETENTION]
    );
}

async function insertDatabaseSnapshot(snapshot, reason = 'saveData', clientOrPool = pool) {
    if (!clientOrPool || !shouldCreateDurableSnapshot(reason)) {
        return { ok: !pool, skipped: true, reason: 'db-snapshot-disabled' };
    }

    const metadata = buildSnapshotMetadata(snapshot, reason);
    const result = await clientOrPool.query(
        `INSERT INTO data_snapshots (
            snapshot_name,
            snapshot_json,
            snapshot_reason,
            snapshot_version,
            players_count,
            waitlist_count,
            snapshot_saved_at
        ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
        RETURNING id, created_at`,
        [
            buildBackupFileName({ date: new Date(metadata.savedAt || new Date()), reason: metadata.reason || 'snapshot', ext: 'json', includeSeconds: true }).replace(/\.json$/i, ''),
            JSON.stringify(snapshot),
            metadata.reason,
            metadata.version,
            metadata.playersCount,
            metadata.waitlistCount,
            metadata.savedAt
        ]
    );
    await pruneDatabaseSnapshotsIfNeeded(clientOrPool);
    const row = result.rows && result.rows[0] ? result.rows[0] : {};
    return { ok: true, id: row.id || null, createdAt: row.created_at || null, metadata };
}

async function getLatestDatabaseSnapshot() {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `SELECT id, snapshot_name, snapshot_json, snapshot_reason, snapshot_saved_at, created_at, players_count, waitlist_count
             FROM data_snapshots
             ORDER BY COALESCE(snapshot_saved_at, created_at) DESC, id DESC
             LIMIT 1`
        );
        const row = result.rows && result.rows[0];
        if (!row) return null;
        const data = row.snapshot_json && typeof row.snapshot_json === 'object' ? row.snapshot_json : null;
        if (!data) return null;
        updateLatestSnapshotMeta(data, `db:data_snapshots:${row.id}`, 'database');
        return {
            file: `db:data_snapshots:${row.id}`,
            data,
            savedAtMs: Date.parse(row.snapshot_saved_at || row.created_at || data.savedAt || '') || Date.now(),
            score: ((Number(row.players_count) || 0) * 1000000) + ((Number(row.waitlist_count) || 0) * 1000) + (Date.parse(row.snapshot_saved_at || row.created_at || data.savedAt || '') || 0),
            source: 'database',
            snapshotId: row.id,
            snapshotSavedAt: row.snapshot_saved_at || row.created_at || data.savedAt || null,
            snapshotReason: row.snapshot_reason || null
        };
    } catch (err) {
        console.error('Error loading latest database snapshot:', err.message);
        return null;
    }
}

async function getBestAvailableSnapshot() {
    const dbSnapshot = await getLatestDatabaseSnapshot();
    if (dbSnapshot && dbSnapshot.data) return dbSnapshot;
    const localSnapshot = getBestLocalSnapshot();
    if (localSnapshot && localSnapshot.data) {
        return { ...localSnapshot, source: 'local', snapshotSavedAt: localSnapshot.data?.savedAt || null, snapshotReason: 'local-file' };
    }
    return null;
}

function buildSnapshotFingerprint(snapshotRecord = {}) {
    try {
        const raw = [
            snapshotRecord.source || '',
            snapshotRecord.file || '',
            snapshotRecord.snapshotId || '',
            snapshotRecord.snapshotSavedAt || '',
            snapshotRecord.snapshotReason || '',
            Array.isArray(snapshotRecord.data?.players) ? snapshotRecord.data.players.length : 0,
            Array.isArray(snapshotRecord.data?.waitlist) ? snapshotRecord.data.waitlist.length : 0
        ].join('|');
        return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    } catch (err) {
        return '';
    }
}

function buildSnapshotListItem(record = {}) {
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const summary = data.summary && typeof data.summary === 'object' ? data.summary : {};
    const appSettings = data.appSettings && typeof data.appSettings === 'object' ? data.appSettings : {};
    const playersCount = Array.isArray(data.players) ? data.players.filter(item => item && typeof item === 'object').length : Number(record.playersCount || 0);
    const waitlistCount = Array.isArray(data.waitlist) ? data.waitlist.filter(item => item && typeof item === 'object').length : Number(record.waitlistCount || 0);
    return {
        snapshotKey: record.snapshotId != null ? `db:${record.snapshotId}` : `file:${record.file || ''}`,
        snapshotId: record.snapshotId != null ? String(record.snapshotId) : null,
        source: record.source || 'local',
        file: record.file || null,
        fingerprint: buildSnapshotFingerprint(record),
        savedAt: record.snapshotSavedAt || data.savedAt || null,
        reason: record.snapshotReason || data.snapshotReason || null,
        players: playersCount,
        waitlist: waitlistCount,
        rosterReleased: typeof summary.rosterReleased === 'boolean' ? summary.rosterReleased : null,
        gameLocation: typeof summary.gameLocation === 'string' ? summary.gameLocation : (typeof appSettings.selectedArena === 'string' ? appSettings.selectedArena : null),
        gameTime: typeof summary.gameTime === 'string' ? summary.gameTime : (typeof appSettings.selectedDayTime === 'string' ? appSettings.selectedDayTime : null),
        gameDate: typeof summary.gameDate === 'string' ? summary.gameDate : null,
        version: Number(data.snapshotVersion || 2),
        data
    };
}

async function listAvailableSnapshots(limit = 100) {
    const snapshots = [];
    if (pool) {
        try {
            const result = await pool.query(
                `SELECT id, snapshot_name, snapshot_json, snapshot_reason, snapshot_saved_at, created_at, players_count, waitlist_count
                 FROM data_snapshots
                 ORDER BY COALESCE(snapshot_saved_at, created_at) DESC, id DESC
                 LIMIT $1`,
                [Math.max(1, Math.min(Number(limit) || 100, 300))]
            );
            for (const row of result.rows || []) {
                const data = row.snapshot_json && typeof row.snapshot_json === 'object' ? row.snapshot_json : null;
                if (!data) continue;
                snapshots.push(buildSnapshotListItem({
                    source: 'database',
                    snapshotId: row.id,
                    file: `db:data_snapshots:${row.id}`,
                    snapshotSavedAt: row.snapshot_saved_at || row.created_at || data.savedAt || null,
                    snapshotReason: row.snapshot_reason || null,
                    playersCount: row.players_count,
                    waitlistCount: row.waitlist_count,
                    data
                }));
            }
        } catch (err) {
            console.error('Error listing database snapshots:', err.message);
        }
    }

    try {
        const localFiles = [];
        if (fs.existsSync(SNAPSHOT_DIR)) {
            for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
                if (!isSnapshotBackupFilename(name)) continue;
                localFiles.push(path.join(SNAPSHOT_DIR, name));
            }
        }
        for (const full of localFiles) {
            const data = readJsonFileSafe(full);
            if (!data || typeof data !== 'object') continue;
            const stat = fs.existsSync(full) ? fs.statSync(full) : null;
            snapshots.push(buildSnapshotListItem({
                source: 'local',
                file: full,
                snapshotSavedAt: data.savedAt || (stat ? stat.mtime.toISOString() : null),
                snapshotReason: data.snapshotReason || 'local-file',
                data
            }));
        }
    } catch (err) {
        console.error('Error listing local snapshots:', err.message);
    }

    const seen = new Set();
    const deduped = [];
    for (const item of snapshots) {
        const key = `${item.source}|${item.snapshotId || ''}|${item.file || ''}|${item.savedAt || ''}|${item.fingerprint || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
    }

    deduped.sort((a, b) => {
        const aTime = Date.parse(a.savedAt || '') || 0;
        const bTime = Date.parse(b.savedAt || '') || 0;
        if (bTime !== aTime) return bTime - aTime;
        return String(b.snapshotKey || '').localeCompare(String(a.snapshotKey || ''));
    });

    return deduped.slice(0, Math.max(1, Math.min(Number(limit) || 100, 300)));
}

async function getSnapshotByLookup(snapshotKey, fingerprint = '') {
    const list = await listAvailableSnapshots(300);
    const match = list.find(item => String(item.snapshotKey) === String(snapshotKey));
    if (!match) return null;
    if (fingerprint && String(match.fingerprint) !== String(fingerprint)) {
        return { stale: true, latest: match };
    }
    return match;
}

function buildSnapshotPreviewPayload(item) {
    if (!item || !item.data) return null;
    const previewPlayers = Array.isArray(item.data.players) ? item.data.players.filter(obj => obj && typeof obj === 'object') : [];
    const previewWaitlist = Array.isArray(item.data.waitlist) ? item.data.waitlist.filter(obj => obj && typeof obj === 'object') : [];
    return {
        success: true,
        snapshotKey: item.snapshotKey,
        snapshotId: item.snapshotId,
        fingerprint: item.fingerprint,
        snapshotFile: item.file,
        snapshotSource: item.source || 'local',
        snapshotSavedAt: item.savedAt || null,
        snapshotReason: item.reason || null,
        snapshotPlayers: previewPlayers.length,
        snapshotWaitlist: previewWaitlist.length,
        livePlayers: Array.isArray(players) ? players.length : 0,
        liveWaitlist: Array.isArray(waitlist) ? waitlist.length : 0,
        rosterReleasedInSnapshot: item.rosterReleased,
        gameLocation: item.gameLocation || null,
        gameTime: item.gameTime || null,
        gameDate: item.gameDate || null,
        version: item.version || 2
    };
}


async function createManualSnapshot(reason = 'manual-create-snapshot', req = null, extras = {}) {
    const snapshot = buildFullDataSnapshot();
    const normalizedReason = String(reason || 'manual-create-snapshot').trim() || 'manual-create-snapshot';
    let database = { ok: !pool, skipped: !pool, reason: 'no-database' };
    if (pool && shouldCreateDurableSnapshot(normalizedReason)) {
        database = await insertDatabaseSnapshot(snapshot, normalizedReason, pool);
    }
    const localSnapshot = persistDataToFile(normalizedReason, snapshot);
    try {
        if (req && typeof addAdminAuditEntry === 'function') {
            addAdminAuditEntry(normalizedReason, req, {
                snapshotSavedAt: snapshot.savedAt,
                databaseSnapshot: database,
                localSnapshot,
                ...extras
            });
        }
        if (typeof appendDataAudit === 'function') {
            await appendDataAudit(normalizedReason, 'success', {
                snapshotSavedAt: snapshot.savedAt,
                databaseSnapshot: database,
                localSnapshot,
                ...extras
            });
        }
    } catch (auditErr) {
        console.error('Error auditing manual snapshot creation:', auditErr.message);
    }
    return {
        success: true,
        snapshotSavedAt: snapshot.savedAt,
        databaseSnapshot: database,
        localSnapshot
    };
}

function applySnapshotToMemory(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    playerSpots = snapshot.playerSpots ?? 20;
    players = Array.isArray(snapshot.players) ? snapshot.players.map(hydratePlayerRatingProfile) : [];
    waitlist = Array.isArray(snapshot.waitlist) ? snapshot.waitlist.map(hydratePlayerRatingProfile) : [];
    gameLocation = snapshot.gameLocation ?? gameLocation;
    gameTime = snapshot.gameTime ?? gameTime;
    gameDate = snapshot.gameDate ?? calculateNextGameDate();
    playerSignupCode = snapshot.playerSignupCode ?? playerSignupCode;
    requirePlayerCode = snapshot.requirePlayerCode ?? requirePlayerCode;
    manualOverride = snapshot.manualOverride ?? manualOverride;
    manualOverrideState = snapshot.manualOverrideState ?? manualOverrideState;
    lastResetWeek = snapshot.lastResetWeek ?? lastResetWeek;
    rosterReleased = snapshot.rosterReleased ?? rosterReleased;
    resetArmed = snapshot.resetArmed ?? resetArmed;
    signupLockStartAt = snapshot.signupLockStartAt ?? signupLockStartAt;
    signupLockEndAt = snapshot.signupLockEndAt ?? signupLockEndAt;
    rosterReleaseAt = snapshot.rosterReleaseAt ?? rosterReleaseAt;
    resetWeekAt = snapshot.resetWeekAt ?? resetWeekAt;
    lastExactResetRunAt = snapshot.lastExactResetRunAt ?? lastExactResetRunAt;
    lastExactRosterReleaseRunAt = snapshot.lastExactRosterReleaseRunAt ?? lastExactRosterReleaseRunAt;
    lastExactResetMinuteKey = snapshot.lastExactResetMinuteKey ?? lastExactResetMinuteKey;
    lastExactRosterReleaseMinuteKey = snapshot.lastExactRosterReleaseMinuteKey ?? lastExactRosterReleaseMinuteKey;
    signupLockSchedule = snapshot.signupLockSchedule ?? signupLockSchedule;
    rosterReleaseSchedule = snapshot.rosterReleaseSchedule ?? rosterReleaseSchedule;
    resetWeekSchedule = snapshot.resetWeekSchedule ?? resetWeekSchedule;
    cancelledRegistrations = Array.isArray(snapshot.cancelledRegistrations) ? snapshot.cancelledRegistrations : [];
    regularSkatersByDay = normalizeRegularSkatersByDayMap(snapshot.regularSkatersByDay || {});
    customSignupCode = String(snapshot.customSignupCode || '').trim();
    currentWeekData = snapshot.currentWeekData ?? {
        weekNumber: null,
        year: null,
        releaseDate: null,
        whiteTeam: [],
        darkTeam: []
    };
    maintenanceMode = snapshot.maintenanceMode ?? maintenanceMode;
    customTitle = snapshot.customTitle ?? customTitle;
    announcementEnabled = snapshot.announcementEnabled ?? announcementEnabled;
    announcementText = snapshot.announcementText ?? announcementText;
    announcementImages = Array.isArray(snapshot.announcementImages) ? snapshot.announcementImages : [];
    paymentEmail = typeof snapshot.paymentEmail === 'string' ? snapshot.paymentEmail : paymentEmail;
    refreshDynamicSignupCode();
}

async function runProtectedMutation(reason, req, mutateFn, extras = {}) {
    const normalizedReason = String(reason || 'mutation').trim() || 'mutation';
    const beforeSnapshot = buildFullDataSnapshot();
    const preMutationSnapshot = await createManualSnapshot(`pre-${normalizedReason}`, req, extras);

    try {
        await mutateFn();
        const saveResult = await saveData(normalizedReason);
        if (!saveResult || !saveResult.ok) {
            throw new Error(saveResult?.error || 'Durable save failed');
        }
        return { ok: true, preMutationSnapshot, saveResult };
    } catch (err) {
        try {
            applySnapshotToMemory(beforeSnapshot);
            persistDataToFile(`rollback-${normalizedReason}`, beforeSnapshot);
        } catch (rollbackErr) {
            console.error('Rollback memory restore failed:', rollbackErr.message);
        }
        try {
            await appendDataAudit(normalizedReason, 'rollback', {
                error: err.message,
                preMutationSnapshot,
                ...extras
            });
        } catch (auditErr) {
            console.error('Error auditing rollback:', auditErr.message);
        }
        throw err;
    }
}

async function restoreSnapshotItem(item, req, auditAction = 'restore-snapshot-replace') {
    const backupData = item.data;
    const restoredPlayers = Array.isArray(backupData.players) ? backupData.players.filter(obj => obj && typeof obj === 'object') : null;
    const restoredWaitlist = Array.isArray(backupData.waitlist) ? backupData.waitlist.filter(obj => obj && typeof obj === 'object') : null;
    if (!restoredPlayers || !restoredWaitlist) {
        return { ok: false, status: 400, body: { error: 'Selected snapshot is missing players or waitlist.' } };
    }

    const beforeCounts = {
        players: Array.isArray(players) ? players.length : 0,
        waitlist: Array.isArray(waitlist) ? waitlist.length : 0
    };

    const safetySnapshot = await createManualSnapshot('pre-restore-safety', req, {
        restoringSnapshotKey: item.snapshotKey,
        restoringFingerprint: item.fingerprint
    });

    players = JSON.parse(JSON.stringify(restoredPlayers));
    waitlist = JSON.parse(JSON.stringify(restoredWaitlist));

    if (backupData.currentWeekData && typeof backupData.currentWeekData === 'object') {
        currentWeekData = JSON.parse(JSON.stringify(backupData.currentWeekData));
    }

    if (backupData.summary && typeof backupData.summary === 'object') {
        if (typeof backupData.summary.gameLocation === 'string') gameLocation = backupData.summary.gameLocation;
        if (typeof backupData.summary.gameTime === 'string') gameTime = backupData.summary.gameTime;
        if (typeof backupData.summary.gameDate === 'string') gameDate = backupData.summary.gameDate;
        if (typeof backupData.summary.rosterReleased === 'boolean') rosterReleased = backupData.summary.rosterReleased;
        if (typeof backupData.summary.requirePlayerCode === 'boolean') requirePlayerCode = backupData.summary.requirePlayerCode;
        if (typeof backupData.summary.playerSignupCode === 'string' && backupData.summary.playerSignupCode.trim()) {
            playerSignupCode = backupData.summary.playerSignupCode.trim();
        }
    }

    if (backupData.appSettings && typeof backupData.appSettings === 'object') {
        const s = backupData.appSettings;
        if (typeof s.maintenanceMode === 'boolean') maintenanceMode = s.maintenanceMode;
        if (typeof s.customTitle === 'string') customTitle = s.customTitle;
        if (typeof s.announcementEnabled === 'boolean') announcementEnabled = s.announcementEnabled;
        if (typeof s.announcementText === 'string') announcementText = s.announcementText;
        if (Array.isArray(s.announcementImages)) announcementImages = s.announcementImages;
        if (typeof s.paymentEmail === 'string') paymentEmail = s.paymentEmail.trim() || paymentEmail;
        if (typeof s.requirePlayerCode === 'boolean') requirePlayerCode = s.requirePlayerCode;
        if (typeof s.playerSignupCode === 'string' && s.playerSignupCode.trim()) playerSignupCode = s.playerSignupCode.trim();
    }

    playerSpots = Math.max(0, 20 - players.filter(p => !(p && p.isGoalie)).length);
    await saveData('restore-selected-snapshot');

    try {
        if (typeof addAdminAuditEntry === 'function') {
            addAdminAuditEntry(auditAction, req, {
                beforePlayers: beforeCounts.players,
                beforeWaitlist: beforeCounts.waitlist,
                afterPlayers: players.length,
                afterWaitlist: waitlist.length,
                snapshotFile: item.file,
                snapshotSource: item.source || 'local',
                snapshotSavedAt: item.savedAt || null,
                snapshotKey: item.snapshotKey,
                fingerprint: item.fingerprint
            });
        }
        if (typeof appendDataAudit === 'function') {
            await appendDataAudit(auditAction, 'success', {
                beforePlayers: beforeCounts.players,
                beforeWaitlist: beforeCounts.waitlist,
                afterPlayers: players.length,
                afterWaitlist: waitlist.length,
                snapshotFile: item.file,
                snapshotSource: item.source || 'local',
                snapshotSavedAt: item.savedAt || null,
                snapshotKey: item.snapshotKey,
                fingerprint: item.fingerprint
            });
        }
    } catch (auditErr) {
        console.error('Error auditing selected snapshot restore:', auditErr.message);
    }

    return {
        ok: true,
        body: {
            success: true,
            mode: 'replace',
            restoredPlayers: players.length,
            restoredWaitlist: waitlist.length,
            snapshotKey: item.snapshotKey,
            snapshotFile: item.file,
            snapshotSource: item.source || 'local',
            snapshotSavedAt: item.savedAt || null,
            snapshotReason: item.reason || null,
            fingerprint: item.fingerprint,
            message: 'Snapshot restored successfully.',
            safetySnapshot
        }
    };
}

function trimSnapshotBackups() {
    try {
        ensureDirSync(SNAPSHOT_DIR);
        const files = fs.readdirSync(SNAPSHOT_DIR)
            .filter(name => isSnapshotBackupFilename(name))
            .map(name => ({ name, full: path.join(SNAPSHOT_DIR, name), mtime: fs.statSync(path.join(SNAPSHOT_DIR, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        files.slice(SNAPSHOT_RETENTION).forEach(file => {
            try { fs.unlinkSync(file.full); } catch (err) {}
        });
    } catch (err) {
        console.error('Error trimming snapshots:', err.message);
    }
}

function persistDataToFile(reason = 'saveData', snapshot = null) {
    try {
        const payload = snapshot || buildFullDataSnapshot();
        const text = JSON.stringify(payload, null, 2);
        atomicWriteTextFile(DATA_FILE, text);

        let snapshotFile = null;
        if (shouldCreateDurableSnapshot(reason)) {
            ensureDirSync(SNAPSHOT_DIR);
            snapshotFile = path.join(SNAPSHOT_DIR, buildBackupFileName({ date: new Date(payload.savedAt || new Date()), reason: String(reason || 'save').slice(0, 40), ext: 'json', includeSeconds: true }));
            atomicWriteTextFile(snapshotFile, text);
            trimSnapshotBackups();
            updateLatestSnapshotMeta(payload, snapshotFile, reason);
        }
        writeSettingsBackup(reason);
        return { ok: true, file: snapshotFile, savedAt: payload.savedAt, durableSnapshotCreated: !!snapshotFile };
    } catch (err) {
        console.error('Error writing local data snapshot:', err.message);
        return { ok: false, error: err.message };
    }
}

function readJsonFileSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return null;
    }
}


function getBestLocalSnapshot() {
    const candidates = [];
    if (fs.existsSync(SNAPSHOT_DIR)) {
        for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
            if (!isSnapshotBackupFilename(name)) continue;
            const full = path.join(SNAPSHOT_DIR, name);
            try {
                candidates.push({ file: full, stat: fs.statSync(full) });
            } catch (err) {}
        }
    }

    let best = null;
    for (const candidate of candidates) {
        const data = readJsonFileSafe(candidate.file);
        if (!data) continue;
        const savedAtMs = Date.parse(data.savedAt || '') || candidate.stat.mtimeMs || 0;
        const score = ((Array.isArray(data.players) ? data.players.length : 0) * 1000000) +
            ((Array.isArray(data.waitlist) ? data.waitlist.length : 0) * 1000) +
            savedAtMs;
        if (!best || score > best.score) {
            best = { file: candidate.file, data, savedAtMs, score };
        }
    }

    if (best) updateLatestSnapshotMeta(best.data, best.file, 'best-local-snapshot');
    return best;
}

async function appendDataAudit(eventType, status = 'info', details = {}) {
    const entry = {
        at: new Date().toISOString(),
        eventType,
        status,
        details
    };
    recentDataAudit.push(entry);
    if (recentDataAudit.length > DATA_AUDIT_RECENT_LIMIT) recentDataAudit = recentDataAudit.slice(-DATA_AUDIT_RECENT_LIMIT);

    if (!pool) return;
    try {
        await pool.query(
            'INSERT INTO data_audit (event_type, status, details) VALUES ($1, $2, $3)',
            [eventType, status, JSON.stringify(details)]
        );
        pruneDataAuditIfNeeded().catch(err => console.error('Data audit prune error:', err.message));
    } catch (err) {
        console.error('Error writing data audit:', err.message);
    }
}

async function loadRecentDataAudit() {
    if (!pool) return;
    try {
        const result = await pool.query('SELECT event_type, status, details, created_at FROM data_audit ORDER BY id DESC LIMIT $1', [DATA_AUDIT_RECENT_LIMIT]);
        recentDataAudit = result.rows.reverse().map(row => ({
            at: row.created_at,
            eventType: row.event_type,
            status: row.status,
            details: row.details || {}
        }));
    } catch (err) {
        console.error('Error loading data audit:', err.message);
    }
}
async function pruneDataAuditIfNeeded(force = false) {
    if (!pool) return;
    const now = Date.now();
    if (!force && now - lastAuditPruneAt < DATA_AUDIT_PRUNE_INTERVAL_MS) return;
    lastAuditPruneAt = now;
    try {
        if (DATA_AUDIT_RETENTION_DAYS > 0) {
            await pool.query(
                "DELETE FROM data_audit WHERE created_at < NOW() - ($1::text || ' days')::interval",
                [String(DATA_AUDIT_RETENTION_DAYS)]
            );
        }
        if (DATA_AUDIT_MAX_ROWS > 0) {
            await pool.query(
                `DELETE FROM data_audit
                 WHERE id IN (
                     SELECT id FROM data_audit
                     ORDER BY id DESC
                     OFFSET $1
                 )`,
                [DATA_AUDIT_MAX_ROWS]
            );
        }
    } catch (err) {
        console.error('Error pruning data audit:', err.message);
    }
}


function toNumericOrNull(value) {
    const num = value == null || value === '' ? null : Number(value);
    return Number.isFinite(num) ? num : null;
}

async function replaceDatabaseStateFromMemory(reason = 'saveData', snapshot = null) {
    if (!pool) return { ok: true, mode: 'file' };
    const payload = snapshot || buildFullDataSnapshot();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const settingsEntries = [
            ['playerSpots', playerSpots],
            ['gameLocation', gameLocation],
            ['gameTime', gameTime],
            ['gameDate', gameDate],
            ['playerSignupCode', playerSignupCode],
            ['requirePlayerCode', requirePlayerCode],
            ['manualOverride', manualOverride],
            ['manualOverrideState', manualOverrideState],
            ['lastResetWeek', lastResetWeek],
            ['rosterReleased', rosterReleased],
            ['resetArmed', resetArmed],
            ['currentWeekData', currentWeekData],
            ['cancelledRegistrations', cancelledRegistrations],
            ['regularSkatersByDay', regularSkatersByDay],
            ['customSignupCode', customSignupCode],
            ['signupLockStartAt', signupLockStartAt],
            ['signupLockEndAt', signupLockEndAt],
            ['rosterReleaseAt', rosterReleaseAt],
            ['resetWeekAt', resetWeekAt],
            ['lastExactResetRunAt', lastExactResetRunAt],
            ['lastExactRosterReleaseRunAt', lastExactRosterReleaseRunAt],
            ['lastExactResetMinuteKey', lastExactResetMinuteKey],
            ['lastExactRosterReleaseMinuteKey', lastExactRosterReleaseMinuteKey],
            ['signupLockSchedule', signupLockSchedule],
            ['rosterReleaseSchedule', rosterReleaseSchedule],
            ['resetWeekSchedule', resetWeekSchedule]
        ];
        for (const [key, value] of settingsEntries) {
            await client.query(
                'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                [key, JSON.stringify(value)]
            );
        }

        const appSettingsEntries = [
            ['maintenanceMode', String(maintenanceMode)],
            ['customTitle', customTitle],
            ['announcementEnabled', announcementEnabled.toString()],
            ['announcementText', announcementText],
            ['announcementImages', JSON.stringify(announcementImages)],
            ['paymentEmail', paymentEmail],
            ['selectedDayTime', gameTime],
            ['selectedArena', gameLocation],
            ['gameDate', gameDate]
        ];
        for (const [key, value] of appSettingsEntries) {
            await client.query(
                'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                [key, value == null ? '' : String(value)]
            );
        }

        await client.query('DELETE FROM players');
        for (const player of players) {
            await client.query(
                `INSERT INTO players (
                    id, first_name, last_name, phone, payment_method, paid, paid_amount, rating,
                    skating_rating, puck_skills_rating, hockey_sense_rating, conditioning_rating, effort_rating,
                    level_played, peer_comparison, confidence_level, self_rating_raw, derived_rating,
                    admin_rating, admin_adjustment, final_rating, is_goalie, team, rules_agreed
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
                )`,
                [
                    player.id, player.firstName, player.lastName, player.phone, player.paymentMethod || null, !!player.paid,
                    toNumericOrNull(player.paidAmount), toNumericOrNull(player.rating),
                    toNumericOrNull(player.skatingRating), toNumericOrNull(player.puckSkillsRating), toNumericOrNull(player.hockeySenseRating), toNumericOrNull(player.conditioningRating), toNumericOrNull(player.effortRating),
                    player.levelPlayed || null, player.peerComparison || null, player.confidenceLevel || null, toNumericOrNull(player.selfRatingRaw), toNumericOrNull(player.derivedRating),
                    toNumericOrNull(player.adminRating), toNumericOrNull(player.adminAdjustment), toNumericOrNull(player.finalRating), !!player.isGoalie, player.team || null, !!player.rulesAgreed
                ]
            );
        }

        await client.query('DELETE FROM waitlist');
        for (const player of waitlist) {
            await client.query(
                `INSERT INTO waitlist (
                    id, first_name, last_name, phone, payment_method, rating,
                    skating_rating, puck_skills_rating, hockey_sense_rating, conditioning_rating, effort_rating,
                    level_played, peer_comparison, confidence_level, self_rating_raw, derived_rating, final_rating, is_goalie, bypass_auto_promote
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
                )`,
                [
                    player.id, player.firstName, player.lastName, player.phone, player.paymentMethod || null, toNumericOrNull(player.rating),
                    toNumericOrNull(player.skatingRating), toNumericOrNull(player.puckSkillsRating), toNumericOrNull(player.hockeySenseRating), toNumericOrNull(player.conditioningRating), toNumericOrNull(player.effortRating),
                    player.levelPlayed || null, player.peerComparison || null, player.confidenceLevel || null, toNumericOrNull(player.selfRatingRaw), toNumericOrNull(player.derivedRating), toNumericOrNull(player.finalRating), !!player.isGoalie, !!player.bypassAutoPromote
                ]
            );
        }

        const dbSnapshotResult = await insertDatabaseSnapshot(payload, reason, client);
        await client.query('COMMIT');
        return { ok: true, mode: 'postgres', players: players.length, waitlist: waitlist.length, reason, dbSnapshot: dbSnapshotResult };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function saveData(reason = 'saveData') {
    const snapshot = buildFullDataSnapshot();
    saveQueue = saveQueue.then(async () => {
        let dbResult = null;
        try {
            dbResult = await replaceDatabaseStateFromMemory(reason, snapshot);
            writeSettingsBackup(reason);
            const localResult = persistDataToFile(reason, snapshot);
            await appendDataAudit('save', 'success', { reason, database: dbResult, localSnapshot: localResult });
            return { ok: true, database: dbResult, localSnapshot: localResult };
        } catch (err) {
            const localResult = persistDataToFile(`db-failed-${reason}`, snapshot);
            await appendDataAudit('save', 'error', {
                reason,
                error: err.message,
                localSnapshot: localResult,
                strictDatabaseMode: STRICT_DATABASE_MODE,
                databaseRequired: HAS_DB
            });
            console.error('Error saving data:', err);
            return {
                ok: false,
                error: err.message,
                localSnapshot: localResult,
                strictDatabaseMode: STRICT_DATABASE_MODE,
                databaseRequired: HAS_DB
            };
        }
    }).catch(err => {
        console.error('Queued saveData error:', err.message);
        return { ok: false, error: err.message };
    });
    return saveQueue;
}

async function runDatabaseSelfHeal(reason = 'self-heal') {
    if (!pool) return { ok: false, skipped: true, reason: 'file-mode' };
    const best = await getBestAvailableSnapshot();
    if (!best || !best.data) return { ok: false, skipped: true, reason: 'no-available-snapshot' };

    try {
        const dbPlayers = await pool.query('SELECT id, phone FROM players');
        const dbWaitlist = await pool.query('SELECT id, phone FROM waitlist');
        const playerKeys = new Set(dbPlayers.rows.map(r => `${r.id}|${normalizePhoneDigits(r.phone)}`));
        const waitlistKeys = new Set(dbWaitlist.rows.map(r => `${r.id}|${normalizePhoneDigits(r.phone)}`));

        const missingPlayers = (Array.isArray(best.data.players) ? best.data.players : []).filter(player => !playerKeys.has(`${player.id}|${normalizePhoneDigits(player.phone)}`));
        const missingWaitlist = (Array.isArray(best.data.waitlist) ? best.data.waitlist : []).filter(player => !waitlistKeys.has(`${player.id}|${normalizePhoneDigits(player.phone)}`));

        if (!missingPlayers.length && !missingWaitlist.length) {
            return { ok: true, healed: false, missingPlayers: 0, missingWaitlist: 0, sourceFile: best.file };
        }

        const memoryPlayerKeys = new Set(players.map(player => `${player.id}|${normalizePhoneDigits(player.phone)}`));
        const memoryWaitlistKeys = new Set(waitlist.map(player => `${player.id}|${normalizePhoneDigits(player.phone)}`));

        for (const player of missingPlayers) {
            if (!memoryPlayerKeys.has(`${player.id}|${normalizePhoneDigits(player.phone)}`)) players.push(hydratePlayerRatingProfile(player));
        }
        for (const player of missingWaitlist) {
            if (!memoryWaitlistKeys.has(`${player.id}|${normalizePhoneDigits(player.phone)}`)) waitlist.push(hydratePlayerRatingProfile(player));
        }
        playerSpots = Math.max(0, 20 - players.filter(p => !p.isGoalie).length);
        const saveResult = await saveData(`self-heal-${reason}`);
        await appendDataAudit('self_heal', saveResult.ok ? 'success' : 'error', {
            reason, sourceFile: best.file, missingPlayers: missingPlayers.length, missingWaitlist: missingWaitlist.length, saveResult
        });
        return { ok: saveResult.ok, healed: true, missingPlayers: missingPlayers.length, missingWaitlist: missingWaitlist.length, sourceFile: best.file };
    } catch (err) {
        await appendDataAudit('self_heal', 'error', { reason, error: err.message });
        console.error('Database self-heal error:', err.message);
        return { ok: false, healed: false, error: err.message };
    }
}

function maybeSnapshotOnRequest(req) {
    if (!REQUEST_SNAPSHOT_ENABLED) return;
    const method = String(req?.method || '').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) return;
    const now = Date.now();
    if (now - lastRequestSnapshotAt < REQUEST_SNAPSHOT_MIN_INTERVAL_MS) return;
    lastRequestSnapshotAt = now;
    const snapshot = buildFullDataSnapshot();
    const result = persistDataToFile('request-visit', snapshot);
    appendDataAudit('request_snapshot', result.ok ? 'success' : 'error', {
        path: req.path || req.originalUrl || '',
        method: req.method,
        localSnapshot: result
    }).catch(() => {});
}

function maybeRunRequestSelfHeal(req) {
    if (!REQUEST_SELF_HEAL_ENABLED || !pool) return;
    const method = String(req?.method || '').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) return;
    const now = Date.now();
    if (now - lastRequestSelfHealAt < REQUEST_SELF_HEAL_MIN_INTERVAL_MS) return;
    lastRequestSelfHealAt = now;
    runDatabaseSelfHeal('request').catch(err => console.error('Request self-heal error:', err));
}


function buildFullDataSnapshot() {
    const savedAt = new Date().toISOString();
    return {
        snapshotVersion: 2,
        playerSpots,
        players,
        waitlist,
        cancelledRegistrations,
        regularSkatersByDay,
        customSignupCode,
        gameLocation,
        gameTime,
        gameDate,
        playerSignupCode,
        requirePlayerCode,
        manualOverride,
        manualOverrideState,
        lastResetWeek,
        rosterReleased,
        resetArmed,
        currentWeekData,
        signupLockStartAt,
        signupLockEndAt,
        rosterReleaseAt,
        resetWeekAt,
        lastExactResetRunAt,
        lastExactRosterReleaseRunAt,
        lastExactResetMinuteKey,
        lastExactRosterReleaseMinuteKey,
        signupLockSchedule,
        rosterReleaseSchedule,
        resetWeekSchedule,
        maintenanceMode,
        customTitle,
        announcementEnabled,
        announcementText,
        announcementImages,
        paymentEmail,
        summary: {
            gameLocation,
            gameTime,
            gameDate,
            rosterReleased,
            requirePlayerCode,
            playerSignupCode
        },
        appSettings: {
            maintenanceMode,
            customTitle,
            announcementEnabled,
            announcementText,
            announcementImages,
            paymentEmail,
            selectedDayTime: gameTime,
            selectedArena: gameLocation,
            requirePlayerCode,
            playerSignupCode
        },
        savedAt
    };
}

async function reconcileFromFileBackup() {
    if (!pool) return;

    try {
        const best = await getBestAvailableSnapshot();
        if (!best || !best.data) return;
        const backup = best.data;
        const backupPlayers = Array.isArray(backup.players) ? backup.players : [];
        const backupWaitlist = Array.isArray(backup.waitlist) ? backup.waitlist : [];

        let mergedPlayers = 0;
        for (const player of backupPlayers) {
            const exists = players.some(p =>
                String(p.id) === String(player.id) ||
                normalizePhoneDigits(p.phone) === normalizePhoneDigits(player.phone)
            );
            if (exists) continue;
            players.push(hydratePlayerRatingProfile(player));
            mergedPlayers += 1;
        }

        let mergedWaitlist = 0;
        for (const player of backupWaitlist) {
            const exists = waitlist.some(p =>
                String(p.id) === String(player.id) ||
                normalizePhoneDigits(p.phone) === normalizePhoneDigits(player.phone)
            );
            if (exists) continue;
            waitlist.push(hydratePlayerRatingProfile(player));
            mergedWaitlist += 1;
        }

        if (mergedPlayers || mergedWaitlist) {
            playerSpots = Math.max(0, 20 - players.filter(p => !p.isGoalie).length);
            console.log(`Reconciled best local snapshot into DB: ${mergedPlayers} players, ${mergedWaitlist} waitlist.`);
            await saveData('reconcile-best-local-snapshot');
        }
    } catch (err) {
        console.error('Error reconciling local backup:', err.message);
    }
}

function getSettingsSnapshot() {
    return {
        savedAt: new Date().toISOString(),
        maintenanceMode,
        customTitle,
        announcementEnabled,
        announcementText,
        announcementImages,
        paymentEmail,
        gameTime,
        gameLocation,
        gameDate,
        signupLockStartAt,
        signupLockEndAt,
        rosterReleaseAt,
        resetWeekAt,
        signupLockSchedule,
        rosterReleaseSchedule,
        resetWeekSchedule,
        requirePlayerCode,
        manualOverride,
        manualOverrideState,
        rosterReleased,
        resetArmed,
        currentWeekData,
        cancelledRegistrations,
        regularSkatersByDay,
        customSignupCode,
        lastExactResetMinuteKey,
        lastExactRosterReleaseMinuteKey
    };
}

function writeSettingsBackup(reason = 'update') {
    try {
        const snapshot = {
            reason,
            ...getSettingsSnapshot()
        };
        fs.writeFileSync(SETTINGS_BACKUP_FILE, JSON.stringify(snapshot, null, 2));
    } catch (err) {
        console.error('Error writing settings backup:', err.message);
    }
}

function validateScheduleInputs({ signupLockEnabled, signupLockStart, signupLockEnd, rosterReleaseEnabled, rosterReleaseAt, resetWeekEnabled, resetWeekAt }) {
    const lockStartParts = signupLockStart ? parseDatetimeLocalToETDate(signupLockStart) : null;
    const lockEndParts = signupLockEnd ? parseDatetimeLocalToETDate(signupLockEnd) : null;
    const releaseParts = rosterReleaseAt ? parseDatetimeLocalToETDate(rosterReleaseAt) : null;
    const resetParts = resetWeekAt ? parseDatetimeLocalToETDate(resetWeekAt) : null;

    if (signupLockEnabled) {
        if (!signupLockStart || !signupLockEnd) {
            return 'Signup lock requires both a start and end date/time.';
        }
        if (!lockStartParts || !lockEndParts) {
            return 'Signup lock dates are invalid.';
        }
        if (etPartsToMinuteKey(lockEndParts) <= etPartsToMinuteKey(lockStartParts)) {
            return 'Signup lock end must be after lock start.';
        }
    }

    if (rosterReleaseEnabled) {
        if (!rosterReleaseAt) return 'Roster release requires a valid date/time.';
        if (!releaseParts) return 'Roster release date/time is invalid.';
    }

    if (resetWeekEnabled) {
        if (!resetWeekAt) return 'Weekly reset requires a valid date/time.';
        if (!resetParts) return 'Weekly reset date/time is invalid.';
    }

    return null;
}


function generateRandomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function loadDataFromFile() {
    try {
        const bestSnapshot = getBestLocalSnapshot();
        if (bestSnapshot && bestSnapshot.data) {
            const data = bestSnapshot.data;
            playerSpots = data.playerSpots ?? 20;
            players = Array.isArray(data.players) ? data.players.map(hydratePlayerRatingProfile) : [];
            waitlist = Array.isArray(data.waitlist) ? data.waitlist.map(hydratePlayerRatingProfile) : [];
            gameLocation = data.gameLocation ?? "Capri Recreation Complex";
            gameTime = data.gameTime ?? "Friday 9:30 PM";
            gameDate = data.gameDate ?? calculateNextGameDate();
            playerSignupCode = data.playerSignupCode ?? '9855';
            requirePlayerCode = data.requirePlayerCode ?? true;
            manualOverride = data.manualOverride ?? false;
            manualOverrideState = data.manualOverrideState ?? null;
            lastResetWeek = data.lastResetWeek ?? null;
            rosterReleased = data.rosterReleased ?? false;
            resetArmed = !!data.resetArmed;
            signupLockStartAt = data.signupLockStartAt ?? '';
            signupLockEndAt = data.signupLockEndAt ?? '';
            rosterReleaseAt = data.rosterReleaseAt ?? '';
            resetWeekAt = data.resetWeekAt ?? '';
            lastExactResetRunAt = data.lastExactResetRunAt ?? '';
            lastExactRosterReleaseRunAt = data.lastExactRosterReleaseRunAt ?? '';
            lastExactResetMinuteKey = data.lastExactResetMinuteKey ?? '';
            lastExactRosterReleaseMinuteKey = data.lastExactRosterReleaseMinuteKey ?? '';
            signupLockSchedule = data.signupLockSchedule ?? signupLockSchedule;
            rosterReleaseSchedule = data.rosterReleaseSchedule ?? rosterReleaseSchedule;
            resetWeekSchedule = data.resetWeekSchedule ?? resetWeekSchedule;
            cancelledRegistrations = Array.isArray(data.cancelledRegistrations) ? data.cancelledRegistrations : [];
            regularSkatersByDay = normalizeRegularSkatersByDayMap(data.regularSkatersByDay || {});
            customSignupCode = String(data.customSignupCode || '').trim();
            currentWeekData = data.currentWeekData ?? {
                weekNumber: null,
                year: null,
                releaseDate: null,
                whiteTeam: [],
                darkTeam: []
            };
            // Load new settings
            maintenanceMode = data.maintenanceMode ?? false;
            customTitle = data.customTitle ?? `Phan's ${getGameDayName()} Hockey`;
            announcementEnabled = data.announcementEnabled ?? false;
            announcementText = data.announcementText ?? '';
            announcementImages = Array.isArray(data.announcementImages) ? data.announcementImages : [];
            if (shouldAutoBuildMissingSchedules(data)) {
                buildAutoSchedulesFromGameTime(gameTime, gameDate);
            }
            refreshDynamicSignupCode();
        } else {
            gameDate = calculateNextGameDate();
        }
    } catch (err) {
        console.error('Error loading data:', err);
        gameDate = calculateNextGameDate();
        refreshDynamicSignupCode();
    }
}

// FIX: Use ET timezone for calculateNextFriday
function calculateNextFriday() {
    return calculateNextGameDate();
}

function formatGameDate(dateString) {
    if (!dateString) return "TBD";
    const date = new Date(dateString + 'T00:00:00');
    const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

function capitalizeNamePart(part) {
    return String(part || '')
        .toLowerCase()
        .replace(/(^|[\s'-])([a-z])/g, (m, sep, chr) => sep + chr.toUpperCase());
}

function capitalizeFullName(name) {
    return String(name || '')
        .trim()
        .split(/\s+/)
        .map(capitalizeNamePart)
        .join(' ');
}

function normalizePhoneDigits(phone) {
    let cleaned = String(phone || '').replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        cleaned = cleaned.slice(1);
    }
    return cleaned;
}


function appendCancellationLog(entry) {
    const normalized = {
        id: entry && entry.id !== undefined ? entry.id : Date.now(),
        firstName: String(entry?.firstName || '').trim(),
        lastName: String(entry?.lastName || '').trim(),
        phone: String(entry?.phone || '').trim(),
        rating: entry?.rating ?? null,
        isGoalie: !!entry?.isGoalie,
        paymentMethod: entry?.paymentMethod ?? '',
        source: entry?.source || 'player',
        action: entry?.action || 'cancelled',
        cancelledAt: entry?.cancelledAt || new Date().toISOString(),
        cancelledBy: entry?.cancelledBy || 'player',
        notes: entry?.notes || ''
    };
    cancelledRegistrations = Array.isArray(cancelledRegistrations) ? cancelledRegistrations : [];
    cancelledRegistrations.unshift(normalized);
    if (cancelledRegistrations.length > 250) {
        cancelledRegistrations = cancelledRegistrations.slice(0, 250);
    }
    return normalized;
}

function validatePhoneNumber(phone) {
    const cleaned = normalizePhoneDigits(phone);
    return cleaned.length === 10;
}

function formatPhoneNumber(phone) {
    const cleaned = normalizePhoneDigits(phone);
    const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (match) {
        return '(' + match[1] + ') ' + match[2] + '-' + match[3];
    }
    return phone;
}


function clampRating(value, min = 1, max = 10) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.max(min, Math.min(max, num));
}

function roundRating(value) {
    return Math.round(clampRating(value) * 10) / 10;
}

const LEVEL_PLAY_RATING_MAP = {
    beginner: 4.0,
    intermediate: 5.5,
    competitive: 7.0,
    junior: 8.5
};

const LEVEL_PLAY_BOOST_MAP = {
    beginner: 0.0,
    intermediate: 0.2,
    competitive: 0.45,
    junior: 0.7
};

function normalizeSkillProfile(input = {}) {
    const ratingMode = String(input.ratingMode || '').toLowerCase() === 'direct' ? 'direct' : 'profile';

    if (ratingMode === 'direct') {
        const directRatingNum = Number(input.directRating ?? input.rating);
        const missing = [];
        if (!Number.isFinite(directRatingNum)) missing.push('direct rating');
        const directRating = roundRating(directRatingNum);
        return {
            ratingMode: 'direct',
            directRating,
            skatingRating: null,
            puckSkillsRating: null,
            hockeySenseRating: null,
            conditioningRating: null,
            effortRating: null,
            levelPlayed: '',
            peerComparison: '',
            confidenceLevel: '',
            selfRatingRaw: directRating,
            derivedRating: directRating,
            finalRating: directRating,
            adminRating: null,
            adminAdjustment: 0,
            missing
        };
    }

    const skating = clampRating(input.skatingRating);
    const puckSkills = clampRating(input.puckSkillsRating);
    const hockeySense = clampRating(input.hockeySenseRating);
    const conditioning = clampRating(input.conditioningRating);
    const effort = clampRating(input.effortRating);

    const levelPlayed = ['beginner', 'intermediate', 'competitive', 'junior'].includes(String(input.levelPlayed || '').toLowerCase())
        ? String(input.levelPlayed).toLowerCase()
        : '';

    const missing = [];
    if (!Number.isFinite(Number(input.skatingRating))) missing.push('skating');
    if (!Number.isFinite(Number(input.puckSkillsRating))) missing.push('puck control');
    if (!Number.isFinite(Number(input.hockeySenseRating))) missing.push('hockey IQ');
    if (!Number.isFinite(Number(input.conditioningRating))) missing.push('conditioning');
    if (!Number.isFinite(Number(input.effortRating))) missing.push('compete / effort');
    if (!levelPlayed) missing.push('highest recent level played');

    const weightedSkill = roundRating(
        (skating * 0.24) +
        (puckSkills * 0.20) +
        (hockeySense * 0.28) +
        (conditioning * 0.08) +
        (effort * 0.14)
    );
    const levelMapped = LEVEL_PLAY_RATING_MAP[levelPlayed] || 5.5;
    const derivedRating = roundRating((weightedSkill * 0.94) + (levelMapped * 0.06));

    return {
        ratingMode: 'profile',
        directRating: null,
        skatingRating: skating,
        puckSkillsRating: puckSkills,
        hockeySenseRating: hockeySense,
        conditioningRating: conditioning,
        effortRating: effort,
        levelPlayed,
        peerComparison: '',
        confidenceLevel: '',
        selfRatingRaw: weightedSkill,
        derivedRating,
        finalRating: derivedRating,
        adminRating: null,
        adminAdjustment: 0,
        missing
    };
}

function hydratePlayerRatingProfile(player = {}) {
    const fallbackRating = roundRating(player.rating ?? player.finalRating ?? player.derivedRating ?? 5);
    const finalRating = roundRating(player.finalRating ?? player.rating ?? player.adminRating ?? player.derivedRating ?? fallbackRating);
    const derivedRating = roundRating(player.derivedRating ?? finalRating);
    const adminRating = player.adminRating == null ? null : roundRating(player.adminRating);
    const adminAdjustment = roundRating(player.adminAdjustment ?? ((adminRating == null ? finalRating : adminRating) - derivedRating));

    return {
        ...player,
        skatingRating: clampRating(player.skatingRating ?? derivedRating),
        puckSkillsRating: clampRating(player.puckSkillsRating ?? derivedRating),
        hockeySenseRating: clampRating(player.hockeySenseRating ?? derivedRating),
        conditioningRating: clampRating(player.conditioningRating ?? derivedRating),
        effortRating: clampRating(player.effortRating ?? derivedRating),
        levelPlayed: player.levelPlayed || '',
        peerComparison: player.peerComparison || '',
        confidenceLevel: player.confidenceLevel || '',
        selfRatingRaw: roundRating(player.selfRatingRaw ?? derivedRating),
        derivedRating,
        adminRating,
        adminAdjustment,
        finalRating,
        rating: finalRating
    };
}

function buildPlayerFromSkillProfile(basePlayer, skillProfile = {}) {
    const profile = normalizeSkillProfile(skillProfile);
    return hydratePlayerRatingProfile({
        ...basePlayer,
        skatingRating: profile.skatingRating,
        puckSkillsRating: profile.puckSkillsRating,
        hockeySenseRating: profile.hockeySenseRating,
        conditioningRating: profile.conditioningRating,
        effortRating: profile.effortRating,
        levelPlayed: profile.levelPlayed,
        peerComparison: profile.peerComparison,
        confidenceLevel: profile.confidenceLevel,
        selfRatingRaw: profile.selfRatingRaw,
        derivedRating: profile.derivedRating,
        adminRating: null,
        adminAdjustment: 0,
        finalRating: profile.finalRating,
        rating: profile.finalRating
    });
}


function getNextAutoPromoteWaitlistIndex() {
    return waitlist.findIndex(p => p && p.bypassAutoPromote !== true);
}

function extractWaitlistPlayerToPromote() {
    const index = getNextAutoPromoteWaitlistIndex();
    if (index === -1) return null;
    const [player] = waitlist.splice(index, 1);
    return player || null;
}

function isDuplicatePlayer(firstName, lastName, phone) {
    const normalizedName = (capitalizeFullName(firstName) + ' ' + capitalizeFullName(lastName)).toLowerCase().trim();
    const normalizedPhone = normalizePhoneDigits(phone);
    
    const inPlayers = players.find(p => 
        (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
        p.phone.replace(/\D/g, '') === normalizedPhone
    );
    
    const inWaitlist = waitlist.find(p => 
        (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
        p.phone.replace(/\D/g, '') === normalizedPhone
    );
    
    return inPlayers || inWaitlist;
}

function getPlayerCount() {
    return players.filter(p => !p.isGoalie).length;
}

function getGoalieCount() {
    return players.filter(p => p.isGoalie).length;
}

function isGoalieSpotsAvailable() {
    return getGoalieCount() < MAX_GOALIES;
}

function getLevelPlayedBoost(levelPlayed) {
    return LEVEL_PLAY_BOOST_MAP[String(levelPlayed || '').toLowerCase()] ?? 0;
}

function getPlayerProfileScore(player) {
    const profile = hydratePlayerRatingProfile(player);
    return roundRating(
        (profile.skatingRating * 0.24) +
        (profile.puckSkillsRating * 0.20) +
        (profile.hockeySenseRating * 0.28) +
        (profile.conditioningRating * 0.08) +
        (profile.effortRating * 0.14) +
        (getLevelPlayedBoost(profile.levelPlayed) * 0.06)
    );
}

function getPlayerBalanceScore(player) {
    const profile = hydratePlayerRatingProfile(player);
    const finalRating = roundRating(profile.finalRating ?? profile.rating ?? 5);
    const profileScore = getPlayerProfileScore(profile);
    return roundRating((finalRating * 0.75) + (profileScore * 0.25));
}

function summarizeTeamMetrics(team = []) {
    const skaters = team.filter(p => !p.isGoalie);
    const goalies = team.filter(p => p.isGoalie);

    const sumField = (arr, getter) => arr.reduce((sum, item) => sum + getter(hydratePlayerRatingProfile(item)), 0);
    const goalieImpact = goalies.reduce((sum, goalie) => sum + (getPlayerBalanceScore(goalie) * 1.25), 0);

    return {
        skaterCount: skaters.length,
        totalBalance: sumField(skaters, p => getPlayerBalanceScore(p)) + goalieImpact,
        skating: sumField(skaters, p => p.skatingRating),
        puckSkills: sumField(skaters, p => p.puckSkillsRating),
        hockeySense: sumField(skaters, p => p.hockeySenseRating),
        conditioning: sumField(skaters, p => p.conditioningRating),
        effort: sumField(skaters, p => p.effortRating),
        goalieImpact,
        averageFinalRating: team.length ? roundRating(sumField(team, p => p.finalRating ?? p.rating ?? 5) / team.length) : 0
    };
}

function computeTeamBalanceObjective(whiteTeam = [], darkTeam = []) {
    const white = summarizeTeamMetrics(whiteTeam);
    const dark = summarizeTeamMetrics(darkTeam);

    return (
        Math.abs(white.totalBalance - dark.totalBalance) * 1.0 +
        Math.abs(white.skating - dark.skating) * 0.9 +
        Math.abs(white.hockeySense - dark.hockeySense) * 1.1 +
        Math.abs(white.effort - dark.effort) * 0.7 +
        Math.abs(white.puckSkills - dark.puckSkills) * 0.45 +
        Math.abs(white.conditioning - dark.conditioning) * 0.35 +
        Math.abs(white.goalieImpact - dark.goalieImpact) * 1.1 +
        Math.abs(white.skaterCount - dark.skaterCount) * 2.0
    );
}

function generateFairTeams() {
    const sortByBalance = (a, b) => {
        const diff = getPlayerBalanceScore(b) - getPlayerBalanceScore(a);
        if (diff !== 0) return diff;
        const nameA = `${a.firstName} ${a.lastName}`.toLowerCase();
        const nameB = `${b.firstName} ${b.lastName}`.toLowerCase();
        return nameA.localeCompare(nameB);
    };

    const goalies = players.filter(p => p.isGoalie).map(hydratePlayerRatingProfile).sort(sortByBalance);
    const skaters = players.filter(p => !p.isGoalie).map(hydratePlayerRatingProfile).sort(sortByBalance);

    let whiteTeam = [];
    let darkTeam = [];

    if (goalies.length >= 2) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        darkTeam.push({ ...goalies[1], team: 'Dark' });
        for (let i = 2; i < goalies.length; i += 1) {
            const goalie = goalies[i];
            const addWhite = [...whiteTeam, { ...goalie, team: 'White' }];
            const addDark = [...darkTeam, { ...goalie, team: 'Dark' }];
            const whiteScore = computeTeamBalanceObjective(addWhite, darkTeam);
            const darkScore = computeTeamBalanceObjective(whiteTeam, addDark);
            if (whiteScore <= darkScore) {
                whiteTeam = addWhite;
            } else {
                darkTeam = addDark;
            }
        }
    } else if (goalies.length === 1) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
    }

    const tierSize = Math.max(2, Math.min(4, Math.ceil(skaters.length / 5) || 2));
    let snakeLeftToRight = true;

    for (let start = 0; start < skaters.length; start += tierSize) {
        const tier = skaters.slice(start, start + tierSize);
        const preferredOrder = snakeLeftToRight ? ['White', 'Dark'] : ['Dark', 'White'];

        tier.forEach((skater, index) => {
            const preferredTeam = preferredOrder[index % preferredOrder.length];
            const tryWhite = [...whiteTeam, { ...skater, team: 'White' }];
            const tryDark = [...darkTeam, { ...skater, team: 'Dark' }];
            const whiteObjective = computeTeamBalanceObjective(tryWhite, darkTeam) + (preferredTeam === 'White' ? -0.08 : 0);
            const darkObjective = computeTeamBalanceObjective(whiteTeam, tryDark) + (preferredTeam === 'Dark' ? -0.08 : 0);

            if (whiteObjective <= darkObjective) {
                whiteTeam = tryWhite;
            } else {
                darkTeam = tryDark;
            }
        });

        snakeLeftToRight = !snakeLeftToRight;
    }

    let improved = true;
    let guard = 0;
    while (improved && guard < 60) {
        improved = false;
        guard += 1;
        let bestSwap = null;
        const currentObjective = computeTeamBalanceObjective(whiteTeam, darkTeam);

        for (const whitePlayer of whiteTeam.filter(p => !p.isGoalie)) {
            for (const darkPlayer of darkTeam.filter(p => !p.isGoalie)) {
                const nextWhite = whiteTeam
                    .filter(p => p.id !== whitePlayer.id)
                    .concat({ ...darkPlayer, team: 'White' });
                const nextDark = darkTeam
                    .filter(p => p.id !== darkPlayer.id)
                    .concat({ ...whitePlayer, team: 'Dark' });

                const nextObjective = computeTeamBalanceObjective(nextWhite, nextDark);
                if (nextObjective + 0.01 < currentObjective) {
                    if (!bestSwap || nextObjective < bestSwap.objective) {
                        bestSwap = {
                            whiteId: whitePlayer.id,
                            darkId: darkPlayer.id,
                            objective: nextObjective,
                            nextWhite,
                            nextDark
                        };
                    }
                }
            }
        }

        if (bestSwap) {
            whiteTeam = bestSwap.nextWhite;
            darkTeam = bestSwap.nextDark;
            improved = true;
        }
    }

    const sortTeamForDisplay = (team) => team.sort((a, b) => {
        if (a.isGoalie && !b.isGoalie) return -1;
        if (!a.isGoalie && b.isGoalie) return 1;
        return `${a.firstName} ${a.lastName}`.toLowerCase().localeCompare(`${b.firstName} ${b.lastName}`.toLowerCase());
    });

    whiteTeam = sortTeamForDisplay(whiteTeam.map(p => ({ ...p, team: 'White' })));
    darkTeam = sortTeamForDisplay(darkTeam.map(p => ({ ...p, team: 'Dark' })));

    players = [...whiteTeam, ...darkTeam];

    const whiteMetrics = summarizeTeamMetrics(whiteTeam);
    const darkMetrics = summarizeTeamMetrics(darkTeam);

    return {
        whiteTeam,
        darkTeam,
        whiteRating: whiteMetrics.averageFinalRating,
        darkRating: darkMetrics.averageFinalRating,
        whiteBalance: roundRating(whiteMetrics.totalBalance),
        darkBalance: roundRating(darkMetrics.totalBalance)
    };
}

function escapeCsvValue(value) {
    if (value === null || value === undefined) return '';
    const str = String(value)
        .replaceAll('\r\n', ' ')
        .replaceAll('\n', ' ')
        .replaceAll('\r', ' ');
    return `"${str.replace(/"/g, '""')}"`;
}

function buildPaymentReportCsv() {
    const headers = ['Team', 'First Name', 'Last Name', 'Phone', 'Rating', 'Payment Method', 'Paid Amount', 'Payment Status', 'Goalie', 'Registered At'];
    const csvRows = [headers.join(',')];

    const addPlayerRow = (teamLabel, p, dateValue) => {
        const row = [
            escapeCsvValue(teamLabel),
            escapeCsvValue(p.firstName),
            escapeCsvValue(p.lastName),
            escapeCsvValue(p.phone),
            escapeCsvValue(roundRating(p.finalRating ?? p.rating ?? 0)),
            escapeCsvValue(p.paymentMethod || 'N/A'),
            escapeCsvValue(p.paidAmount == null ? 0 : p.paidAmount),
            escapeCsvValue(p.paid ? 'PAID' : 'UNPAID'),
            escapeCsvValue(p.isGoalie ? 'YES' : 'NO'),
            escapeCsvValue(dateValue ? new Date(dateValue).toLocaleString('en-US') : '')
        ];
        csvRows.push(row.join(','));
    };

    const whiteTeam = players.filter(p => p.team === 'White' || (!p.team && !rosterReleased));
    whiteTeam.forEach(p => addPlayerRow('White', p, p.registeredAt));

    const darkTeam = players.filter(p => p.team === 'Dark');
    darkTeam.forEach(p => addPlayerRow('Dark', p, p.registeredAt));

    const unassigned = players.filter(p => !p.team && rosterReleased);
    unassigned.forEach(p => addPlayerRow('Unassigned', p, p.registeredAt));

    waitlist.forEach((p, index) => {
        const row = [
            escapeCsvValue(`Waitlist #${index + 1}`),
            escapeCsvValue(p.firstName),
            escapeCsvValue(p.lastName),
            escapeCsvValue(p.phone),
            escapeCsvValue(roundRating(p.finalRating ?? p.rating ?? 0)),
            escapeCsvValue(p.paymentMethod || 'N/A'),
            escapeCsvValue('N/A'),
            escapeCsvValue('N/A'),
            escapeCsvValue(p.isGoalie ? 'YES' : 'NO'),
            escapeCsvValue(p.joinedAt ? new Date(p.joinedAt).toLocaleString('en-US') : '')
        ];
        csvRows.push(row.join(','));
    });

    const totalCollected = players.reduce((sum, p) => sum + (parseFloat(p.paidAmount) || 0), 0);
    const paidCount = players.filter(p => p.paid && !p.isGoalie && !(p.firstName === 'Phan' && p.lastName === 'Ly')).length;
    const unpaidCount = players.filter(p => !p.paid && !p.isGoalie && !(p.firstName === 'Phan' && p.lastName === 'Ly')).length;

    csvRows.push('');
    csvRows.push([escapeCsvValue('SUMMARY'), '', '', '', '', '', '', '', '', ''].join(','));
    csvRows.push([escapeCsvValue('Total Collected'), escapeCsvValue(`$${totalCollected.toFixed(2)}`), '', '', '', '', '', '', '', ''].join(','));
    csvRows.push([escapeCsvValue('Paid Players'), escapeCsvValue(paidCount), '', '', '', '', '', '', '', ''].join(','));
    csvRows.push([escapeCsvValue('Unpaid Players'), escapeCsvValue(unpaidCount), '', '', '', '', '', '', '', ''].join(','));

    return csvRows.join('\n');
}

async function savePaymentReportSnapshot(triggerSource = 'manual') {
    if (!pool) {
        console.log('Payment report snapshot skipped: database unavailable.');
        return null;
    }

    try {
        const etTime = getCurrentETTime();
        const weekInfo = getWeekNumber(etTime);
        const activeWeek = currentWeekData && currentWeekData.weekNumber ? currentWeekData.weekNumber : weekInfo.week;
        const activeYear = currentWeekData && currentWeekData.year ? currentWeekData.year : weekInfo.year;
        const safeGameDate = gameDate || etTime.toISOString().split('T')[0];
        const reportName = buildBackupFileName({ date: etTime, reason: `payment-report-week-${activeWeek}`, ext: 'csv', includeSeconds: true });
        const csvContent = buildPaymentReportCsv();

        const result = await pool.query(
            `INSERT INTO payment_reports (
                report_name, report_csv, trigger_source, game_location, game_time, game_date,
                roster_released, week_number, year, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING id, report_name, created_at, trigger_source, week_number, year`,
            [
                reportName,
                csvContent,
                triggerSource,
                gameLocation,
                gameTime,
                safeGameDate,
                rosterReleased,
                activeWeek,
                activeYear,
                new Date()
            ]
        );

        return result.rows[0] || null;
    } catch (err) {
        console.error('Error saving payment report snapshot:', err);
        return null;
    }
}

async function listPaymentReports(limit = 25) {
    if (!pool) return [];
    try {
        const cappedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 25, 100));
        const res = await pool.query(
            `SELECT id, report_name, trigger_source, game_location, game_time, game_date, roster_released, week_number, year, created_at
             FROM payment_reports
             ORDER BY created_at DESC, id DESC
             LIMIT $1`,
            [cappedLimit]
        );
        return res.rows;
    } catch (err) {
        console.error('Error listing payment reports:', err);
        return [];
    }
}

async function getPaymentReportById(reportId) {
    if (!pool) return null;
    try {
        const res = await pool.query(
            `SELECT id, report_name, report_csv, trigger_source, game_location, game_time, game_date, roster_released, week_number, year, created_at
             FROM payment_reports
             WHERE id = $1`,
            [reportId]
        );
        return res.rows[0] || null;
    } catch (err) {
        console.error('Error reading payment report:', err);
        return null;
    }
}

async function getLatestPaymentReport() {
    if (!pool) return null;
    try {
        const res = await pool.query(
            `SELECT id, report_name, report_csv, trigger_source, game_location, game_time, game_date, roster_released, week_number, year, created_at
             FROM payment_reports
             ORDER BY created_at DESC, id DESC
             LIMIT 1`
        );
        return res.rows[0] || null;
    } catch (err) {
        console.error('Error reading latest payment report:', err);
        return null;
    }
}

async function deletePaymentReportById(reportId) {
    if (!pool) {
        return { success: false, error: 'Payment report snapshots require database storage.' };
    }
    try {
        const res = await pool.query(
            'DELETE FROM payment_reports WHERE id = $1 RETURNING id',
            [reportId]
        );

        if (res.rowCount > 0) {
            return { success: true, deleted: res.rowCount };
        }

        return { success: false, error: 'Payment report not found.' };
    } catch (err) {
        console.error('Error deleting payment report:', err);
        return { success: false, error: err.message };
    }
}

async function saveWeekHistory(year, weekNumber, whiteTeam, darkTeam) {
    try {
        // Add payment info to team data before saving
        const whiteTeamWithPayment = whiteTeam.map(p => ({
            ...p,
            paid: p.paid,
            paidAmount: p.paidAmount,
            paymentMethod: p.paymentMethod
        }));
        
        const darkTeamWithPayment = darkTeam.map(p => ({
            ...p,
            paid: p.paid,
            paidAmount: p.paidAmount,
            paymentMethod: p.paymentMethod
        }));
        
        const whiteAvg = (whiteTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0) / whiteTeam.length).toFixed(1);
        const darkAvg = (darkTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0) / darkTeam.length).toFixed(1);
        
        await pool.query(
            `INSERT INTO history (week_number, year, release_date, game_location, game_time, game_date, white_team, dark_team, white_avg, dark_avg)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                weekNumber,
                year,
                new Date(),
                gameLocation,
                gameTime,
                gameDate,
                JSON.stringify(whiteTeamWithPayment),
                JSON.stringify(darkTeamWithPayment),
                whiteAvg,
                darkAvg
            ]
        );
    } catch (err) {
        console.error('Error saving week history:', err);
    }
}

async function getHistoryList() {
    try {
        const res = await pool.query(
            'SELECT week_number, year, release_date FROM history ORDER BY year DESC, week_number DESC'
        );
        return res.rows.map(row => ({
            weekNumber: row.week_number,
            year: row.year,
            created: row.release_date
        }));
    } catch (err) {
        console.error('Error reading history:', err);
        return [];
    }
}

async function getWeekHistory(year, weekNumber) {
    try {
        const res = await pool.query(
            'SELECT * FROM history WHERE year = $1 AND week_number = $2',
            [year, weekNumber]
        );
        
        if (res.rows.length > 0) {
            const row = res.rows[0];
            return {
                weekNumber: row.week_number,
                year: row.year,
                releaseDate: row.release_date,
                gameLocation: row.game_location,
                gameTime: row.game_time,
                gameDate: row.game_date,
                whiteTeam: row.white_team,
                darkTeam: row.dark_team,
                whiteTeamAvg: row.white_avg,
                darkTeamAvg: row.dark_avg
            };
        }
        return null;
    } catch (err) {
        console.error('Error reading week history:', err);
        return null;
    }
}

async function deleteWeekHistory(year, weekNumber) {
    try {
        const res = await pool.query(
            'DELETE FROM history WHERE year = $1 AND week_number = $2 RETURNING *',
            [year, weekNumber]
        );
        
        if (res.rowCount > 0) {
            return { success: true, deleted: res.rowCount };
        } else {
            return { success: false, error: "Week not found in history" };
        }
    } catch (err) {
        console.error('Error deleting history:', err);
        return { success: false, error: err.message };
    }
}

// --- ROUTES ---

// Debug routes
app.get('/api/debug-time', (req, res) => {
    const now = new Date();
    const etTime = getCurrentETTime();
    const shouldLock = shouldBeLocked();
    
    res.json({
        systemTime: now.toISOString(),
        etTime: etTime.toISOString(),
        etDay: etTime.getDay(),
        etHour: etTime.getHours(),
        shouldBeLocked: shouldLock,
        "schedule": "Locked: Fri 5pm - Mon 6pm, Reset: Sat 12am",
        requirePlayerCode: requirePlayerCode,
        manualOverride: manualOverride,
        rosterReleased: rosterReleased
    });
});

app.get('/api/force-check', (req, res) => {
    const result = checkAutoLock();
    res.json({ 
        message: 'Lock check forced',
        ...result,
        timestamp: new Date().toISOString()
    });
});

// HTML Page Routes - Fixed to use root-relative paths
function sendPublic(res, filename) {
    const p1 = path.join(__dirname, 'public', filename);
    const p2 = path.join(__dirname, filename);
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    return res.status(404).send(`Missing ${filename}. Put it in /public or repo root.`);
}

app.get('/admin', (req, res) => {
    return sendPublic(res, 'admin.html');
});

app.get('/admin-phan-puck-you-9648.html', (req, res) => {
    return sendPublic(res, 'admin.html');
});

app.get('/waitlist', (req, res) => {
    return sendPublic(res, 'waitlist.html');
});

app.get('/roster', (req, res) => {
    return sendPublic(res, 'roster.html');
});

app.get('/history', (req, res) => {
    return sendPublic(res, 'history.html');
});

app.get('/rules', (req, res) => {
    return sendPublic(res, 'rules.html');
});

// Root route must be last among HTML routes
app.get('/', (req, res) => {
    return sendPublic(res, 'index.html');
});



function formatETDateTimeLong(etParts) {
    if (!etParts) return '';

    const base = new Date(Date.UTC(etParts.year, etParts.month - 1, etParts.day));
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'long'
    }).format(base);
    const monthName = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'long'
    }).format(base);
    const hour12 = ((etParts.hour + 11) % 12) + 1;
    const ampm = etParts.hour >= 12 ? 'PM' : 'AM';

    return `${weekday}, ${monthName} ${etParts.day}, ${etParts.year} at ${hour12}:${String(etParts.minute).padStart(2, '0')} ${ampm} ET`;
}

function etPartsToIso(etParts) {
    if (!etParts) return null;

    const probe = new Date(Date.UTC(etParts.year, etParts.month - 1, etParts.day, 12, 0, 0));
    const tzName = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'short'
    }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'EST';

    const offset = tzName === 'EDT' ? '-04:00' : '-05:00';

    return `${String(etParts.year).padStart(4, '0')}-${String(etParts.month).padStart(2, '0')}-${String(etParts.day).padStart(2, '0')}T${String(etParts.hour).padStart(2, '0')}:${String(etParts.minute).padStart(2, '0')}:00${offset}`;
}

function getSignupOpenMessageData() {
    const etNow = getCurrentETTime();
    const nextOpenAt = (signupLockSchedule && signupLockSchedule.enabled && signupLockSchedule.end)
        ? getCurrentOrNextOccurrenceEtParts(signupLockSchedule.end, etNow)
        : null;
    const openLabel = nextOpenAt ? formatETDateTimeLong(nextOpenAt) : null;

    const releaseAtParts = (rosterReleaseSchedule && rosterReleaseSchedule.enabled && rosterReleaseSchedule.at)
        ? getCurrentOrNextOccurrenceEtParts(rosterReleaseSchedule.at, etNow)
        : null;
    const rosterReleaseLabel = releaseAtParts ? formatETDateTimeLong(releaseAtParts) : null;

    const gameDayName = getGameDayName();

    return {
        gameDayName,
        nextOpenAtIso: etPartsToIso(nextOpenAt),
        nextOpenAtLabel: openLabel,
        lockNoticeLine: '',
        openLine: openLabel
            ? `✅ Signup opens to all players on ${openLabel}`
            : '✅ Signup opens to all players at the scheduled unlock time',
        noCodeLine: 'No code required after signup opens to all players.',
        rosterReleaseAtIso: etPartsToIso(releaseAtParts),
        rosterReleaseLabel,
        rosterReleaseHeadline: rosterReleaseLabel
            ? `📅 Check Back ${rosterReleaseLabel}`
            : `📅 Check Back ${gameDayName} at the scheduled roster release time`,
        rosterReleaseLine: rosterReleaseLabel
            ? `Team rosters are released on ${rosterReleaseLabel}`
            : 'Team rosters are released weekly at the scheduled ET time'
    };
}

// ============================================
// MODIFIED PUBLIC API - ADD MAINTENANCE MODE & CUSTOM TITLE
// ============================================
app.get('/api/status', (req, res) => {
    const lockStatus = checkAutoLock();
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    const signupMessageData = getSignupOpenMessageData();
    
    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    
    // STRIP all sensitive data from public players list
    // Players see: id, name, goalie status, cancel permission ONLY
    const publicPlayers = players.map(p => ({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        isGoalie: p.isGoalie,
        // Phan Ly cannot cancel from signup page - only admin can remove
        canCancel: !p.isGoalie && !(p.firstName.toLowerCase() === 'phan' && p.lastName.toLowerCase() === 'ly')
        // EXCLUDED: rating, paid, paidAmount, paymentMethod, phone
    }));

    const publicWaitlist = waitlist.map((p, index) => ({
        id: p.id,
        position: index + 1,
        firstName: p.firstName,
        lastName: p.lastName,
        fullName: `${p.firstName} ${p.lastName}`.trim(),
        isGoalie: p.isGoalie
    }));
    
    res.json({
        playerSpotsRemaining: playerSpots > 0 ? playerSpots : 0,
        goalieCount: goalieCount,
        goalieSpotsAvailable: MAX_GOALIES - goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        isFull: playerSpots === 0,
        waitlistCount: waitlist.length,
        waitlist: publicWaitlist,
        requireCode: requirePlayerCode,
        signupLocked: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow,
        manualOverride: lockStatus.manualOverride,
        manualOverrideState: lockStatus.manualOverrideState,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        rosterReleased: rosterReleased,
        resetArmed: resetArmed,
        noShowPolicy: NO_SHOW_POLICY_TEXT,
        rosterReleaseTime: currentWeekData.rosterReleaseTime,
        currentWeek: week,
        currentYear: year,
        rules: GAME_RULES,
        players: publicPlayers,  // Sanitized - no ratings, no payment info
        // NEW FIELDS - ADD THESE
        maintenanceMode: maintenanceMode,
        customTitle: customTitle,
        announcementEnabled: announcementEnabled,
        announcementText: announcementText,
        announcementImages: announcementImages,
        paymentEmail: paymentEmail,
        arenaOptions: ARENA_OPTIONS,
        dayTimeOptions: DAY_TIME_OPTIONS,
        gameDayName: signupMessageData.gameDayName,
        nextOpenAt: signupMessageData.nextOpenAtIso,
        nextOpenAtLabel: signupMessageData.nextOpenAtLabel,
        lockNoticeLine: signupMessageData.lockNoticeLine,
        openLine: signupMessageData.openLine,
        noCodeLine: signupMessageData.noCodeLine,
        rosterReleaseAt: signupMessageData.rosterReleaseAtIso,
        rosterReleaseLabel: signupMessageData.rosterReleaseLabel,
        rosterReleaseHeadline: signupMessageData.rosterReleaseHeadline,
        rosterReleaseLine: signupMessageData.rosterReleaseLine,
        noShowPolicy: NO_SHOW_POLICY_TEXT,
        cancellationDeadlineLine: 'Cancellation closes at roster release.'
    });
});

app.get('/api/waitlist', (req, res) => {
    // Waitlist view supports self-cancel, so include the id but keep private data hidden.
    const waitlistNames = waitlist.map((p, index) => ({
        id: p.id,
        position: index + 1,
        firstName: p.firstName,
        lastName: p.lastName,
        fullName: `${p.firstName} ${p.lastName}`,
        isGoalie: p.isGoalie,
        canCancel: !rosterReleased && !(String(p.firstName || '').toLowerCase() === 'phan' && String(p.lastName || '').toLowerCase() === 'ly')
        // EXCLUDED: rating, phone, paymentMethod
    }));
    
    res.json({
        waitlist: waitlistNames,
        totalWaitlist: waitlist.length,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        rosterReleased
    });
});

app.get('/api/roster', (req, res) => {
    if (!rosterReleased) {
        const signupMessageData = getSignupOpenMessageData();
        return res.json({
            released: false,
            message: "Roster has not been released yet",
            releaseTime: signupMessageData.rosterReleaseLine || "Teams will be released at the scheduled time"
        });
    }
    
    const sortPlayers = (a, b) => {
        if (a.isGoalie && !b.isGoalie) return -1;
        if (!a.isGoalie && b.isGoalie) return 1;
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    };
    
    // STRIP all sensitive data from public roster
    // Players see: name, goalie status ONLY
    const sanitizePlayer = (p) => ({
        firstName: p.firstName,
        lastName: p.lastName,
        isGoalie: p.isGoalie
        // EXCLUDED: id, rating, paid, paidAmount, paymentMethod, phone, team
    });
    
    const whiteTeam = players.filter(p => p.team === 'White').sort(sortPlayers).map(sanitizePlayer);
    const darkTeam = players.filter(p => p.team === 'Dark').sort(sortPlayers).map(sanitizePlayer);
    
    const whiteRating = players.filter(p => p.team === 'White').reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0);
    const darkRating = players.filter(p => p.team === 'Dark').reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0);
    
    res.json({
        released: true,
        whiteTeam,
        darkTeam,
        whiteRating: (whiteRating / whiteTeam.length).toFixed(1),
        darkRating: (darkRating / darkTeam.length).toFixed(1),
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        weekNumber: currentWeekData.weekNumber,
        year: currentWeekData.year
    });
});

// History API - Public (no payment data shown)
app.get('/api/history', async (req, res) => {
    const history = await getHistoryList();
    res.json({ history });
});

app.get('/api/history/:year/:week', async (req, res) => {
    const { year, week } = req.params;
    const weekData = await getWeekHistory(parseInt(year), parseInt(week));
    
    if (weekData) {
        // Sanitize historical data too
        const sanitizeHistoricalPlayer = (p) => ({
            firstName: p.firstName,
            lastName: p.lastName,
            isGoalie: p.isGoalie
            // EXCLUDED: rating, paid, paidAmount, paymentMethod, phone
        });
        
        const sanitizedData = {
            ...weekData,
            whiteTeam: weekData.whiteTeam.map(sanitizeHistoricalPlayer),
            darkTeam: weekData.darkTeam.map(sanitizeHistoricalPlayer)
        };
        
        res.json(sanitizedData);
    } else {
        res.status(404).json({ error: "Week not found" });
    }
});

app.delete('/api/admin/history/:year/:week', async (req, res) => {
    const { password, sessionToken } = req.body;
    
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    const { year, week } = req.params;
    const yearNum = parseInt(year);
    const weekNum = parseInt(week);
    
    if (isNaN(yearNum) || isNaN(weekNum)) {
        return res.status(400).json({ error: "Invalid year or week number" });
    }
    
    const result = await deleteWeekHistory(yearNum, weekNum);
    
    if (result.success) {
        res.json({ 
            success: true, 
            message: `Week ${weekNum}, ${yearNum} deleted from history`,
            deleted: result.deleted
        });
    } else {
        res.status(404).json({ error: result.error });
    }
});

app.post('/api/verify-code', verifyCodeLimiter, (req, res) => {
    refreshDynamicSignupCode();
    checkAutoLock();
    
    const { code } = req.body;
    
    if (!requirePlayerCode) {
        return res.json({ valid: true, message: "Signup is open to all" });
    }
    
    if (code === playerSignupCode) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false, error: "Invalid code" });
    }
});

app.post('/api/register-init', registrationLimiter, async (req, res) => {
    refreshDynamicSignupCode();
    checkAutoLock();

    const {
        firstName,
        lastName,
        phone,
        paymentMethod,
        rating,
        signupCode,
        skatingRating,
        puckSkillsRating,
        hockeySenseRating,
        conditioningRating,
        effortRating,
        levelPlayed,
        peerComparison,
        confidenceLevel,
        ratingMode,
        directRating
    } = req.body;

    if (rosterReleased) {
        return res.status(403).json({ error: 'Signup is closed after roster release.' });
    }

    if (!firstName || !lastName || !phone || !paymentMethod) {
        return res.status(400).json({ error: "All fields are required." });
    }

    const cleanFirstName = capitalizeFullName(firstName);
    const cleanLastName = capitalizeFullName(lastName);
    const cleanPhone = formatPhoneNumber(phone);

    if (isDuplicatePlayer(cleanFirstName, cleanLastName, cleanPhone)) {
        return res.status(400).json({ error: "A player with this name or phone number is already registered." });
    }

    if (!validatePhoneNumber(cleanPhone)) {
        return res.status(400).json({ error: "Please enter a valid 10-digit phone number." });
    }

    const skillProfile = normalizeSkillProfile({
        skatingRating,
        puckSkillsRating,
        hockeySenseRating,
        conditioningRating,
        effortRating,
        levelPlayed,
        peerComparison,
        confidenceLevel,
        ratingMode,
        directRating,
        rating
    });

    if (skillProfile.missing.length > 0) {
        return res.status(400).json({ error: `Please complete: ${skillProfile.missing.join(', ')}.` });
    }

    const submittedRating = Number(rating);
    if (Number.isFinite(submittedRating) && Math.abs(submittedRating - skillProfile.derivedRating) > 0.2) {
        return res.status(400).json({ error: "Skill profile changed. Please review your calculated rating and try again." });
    }

    if (playerSpots <= 0) {
        const waitlistPlayer = hydratePlayerRatingProfile({
            id: Date.now(),
            firstName: cleanFirstName,
            lastName: cleanLastName,
            phone: cleanPhone,
            paymentMethod,
            rating: skillProfile.finalRating,
            finalRating: skillProfile.finalRating,
            derivedRating: skillProfile.derivedRating,
            selfRatingRaw: skillProfile.selfRatingRaw,
            skatingRating: skillProfile.skatingRating,
            puckSkillsRating: skillProfile.puckSkillsRating,
            hockeySenseRating: skillProfile.hockeySenseRating,
            conditioningRating: skillProfile.conditioningRating,
            effortRating: skillProfile.effortRating,
            levelPlayed: skillProfile.levelPlayed,
            peerComparison: skillProfile.peerComparison,
            confidenceLevel: skillProfile.confidenceLevel,
            isGoalie: false,
            bypassAutoPromote: false,
            joinedAt: new Date()
        });

        waitlist.push(waitlistPlayer);
        await saveData();

        if (pool) {
            try {
                await pool.query(
                    `INSERT INTO waitlist (
                        id, first_name, last_name, phone, payment_method, rating,
                        skating_rating, puck_skills_rating, hockey_sense_rating, conditioning_rating, effort_rating,
                        level_played, peer_comparison, confidence_level, self_rating_raw, derived_rating, final_rating, is_goalie, bypass_auto_promote
                    )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
                    [
                        waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName,
                        waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating,
                        waitlistPlayer.skatingRating, waitlistPlayer.puckSkillsRating, waitlistPlayer.hockeySenseRating, waitlistPlayer.conditioningRating, waitlistPlayer.effortRating,
                        waitlistPlayer.levelPlayed, waitlistPlayer.peerComparison, waitlistPlayer.confidenceLevel,
                        waitlistPlayer.selfRatingRaw, waitlistPlayer.derivedRating, waitlistPlayer.finalRating, false, false
                    ]
                );
            } catch (err) {
                console.error('Error adding to waitlist:', err.message);
            }
        }

        return res.json({
            success: true,
            inWaitlist: true,
            waitlistPosition: waitlist.length,
            message: "Game is full. You have been added to the waitlist."
        });
    }

    if (requirePlayerCode) {
        if (signupCode !== playerSignupCode) {
            return res.status(401).json({ error: "Invalid or missing signup code" });
        }
    }

    res.json({
        success: true,
        proceedToRules: true,
        isGoalie: false,
        tempData: {
            firstName: cleanFirstName,
            lastName: cleanLastName,
            phone: cleanPhone,
            paymentMethod,
            rating: skillProfile.finalRating,
            finalRating: skillProfile.finalRating,
            derivedRating: skillProfile.derivedRating,
            selfRatingRaw: skillProfile.selfRatingRaw,
            skatingRating: skillProfile.skatingRating,
            puckSkillsRating: skillProfile.puckSkillsRating,
            hockeySenseRating: skillProfile.hockeySenseRating,
            conditioningRating: skillProfile.conditioningRating,
            effortRating: skillProfile.effortRating,
            levelPlayed: skillProfile.levelPlayed,
            peerComparison: skillProfile.peerComparison,
            confidenceLevel: skillProfile.confidenceLevel,
            ratingMode: skillProfile.ratingMode,
            directRating: skillProfile.directRating,
            isGoalie: false
        }
    });
});

app.post('/api/register-final', async (req, res) => {
    const { tempData, rulesAgreed } = req.body;
    
    if (!rulesAgreed) {
        return res.status(400).json({ error: "You must agree to the rules to register." });
    }
    
    if (!tempData || !tempData.firstName) {
        return res.status(400).json({ error: "Registration data missing." });
    }
    
    if (isDuplicatePlayer(tempData.firstName, tempData.lastName, tempData.phone)) {
        return res.status(400).json({ error: "A player with this name or phone number is already registered." });
    }
    
    const newPlayer = hydratePlayerRatingProfile({
        id: Date.now(),
        firstName: tempData.firstName,
        lastName: tempData.lastName,
        phone: tempData.phone,
        paymentMethod: tempData.paymentMethod,
        paid: false,
        paidAmount: null,
        rating: tempData.rating,
        skatingRating: tempData.skatingRating,
        puckSkillsRating: tempData.puckSkillsRating,
        hockeySenseRating: tempData.hockeySenseRating,
        conditioningRating: tempData.conditioningRating,
        effortRating: tempData.effortRating,
        levelPlayed: tempData.levelPlayed,
        peerComparison: tempData.peerComparison,
        confidenceLevel: tempData.confidenceLevel,
        selfRatingRaw: tempData.selfRatingRaw,
        derivedRating: tempData.derivedRating,
        finalRating: tempData.finalRating,
        isGoalie: false,
        team: null,
        registeredAt: new Date().toISOString(),
        rulesAgreed: true
    });

    try {
        await runProtectedMutation('player-signup', req, async () => {
            players.push(newPlayer);
            playerSpots = Math.max(0, playerSpots - 1);
        }, {
            playerId: newPlayer.id,
            firstName: newPlayer.firstName,
            lastName: newPlayer.lastName
        });
    } catch (err) {
        console.error('Error saving player registration:', err.message);
        return res.status(500).json({ error: "Registration could not be saved safely. Please try again." });
    }

    res.json({ 
        success: true, 
        inWaitlist: false,
        message: `You're registered! E-Transfer payment must be received before stepping on the ice.`,
        paymentDeadline: "Before stepping on the ice",
        rosterReleaseTime: getSignupOpenMessageData().rosterReleaseLine || "Teams released after admin generates roster",
        isGoalie: false
    });
});

// CANCEL REGISTRATION / WAITLIST ENDPOINT
app.post('/api/cancel-registration', cancelRegistrationLimiter, async (req, res) => {
    const { playerId, phone } = req.body;

    if (playerId === undefined || playerId === null || !phone) {
        return res.status(400).json({ error: "Player ID and phone number are required." });
    }

    const idToRemove = String(playerId).trim();
    if (!idToRemove) {
        return res.status(400).json({ error: "Invalid player ID." });
    }

    const submittedPhone = normalizePhoneDigits(phone);
    if (!submittedPhone) {
        return res.status(400).json({ error: "Phone number is required." });
    }

    const isProtectedPlayer = (p) =>
        String(p?.firstName || '').toLowerCase() === 'phan' &&
        String(p?.lastName || '').toLowerCase() === 'ly';

    const findById = (arr) => arr.findIndex(p => String(p.id).trim() === idToRemove);

    const playerIndex = findById(players);
    const waitlistIndex = findById(waitlist);
    const foundPlayer = playerIndex !== -1 ? players[playerIndex] : (waitlistIndex !== -1 ? waitlist[waitlistIndex] : null);
    const foundSource = playerIndex !== -1 ? 'players' : (waitlistIndex !== -1 ? 'waitlist' : '');

    if (!foundPlayer) {
        return res.status(404).json({ error: "Player not found." });
    }

    if (isProtectedPlayer(foundPlayer)) {
        return res.status(403).json({ error: "This player cannot be cancelled online. Please contact admin." });
    }

    const storedPhone = normalizePhoneDigits(foundPlayer.phone);
    if (submittedPhone !== storedPhone) {
        return res.status(401).json({ error: "Phone number does not match registration." });
    }

    if (rosterReleased) {
        const alreadyLoggedLateAttempt = cancelledRegistrations.some(item =>
            String(item?.id) === String(foundPlayer.id) &&
            item?.action === 'late_cancel_no_show_owed'
        );

        if (!alreadyLoggedLateAttempt) {
            try {
                await runProtectedMutation('player-cancel-late-attempt', req, async () => {
                    appendCancellationLog({
                        id: foundPlayer.id,
                        firstName: foundPlayer.firstName,
                        lastName: foundPlayer.lastName,
                        phone: foundPlayer.phone,
                        rating: foundPlayer.rating,
                        isGoalie: foundPlayer.isGoalie,
                        paymentMethod: foundPlayer.paymentMethod,
                        source: foundSource || 'players',
                        action: 'late_cancel_no_show_owed',
                        cancelledBy: 'player',
                        cancelledAt: new Date().toISOString(),
                        notes: NO_SHOW_POLICY_TEXT
                    });
                }, {
                    playerId: foundPlayer.id,
                    source: foundSource || 'players'
                });
            } catch (err) {
                console.error('Error logging late cancel attempt:', err.message);
            }
        }

        return res.status(403).json({
            error: "Cancellation is closed because the roster has been released. No-show owes.",
            noShowOwes: true,
            policy: NO_SHOW_POLICY_TEXT
        });
    }

    if (playerIndex !== -1) {
        const player = players[playerIndex];
        let promotedPlayer = null;

        try {
            await runProtectedMutation('player-cancel', req, async () => {
                appendCancellationLog({
                    id: player.id,
                    firstName: player.firstName,
                    lastName: player.lastName,
                    phone: player.phone,
                    rating: player.rating,
                    isGoalie: player.isGoalie,
                    paymentMethod: player.paymentMethod,
                    source: 'players',
                    action: 'cancelled',
                    cancelledBy: 'player',
                    cancelledAt: new Date().toISOString()
                });

                players.splice(playerIndex, 1);
                playerSpots++;

                const waitlistPlayer = extractWaitlistPlayerToPromote();
                if (waitlistPlayer) {

                    promotedPlayer = hydratePlayerRatingProfile({
                        id: waitlistPlayer.id,
                        firstName: waitlistPlayer.firstName,
                        lastName: waitlistPlayer.lastName,
                        phone: waitlistPlayer.phone,
                        paymentMethod: waitlistPlayer.paymentMethod,
                        paid: false,
                        paidAmount: null,
                        rating: parseInt(waitlistPlayer.rating) || 5,
                        skatingRating: waitlistPlayer.skatingRating,
                        puckSkillsRating: waitlistPlayer.puckSkillsRating,
                        hockeySenseRating: waitlistPlayer.hockeySenseRating,
                        conditioningRating: waitlistPlayer.conditioningRating,
                        effortRating: waitlistPlayer.effortRating,
                        levelPlayed: waitlistPlayer.levelPlayed,
                        peerComparison: waitlistPlayer.peerComparison,
                        confidenceLevel: waitlistPlayer.confidenceLevel,
                        selfRatingRaw: waitlistPlayer.selfRatingRaw,
                        derivedRating: waitlistPlayer.derivedRating,
                        finalRating: waitlistPlayer.finalRating,
                        isGoalie: waitlistPlayer.isGoalie,
                        team: null,
                        registeredAt: new Date().toISOString(),
                        rulesAgreed: true
                    });

                    players.push(promotedPlayer);
                    playerSpots--;
                }
            }, {
                playerId: player.id,
                waitlistPromotion: !!promotedPlayer
            });
        } catch (err) {
            console.error('Error cancelling registration:', err.message);
            return res.status(500).json({ error: "Cancellation could not be saved safely. Please try again." });
        }

        return res.json({
            success: true,
            message: "Registration cancelled successfully.",
            promotedPlayer: promotedPlayer ? {
                firstName: promotedPlayer.firstName,
                lastName: promotedPlayer.lastName
            } : null,
            spotsAvailable: playerSpots
        });
    }

    if (waitlistIndex !== -1) {
        const waitlistPlayer = waitlist[waitlistIndex];

        try {
            await runProtectedMutation('waitlist-cancel', req, async () => {
                appendCancellationLog({
                    id: waitlistPlayer.id,
                    firstName: waitlistPlayer.firstName,
                    lastName: waitlistPlayer.lastName,
                    phone: waitlistPlayer.phone,
                    rating: waitlistPlayer.rating,
                    isGoalie: waitlistPlayer.isGoalie,
                    paymentMethod: waitlistPlayer.paymentMethod,
                    source: 'waitlist',
                    action: 'cancelled',
                    cancelledBy: 'player',
                    cancelledAt: new Date().toISOString()
                });

                waitlist.splice(waitlistIndex, 1);
            }, {
                playerId: waitlistPlayer.id,
                source: 'waitlist'
            });
        } catch (err) {
            console.error('Error cancelling waitlist registration:', err.message);
            return res.status(500).json({ error: "Cancellation could not be saved safely. Please try again." });
        }

        return res.json({
            success: true,
            message: "Waitlist registration cancelled successfully.",
            fromWaitlist: true
        });
    }

    return res.status(404).json({ error: "Player not found." });
});

// --- ADMIN API - FULL ACCESS TO ALL DATA ---

app.post('/api/admin/check-session', (req, res) => {
    const sessionToken = getAdminAuthToken(req);
    const decoded = decodeAdminSession(sessionToken);
    const loggedIn = !!decoded && isValidAdminSession(sessionToken);
    res.json({
        loggedIn,
        expiresAt: loggedIn && decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        remember: !!decoded?.remember
    });
});

app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
    const { password, rememberMe } = req.body || {};

    if (!hasConfiguredAdminPassword()) {
        return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD is not configured on the server' });
    }

    if (!isValidAdminPassword(password)) {
        addAdminAuditEntry('login_failed', req, { reason: 'invalid_password' });
        return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const sessionToken = createAdminSessionToken(rememberMe !== false);
    const decoded = decodeAdminSession(sessionToken);
    addAdminAuditEntry('login_success', req, { rememberMe: rememberMe !== false, expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null });

    res.json({
        success: true,
        sessionToken,
        expiresInDays: rememberMe !== false ? ADMIN_REMEMBER_TOKEN_TTL_DAYS : null,
        expiresInHours: rememberMe === false ? ADMIN_SESSION_TOKEN_TTL_HOURS : null,
        expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        remember: rememberMe !== false
    });
});

app.post('/api/admin/logout', (req, res) => {
    const sessionToken = getAdminAuthToken(req);
    const decoded = decodeAdminSession(sessionToken);
    if (decoded?.jti) {
        adminSessionState.revokedJtis[decoded.jti] = Number(decoded.exp || 0);
        pruneAdminSessionState();
        saveAdminSessionState();
    }
    addAdminAuditEntry('logout', req, {});
    res.json({ success: true });
});

app.post('/api/admin/logout-all', (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    adminSessionState.logoutAllAfter = Math.floor(Date.now() / 1000);
    adminSessionState.revokedJtis = {};
    pruneAdminSessionState();
    saveAdminSessionState();
    addAdminAuditEntry('logout_all_devices', req, {});
    res.json({ success: true, message: 'All other admin sessions have been logged out.' });
});

app.get('/api/admin/session-info', (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const sessionToken = getAdminAuthToken(req);
    const decoded = decodeAdminSession(sessionToken);
    res.json({
        remember: !!decoded?.remember,
        issuedAt: decoded?.iat ? new Date(decoded.iat * 1000).toISOString() : null,
        expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null
    });
});

app.get('/api/admin/audit-log', (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));
    const entries = (adminSessionState.audit || []).slice(-limit).reverse();
    res.json({ entries });
});

// ============================================
// NEW ADMIN ENDPOINTS - ADD THESE HERE
// ============================================

// Get app settings (maintenance mode, title, etc.)
app.post('/api/admin/app-settings', (req, res) => {
    const { sessionToken } = req.body;
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    res.json({
        maintenanceMode,
        customTitle,
        announcementEnabled,
        announcementText,
        announcementImages,
        paymentEmail,
        selectedDayTime: gameTime,
        selectedArena: gameLocation,
        gameDate,
        arenaOptions: ARENA_OPTIONS,
        dayTimeOptions: DAY_TIME_OPTIONS,
        backupGoalies: BACKUP_GOALIES,
        regularSkatersByDay
    });
});

// Update app settings
app.post('/api/admin/update-app-settings', async (req, res) => {
    const { sessionToken, maintenanceMode: newMaintenance, customTitle: newTitle,
            announcementEnabled: newAnnouncementEnabled, announcementText: newAnnouncementText, announcementImages: newAnnouncementImages,
            paymentEmail: newPaymentEmail, selectedDayTime, selectedArena, gameDate: newGameDate,
            regularSkatersByDay: newRegularSkatersByDay } = req.body;

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        await runProtectedMutation('update-app-settings', req, async () => {
            if (newMaintenance !== undefined) maintenanceMode = !!newMaintenance;
            if (newTitle !== undefined) customTitle = String(newTitle || '').trim() || customTitle;
            if (newAnnouncementEnabled !== undefined) announcementEnabled = !!newAnnouncementEnabled;
            if (newAnnouncementText !== undefined) announcementText = String(newAnnouncementText || '').trim();
            if (newPaymentEmail !== undefined) paymentEmail = String(newPaymentEmail || '').trim();
            if (newAnnouncementImages !== undefined) {
                announcementImages = normalizeAnnouncementImages(newAnnouncementImages);
            }
            if (newRegularSkatersByDay !== undefined) {
                regularSkatersByDay = normalizeRegularSkatersByDayMap(newRegularSkatersByDay);
            }
            if (selectedDayTime) {
                gameTime = selectedDayTime;
                if (AUTO_BUILD_WEEKLY_SCHEDULES_FROM_GAMETIME) {
                    gameDate = newGameDate || calculateNextGameDate();
                    buildAutoSchedulesFromGameTime(gameTime, gameDate);
                    const guardTime = getCurrentETTime();
                    const resetGuard = armScheduleGuardForCurrentWeek(resetWeekSchedule.at, guardTime);
                    const rosterGuard = armScheduleGuardForCurrentWeek(rosterReleaseSchedule.at, guardTime);
                    lastExactResetRunAt = resetGuard.occurrenceKey;
                    lastExactResetMinuteKey = resetGuard.minuteKey;
                    lastExactRosterReleaseRunAt = rosterGuard.occurrenceKey;
                    lastExactRosterReleaseMinuteKey = rosterGuard.minuteKey;
                }
            }
            if (selectedArena) gameLocation = selectedArena;
            if (newGameDate) {
                gameDate = newGameDate;
                if (AUTO_BUILD_WEEKLY_SCHEDULES_FROM_GAMETIME) {
                    buildAutoSchedulesFromGameTime(gameTime, gameDate);
                }
            }
        }, { selectedDayTime, selectedArena, gameDate: newGameDate || gameDate });
        console.log('[ADMIN] App settings updated');

        res.json({
            success: true,
            maintenanceMode,
            customTitle,
            announcementEnabled,
            announcementText,
            announcementImages,
            regularSkatersByDay,
            gameTime,
            gameLocation,
            gameDate
        });
    } catch (err) {
        console.error('Error saving app settings:', err);
        const message = err && err.message ? err.message : 'Failed to save settings';
        res.status(500).json({ error: message });
    }
});




function getRegularBucketsOrder() {
    return ['everyday','friday','sunday','wednesday','saturday','monday','tuesday','thursday'];
}

function findRegularBucketForPlayer(player) {
    regularSkatersByDay = normalizeRegularSkatersByDayMap(regularSkatersByDay || {});
    const normalizedPhone = normalizePhoneDigits(player && player.phone);
    const firstName = String(player && player.firstName || '').trim().toLowerCase();
    const lastName = String(player && player.lastName || '').trim().toLowerCase();

    for (const bucket of getRegularBucketsOrder()) {
        const list = Array.isArray(regularSkatersByDay[bucket]) ? regularSkatersByDay[bucket] : [];
        const match = list.find(existing => {
            const existingPhone = normalizePhoneDigits(existing.phone);
            if (normalizedPhone && existingPhone && normalizedPhone === existingPhone) return true;
            return String(existing.firstName || '').trim().toLowerCase() === firstName &&
                   String(existing.lastName || '').trim().toLowerCase() === lastName;
        });
        if (match) return bucket;
    }

    return null;
}

function removeRegularPlayerByPhone(phone) {
    regularSkatersByDay = normalizeRegularSkatersByDayMap(regularSkatersByDay || {});
    const normalizedPhone = normalizePhoneDigits(phone);
    let removed = false;

    for (const bucket of Object.keys(regularSkatersByDay)) {
        const before = Array.isArray(regularSkatersByDay[bucket]) ? regularSkatersByDay[bucket].length : 0;
        regularSkatersByDay[bucket] = (regularSkatersByDay[bucket] || []).filter(existing => {
            if (normalizedPhone && normalizePhoneDigits(existing.phone) === normalizedPhone) return false;
            return true;
        });
        if (regularSkatersByDay[bucket].length !== before) removed = true;
    }

    return removed;
}

app.post('/api/admin/promote-player-to-regular', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const playerId = Number(req.body.playerId);
        const bucketRaw = String(req.body.bucket || '').trim().toLowerCase();
        const allowedBuckets = new Set(['everyday','sunday','monday','tuesday','wednesday','thursday','friday','saturday']);

        if (!Number.isFinite(playerId)) return res.status(400).json({ error: 'Invalid player id' });
        if (!allowedBuckets.has(bucketRaw)) return res.status(400).json({ error: 'Invalid regular-player bucket' });

        const player = players.find(p => Number(p.id) === playerId);
        if (!player) return res.status(404).json({ error: 'Player not found in registered players' });

        regularSkatersByDay = normalizeRegularSkatersByDayMap(regularSkatersByDay || {});
        regularSkatersByDay[bucketRaw] = Array.isArray(regularSkatersByDay[bucketRaw]) ? regularSkatersByDay[bucketRaw] : [];

        const normalizedPhone = normalizePhoneDigits(player.phone);
        const alreadyExists = regularSkatersByDay[bucketRaw].some(existing => (
            String(existing.firstName || '').trim().toLowerCase() === String(player.firstName || '').trim().toLowerCase() &&
            String(existing.lastName || '').trim().toLowerCase() === String(player.lastName || '').trim().toLowerCase()
        ) || (normalizedPhone && normalizePhoneDigits(existing.phone) === normalizedPhone));

        if (alreadyExists) {
            return res.json({ success: true, alreadyExists: true, bucket: bucketRaw, regularSkatersByDay, message: `${player.firstName} ${player.lastName} is already a regular in ${bucketRaw}.` });
        }

        const promotedRegular = normalizeRegularSkaterEntry({
            firstName: player.firstName,
            lastName: player.lastName,
            phone: player.phone,
            rating: Number(player.finalRating ?? player.rating ?? 5),
            paymentMethod: player.paymentMethod || 'N/A',
            isFree: !!(player.paidAmount === 0 && String(player.paymentMethod || '').toUpperCase() === 'FREE'),
            protected: !!player.protected
        });

        await runProtectedMutation('promote-player-to-regular', req, async () => {
            regularSkatersByDay = normalizeRegularSkatersByDayMap(regularSkatersByDay || {});
            regularSkatersByDay[bucketRaw] = Array.isArray(regularSkatersByDay[bucketRaw]) ? regularSkatersByDay[bucketRaw] : [];
            regularSkatersByDay[bucketRaw].push(promotedRegular);
        }, { bucket: bucketRaw, playerId });

        return res.json({ success: true, bucket: bucketRaw, regularSkatersByDay, promotedPlayer: { firstName: promotedRegular.firstName, lastName: promotedRegular.lastName } });
    } catch (err) {
        console.error('Error promoting player to regular:', err);
        return res.status(500).json({ error: 'Failed to promote player to regular' });
    }
});



app.post('/api/admin/toggle-player-regular', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
        const playerId = Number(req.body.playerId);
        if (!Number.isFinite(playerId)) return res.status(400).json({ error: 'Invalid player id' });
        const player = players.find(p => Number(p.id) === playerId);
        if (!player) return res.status(404).json({ error: 'Player not found in registered players' });
        const existingBucket = findRegularBucketForPlayer(player);
        if (existingBucket) {
            await runProtectedMutation('toggle-player-regular-remove', req, async () => {
                removeRegularPlayerByPhone(player.phone);
            }, { playerId, removedFrom: existingBucket });
            return res.json({ success: true, active: false, removedFrom: existingBucket, regularSkatersByDay });
        }
        const promotedRegular = normalizeRegularSkaterEntry({
            firstName: player.firstName, lastName: player.lastName, phone: player.phone,
            rating: Number(player.finalRating ?? player.rating ?? 5), paymentMethod: player.paymentMethod || 'N/A',
            isFree: !!(player.paidAmount === 0 && String(player.paymentMethod || '').toUpperCase() === 'FREE'), protected: !!player.protected
        });
        await runProtectedMutation('toggle-player-regular-add', req, async () => {
            regularSkatersByDay = normalizeRegularSkatersByDayMap(regularSkatersByDay || {});
            regularSkatersByDay.everyday = Array.isArray(regularSkatersByDay.everyday) ? regularSkatersByDay.everyday : [];
            regularSkatersByDay.everyday.push(promotedRegular);
        }, { playerId, bucket: 'everyday' });
        return res.json({ success: true, active: true, bucket: 'everyday', regularSkatersByDay });
    } catch (err) {
        console.error('Error toggling player regular status:', err);
        return res.status(500).json({ error: 'Failed to update regular player' });
    }
});

app.post('/api/admin/remove-regular-player', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
        const phone = String(req.body.phone || '').trim();
        if (!phone) return res.status(400).json({ error: 'Phone is required' });
        let removed = false;
        await runProtectedMutation('remove-regular-player', req, async () => {
            removed = removeRegularPlayerByPhone(phone);
        }, { phone });
        return res.json({ success: true, removed, regularSkatersByDay });
    } catch (err) {
        console.error('Error removing regular player:', err);
        return res.status(500).json({ error: 'Failed to remove regular player' });
    }
});



app.post('/api/admin/regular-skaters', (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    res.json({ success: true, regularSkatersByDay });
});

app.post('/api/admin/update-regular-skaters', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
        await runProtectedMutation('update-regular-skaters', req, async () => {
            regularSkatersByDay = normalizeRegularSkatersByDayMap(req.body.regularSkatersByDay || {});
        });
        res.json({ success: true, regularSkatersByDay });
    } catch (err) {
        console.error('Error saving regular skaters:', err);
        res.status(500).json({ error: 'Failed to save regular skaters' });
    }
});

// Add backup goalie to roster
app.post('/api/admin/add-backup-goalie', async (req, res) => {
    const { sessionToken, goalieIndex } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    if (goalieIndex < 0 || goalieIndex >= BACKUP_GOALIES.length) return res.status(400).json({ error: "Invalid goalie selection" });
    const backupGoalie = BACKUP_GOALIES[goalieIndex];
    const normalizedPhone = backupGoalie.phone.replace(/\D/g, '');
    const exists = players.find(p => p.phone.replace(/\D/g, '') === normalizedPhone);
    if (exists) return res.status(400).json({ error: "This goalie is already registered" });
    const newGoalie = { id: Date.now(), firstName: backupGoalie.firstName, lastName: backupGoalie.lastName, phone: backupGoalie.phone, paymentMethod: "N/A", paid: true, paidAmount: 0, rating: backupGoalie.rating, isGoalie: true, team: null, registeredAt: new Date().toISOString(), rulesAgreed: true };
    try {
        await runProtectedMutation('add-backup-goalie', req, async () => { players.push(newGoalie); }, { goalieIndex, playerId: newGoalie.id });
        res.json({ success: true, goalie: newGoalie, message: `${backupGoalie.firstName} ${backupGoalie.lastName} added as substitute goalie` });
    } catch (err) {
        console.error('Error adding backup goalie:', err);
        res.status(500).json({ error: "Failed to add backup goalie safely" });
    }
});

// END NEW ADMIN ENDPOINTS

// ADMIN ONLY: Get full player data with payment AND rating info
app.post('/api/admin/players-full', (req, res) => {
    const { sessionToken } = req.body;
    
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    
    // Calculate totals
    const totalPaid = players.reduce((sum, p) => {
        if (p.paidAmount && !isNaN(parseFloat(p.paidAmount))) {
            return sum + parseFloat(p.paidAmount);
        }
        return sum;
    }, 0);
    
    const paidCount = players.filter(p => p.paid && !p.isGoalie && !(p.firstName === 'Phan' && p.lastName === 'Ly')).length;
    const unpaidCount = players.filter(p => !p.paid && !p.isGoalie && !(p.firstName === 'Phan' && p.lastName === 'Ly')).length;
    
    // Return FULL data including payment info AND ratings (admin only)
    res.json({ 
        playerSpots, 
        playerCount,
        goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        totalPaid: totalPaid.toFixed(2),
        paidCount: paidCount,
        unpaidCount: unpaidCount,
        players: players,  // Full data with payment AND rating
        waitlist: waitlist, // Full waitlist data
        cancellations: cancelledRegistrations,
        customSignupCode,
        usingCustomSignupCode: /^\d{4}$/.test(String(customSignupCode || '').trim()),
        location: gameLocation, 
        time: gameTime,
        date: gameDate,
        rosterReleased, 
        currentWeekData, 
        playerSignupCode, 
        requirePlayerCode,
        regularSkatersByDay 
    });
});



// ADMIN ONLY: Download live signup backup JSON
app.post('/api/admin/clear-cancellations', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
        await runProtectedMutation('clear-cancellations', req, async () => { cancelledRegistrations = []; });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to clear cancellations safely' });
    }
    res.json({ success: true, cancellations: cancelledRegistrations });
});

app.post('/api/admin/download-backup', async (req, res) => {
    const { sessionToken } = req.body || {};

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const etNow = getCurrentETTime();
        const yyyy = etNow.getFullYear();
        const mm = String(etNow.getMonth() + 1).padStart(2, '0');
        const dd = String(etNow.getDate()).padStart(2, '0');
        const hh = String(etNow.getHours()).padStart(2, '0');
        const mi = String(etNow.getMinutes()).padStart(2, '0');
        const ss = String(etNow.getSeconds()).padStart(2, '0');

        const backup = {
            exportedAt: new Date().toISOString(),
            exportedAtET: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} ET`,
            players,
            waitlist,
            currentWeekData,
            summary: {
                playerSpots,
                gameLocation,
                gameTime,
                gameDate,
                rosterReleased,
                requirePlayerCode,
                playerSignupCode,
                totalPlayers: players.length,
                totalWaitlist: waitlist.length
            },
            appSettings: {
                maintenanceMode,
                customTitle,
                announcementEnabled,
                announcementText,
                announcementImages,
                playerSpots,
                requirePlayerCode,
                playerSignupCode
            }
        };

        const filename = getGameDayBackupDownloadName('json');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(JSON.stringify(backup, null, 2));
    } catch (err) {
        console.error('Error downloading backup:', err);
        return res.status(500).json({ error: 'Failed to build backup file' });
    }
});




app.post('/api/admin/snapshots/create', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const note = String(req.body?.note || '').trim();
        const result = await createManualSnapshot('manual-create-snapshot', req, {
            note,
            triggeredBy: 'admin-panel'
        });
        return res.json({
            success: true,
            message: 'Manual snapshot created successfully.',
            ...result
        });
    } catch (err) {
        console.error('Error creating manual snapshot:', err);
        return res.status(500).json({ error: 'Failed to create manual snapshot' });
    }
});

app.get('/api/admin/snapshots', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const limit = Math.max(10, Math.min(Number(req.query.limit) || 100, 300));
        const snapshots = await listAvailableSnapshots(limit);
        return res.json({
            success: true,
            snapshots: snapshots.map(item => ({
                snapshotKey: item.snapshotKey,
                snapshotId: item.snapshotId,
                fingerprint: item.fingerprint,
                snapshotFile: item.file,
                snapshotSource: item.source || 'local',
                snapshotSavedAt: item.savedAt || null,
                snapshotReason: item.reason || null,
                snapshotPlayers: item.players || 0,
                snapshotWaitlist: item.waitlist || 0,
                rosterReleasedInSnapshot: item.rosterReleased,
                gameLocation: item.gameLocation || null,
                gameTime: item.gameTime || null,
                gameDate: item.gameDate || null,
                version: item.version || 2
            })),
            livePlayers: Array.isArray(players) ? players.length : 0,
            liveWaitlist: Array.isArray(waitlist) ? waitlist.length : 0
        });
    } catch (err) {
        console.error('Error listing snapshots:', err);
        return res.status(500).json({ error: 'Failed to list snapshots' });
    }
});

app.get('/api/admin/snapshots/preview', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const snapshotKey = String(req.query.snapshotKey || '').trim();
        if (!snapshotKey) return res.status(400).json({ error: 'snapshotKey is required' });
        const match = await getSnapshotByLookup(snapshotKey, String(req.query.fingerprint || '').trim());
        if (!match) return res.status(404).json({ error: 'Snapshot not found' });
        if (match.stale) {
            return res.status(409).json({ error: 'Snapshot changed. Refresh the list and try again.', latest: buildSnapshotPreviewPayload(match.latest) });
        }
        return res.json(buildSnapshotPreviewPayload(match));
    } catch (err) {
        console.error('Error previewing snapshot:', err);
        return res.status(500).json({ error: 'Failed to preview snapshot' });
    }
});

app.post('/api/admin/snapshots/restore', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const snapshotKey = String(req.body?.snapshotKey || '').trim();
        const fingerprint = String(req.body?.fingerprint || '').trim();
        if (!snapshotKey) return res.status(400).json({ error: 'snapshotKey is required' });
        const match = await getSnapshotByLookup(snapshotKey, fingerprint);
        if (!match) return res.status(404).json({ error: 'Snapshot not found' });
        if (match.stale) {
            return res.status(409).json({ error: 'Snapshot changed since preview. Refresh the list and try again.', latest: buildSnapshotPreviewPayload(match.latest) });
        }
        const result = await restoreSnapshotItem(match, req, 'restore-selected-snapshot');
        return res.status(result.status || 200).json(result.body);
    } catch (err) {
        console.error('Error restoring selected snapshot:', err);
        return res.status(500).json({ error: 'Failed to restore selected snapshot' });
    }
});

app.get('/api/admin/restore-latest-backup-preview', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const latest = await getBestAvailableSnapshot();
        if (!latest || !latest.data) {
            return res.status(404).json({ error: "No server snapshot found to preview." });
        }

        return res.json(buildSnapshotPreviewPayload(buildSnapshotListItem(latest)));
    } catch (err) {
        console.error('Error previewing latest server snapshot:', err);
        return res.status(500).json({ error: 'Failed to preview latest server snapshot' });
    }
});


app.post('/api/admin/restore-latest-backup', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const latest = await getBestAvailableSnapshot();
        if (!latest || !latest.data) {
            return res.status(404).json({ error: "No server snapshot found to restore." });
        }
        const latestItem = buildSnapshotListItem(latest);
        const providedFingerprint = String(req.body?.fingerprint || '').trim();
        if (providedFingerprint && providedFingerprint !== latestItem.fingerprint) {
            return res.status(409).json({ error: 'Latest snapshot changed since preview. Preview again before restoring.', latest: buildSnapshotPreviewPayload(latestItem) });
        }
        const result = await restoreSnapshotItem(latestItem, req, 'restore-latest-backup-replace');
        return res.status(result.status || 200).json(result.body);
    } catch (err) {
        console.error('Error restoring latest server snapshot:', err);
        return res.status(500).json({ error: 'Failed to restore latest server snapshot' });
    }
});

// ADMIN ONLY: Safer restore players and waitlist from a previously downloaded backup JSON
app.post('/api/admin/restore-backup', async (req, res) => {
    const {
        sessionToken,
        backupData,
        restoreMode = 'merge',
        forceReplace = false,
        restoreSettings = false
    } = req.body || {};

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    function clonePlain(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeRestoreList(list) {
        return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : null;
    }

    function buildRestoreKey(item) {
        const idPart = item && item.id != null ? `id:${String(item.id)}` : '';
        const phoneDigits = normalizePhoneDigits(item && item.phone);
        if (phoneDigits) return `phone:${phoneDigits}`;
        const first = String(item && item.firstName || '').trim().toLowerCase();
        const last = String(item && item.lastName || '').trim().toLowerCase();
        if (first || last) return `name:${first}|${last}`;
        return idPart || '';
    }

    function mergeUnique(currentList, backupList) {
        const merged = Array.isArray(currentList) ? currentList.map(clonePlain) : [];
        const seen = new Set(merged.map(buildRestoreKey).filter(Boolean));

        for (const rawItem of Array.isArray(backupList) ? backupList : []) {
            const item = clonePlain(rawItem);
            const key = buildRestoreKey(item);
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            merged.push(item);
        }

        return merged;
    }

    try {
        if (!backupData || typeof backupData !== 'object') {
            return res.status(400).json({ error: "Invalid backup file" });
        }

        const restoredPlayers = normalizeRestoreList(backupData.players);
        const restoredWaitlist = normalizeRestoreList(backupData.waitlist);

        if (!restoredPlayers || !restoredWaitlist) {
            return res.status(400).json({ error: "Backup file is missing players or waitlist" });
        }

        const requestedMode = String(restoreMode || 'merge').trim().toLowerCase();
        const mode = requestedMode === 'replace' ? 'replace' : 'merge';

        const beforeCounts = {
            players: Array.isArray(players) ? players.length : 0,
            waitlist: Array.isArray(waitlist) ? waitlist.length : 0
        };

        if (
            mode === 'replace' &&
            !forceReplace &&
            (
                restoredPlayers.length < beforeCounts.players ||
                restoredWaitlist.length < beforeCounts.waitlist
            )
        ) {
            return res.status(409).json({
                error: "Backup has fewer records than live data. Replace blocked for safety.",
                requiresForce: true,
                currentPlayers: beforeCounts.players,
                currentWaitlist: beforeCounts.waitlist,
                backupPlayers: restoredPlayers.length,
                backupWaitlist: restoredWaitlist.length
            });
        }

        const originalPlayers = Array.isArray(players) ? players.map(clonePlain) : [];
        const originalWaitlist = Array.isArray(waitlist) ? waitlist.map(clonePlain) : [];

        if (mode === 'replace') {
            players = restoredPlayers.map(clonePlain);
            waitlist = restoredWaitlist.map(clonePlain);
        } else {
            players = mergeUnique(originalPlayers, restoredPlayers);
            waitlist = mergeUnique(originalWaitlist, restoredWaitlist);
        }

        // Restore supported settings only when explicitly requested on a full replace
        if (mode === 'replace' && restoreSettings === true) {
            if (backupData.currentWeekData && typeof backupData.currentWeekData === 'object') {
                currentWeekData = backupData.currentWeekData;
            }

            if (backupData.summary && typeof backupData.summary === 'object') {
                if (typeof backupData.summary.gameLocation === 'string') gameLocation = backupData.summary.gameLocation;
                if (typeof backupData.summary.gameTime === 'string') gameTime = backupData.summary.gameTime;
                if (typeof backupData.summary.gameDate === 'string') gameDate = backupData.summary.gameDate;
                if (typeof backupData.summary.rosterReleased === 'boolean') rosterReleased = backupData.summary.rosterReleased;
            }

            if (backupData.appSettings && typeof backupData.appSettings === 'object') {
                const s = backupData.appSettings;
                if (typeof s.maintenanceMode === 'boolean') maintenanceMode = s.maintenanceMode;
                if (typeof s.customTitle === 'string') customTitle = s.customTitle;
                if (typeof s.announcementEnabled === 'boolean') announcementEnabled = s.announcementEnabled;
                if (typeof s.announcementText === 'string') announcementText = s.announcementText;
                if (Array.isArray(s.announcementImages)) announcementImages = s.announcementImages;
                if (typeof s.paymentEmail === 'string') paymentEmail = s.paymentEmail.trim() || paymentEmail;
                if (typeof s.requirePlayerCode === 'boolean') requirePlayerCode = s.requirePlayerCode;
                if (typeof s.playerSignupCode === 'string') playerSignupCode = s.playerSignupCode;
            }
        }

        // Always recalculate spots from the resulting live roster instead of trusting backup counts.
        playerSpots = Math.max(0, 20 - players.filter(p => !(p && p.isGoalie)).length);

        // Persist using existing save helper if available
        try {
            if (typeof saveData === 'function') {
                await saveData();
            }
        } catch (saveErr) {
            console.error('Restore completed in memory but saveData failed:', saveErr);
        }

        try {
            if (typeof addAdminAuditEntry === 'function') {
                addAdminAuditEntry(`restore-backup-${mode}`, req, {
                    beforePlayers: beforeCounts.players,
                    beforeWaitlist: beforeCounts.waitlist,
                    backupPlayers: restoredPlayers.length,
                    backupWaitlist: restoredWaitlist.length,
                    afterPlayers: players.length,
                    afterWaitlist: waitlist.length,
                    restoreSettings: mode === 'replace' && restoreSettings === true
                });
            }
        } catch (auditErr) {
            console.error('Error auditing restore action:', auditErr.message);
        }

        return res.json({
            success: true,
            mode,
            restoredPlayers: players.length,
            restoredWaitlist: waitlist.length,
            currentPlayersBefore: beforeCounts.players,
            currentWaitlistBefore: beforeCounts.waitlist,
            backupPlayers: restoredPlayers.length,
            backupWaitlist: restoredWaitlist.length,
            restoreSettingsApplied: mode === 'replace' && restoreSettings === true,
            message: mode === 'merge'
                ? "Backup merged safely with live data"
                : "Backup replaced live data successfully"
        });
    } catch (err) {
        console.error('Error restoring backup:', err);
        return res.status(500).json({ error: "Failed to restore backup" });
    }
});

// Backward-compatible admin players endpoint
app.post('/api/admin/players', (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    const totalPaid = players.reduce((sum, p) => {
        if (p.paidAmount && !isNaN(parseFloat(p.paidAmount))) {
            return sum + parseFloat(p.paidAmount);
        }
        return sum;
    }, 0);
    const paidCount = players.filter(p => p.paid && !p.isGoalie && !(p.firstName === 'Phan' && p.lastName === 'Ly')).length;
    const unpaidCount = players.filter(p => !p.paid && !p.isGoalie && !(p.firstName === 'Phan' && p.lastName === 'Ly')).length;

    return res.json({
        playerSpots,
        playerCount,
        goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        totalPaid: totalPaid.toFixed(2),
        paidCount,
        unpaidCount,
        players,
        waitlist,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        rosterReleased,
        currentWeekData,
        playerSignupCode,
        requirePlayerCode
    });
});

app.post('/api/admin/settings', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).send("Unauthorized");
    }
    
    const lockStatus = checkAutoLock();
    
    res.json({
        code: playerSignupCode,
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        rosterReleased,
        resetArmed,
        signupLockSchedule,
        rosterReleaseSchedule,
        resetWeekSchedule,
        signupLockStartAt,
        signupLockEndAt,
        rosterReleaseAt,
        resetWeekAt,
        customSignupCode,
        usingCustomSignupCode: /^\d{4}$/.test(String(customSignupCode || '').trim()),
        regularSkatersByDay,
        defaultSignupCode: (() => {
            const day = String(getGameDayName() || '').trim().toLowerCase();
            if (day === 'friday') return FRIDAY_SIGNUP_CODE;
            if (day === 'sunday') return SUNDAY_SIGNUP_CODE;
            return DEFAULT_SIGNUP_CODE;
        })()
    });
});

app.post('/api/admin/update-details', async (req, res) => {
    const { password, sessionToken, location, time, date } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    try {
        await runProtectedMutation('update-details', req, async () => {
            if (location && location.trim().length > 0) gameLocation = location.trim();
            if (time && time.trim().length > 0) gameTime = time.trim();
            if (date && date.trim().length > 0) gameDate = date.trim();
        }, { location, time, date });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save game details safely' });
    }
    res.json({ success: true, location: gameLocation, time: gameTime, date: gameDate, formattedDate: formatGameDate(gameDate) });
});

app.post('/api/admin/update-code', async (req, res) => {
    const { password, sessionToken, newCode } = req.body;

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized - invalid session" });
    }

    if (!newCode || !/^\d{4}$/.test(newCode)) {
        return res.status(400).json({ error: "Code must be exactly 4 digits" });
    }

    try {
        await runProtectedMutation('update-code', req, async () => {
            customSignupCode = String(newCode).trim();
            playerSignupCode = getDynamicSignupCode();
        }, { newCode: String(newCode).trim() });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save signup code safely' });
    }

    res.json({ 
        success: true, 
        code: playerSignupCode,
        customSignupCode,
        usingCustomSignupCode: true,
        requireCode: requirePlayerCode 
    });
});

app.post('/api/admin/clear-code-override', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized - invalid session" });
    }

    try {
        await runProtectedMutation('clear-code-override', req, async () => {
            customSignupCode = '';
            playerSignupCode = getDynamicSignupCode();
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to clear signup code override safely' });
    }

    res.json({
        success: true,
        code: playerSignupCode,
        customSignupCode,
        usingCustomSignupCode: false,
        requireCode: requirePlayerCode
    });
});

app.post('/api/admin/update-schedules', async (req, res) => {
        const body = req.body || {};
    const { password, sessionToken, signupLockEnabled, signupLockStart, signupLockEnd, rosterReleaseEnabled, rosterReleaseAt: rosterReleaseAtInput, resetWeekEnabled, resetWeekAt: resetWeekAtInput } = body;
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).send("Unauthorized");
    }

    const validationError = validateScheduleInputs({
        signupLockEnabled: !!signupLockEnabled,
        signupLockStart,
        signupLockEnd,
        rosterReleaseEnabled: !!rosterReleaseEnabled,
        rosterReleaseAt: rosterReleaseAtInput,
        resetWeekEnabled: !!resetWeekEnabled,
        resetWeekAt: resetWeekAtInput
    });
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    try {
        await runProtectedMutation('update-schedules', req, async () => {
            signupLockStartAt = signupLockStart || '';
            signupLockEndAt = signupLockEnd || '';
            rosterReleaseAt = rosterReleaseAtInput || '';
            resetWeekAt = resetWeekAtInput || '';

            signupLockSchedule.enabled = !!signupLockEnabled;
            rosterReleaseSchedule.enabled = !!rosterReleaseEnabled;
            resetWeekSchedule.enabled = !!resetWeekEnabled;

            signupLockSchedule.start = signupLockStartAt ? parseDatetimeLocalToDowTime(signupLockStartAt) : null;
            signupLockSchedule.end = signupLockEndAt ? parseDatetimeLocalToDowTime(signupLockEndAt) : null;
            rosterReleaseSchedule.at = rosterReleaseAt ? parseDatetimeLocalToDowTime(rosterReleaseAt) : null;
            resetWeekSchedule.at = resetWeekAt ? parseDatetimeLocalToDowTime(resetWeekAt) : null;

            const guardTime = getCurrentETTime();
            const rosterGuard = armScheduleGuardForCurrentWeek(rosterReleaseSchedule.at, guardTime);
            const resetGuard = armScheduleGuardForCurrentWeek(resetWeekSchedule.at, guardTime);
            lastExactRosterReleaseRunAt = rosterGuard.occurrenceKey;
            lastExactRosterReleaseMinuteKey = rosterGuard.minuteKey;
            lastExactResetRunAt = resetGuard.occurrenceKey;
            lastExactResetMinuteKey = resetGuard.minuteKey;
        }, { signupLockEnabled, rosterReleaseEnabled, resetWeekEnabled });
        console.log('[ADMIN] Schedules updated');
    } catch (err) {
        return res.status(500).json({ error: 'Failed to save schedules safely' });
    }
    const lockStatus = checkAutoLock();

    res.json({
        success: true,
        signupLockSchedule,
        rosterReleaseSchedule,
        resetWeekSchedule,
        signupLockStartAt,
        signupLockEndAt,
        rosterReleaseAt,
        resetWeekAt,
        resetArmed,
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow
    });
});

app.post('/api/admin/toggle-code', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).send("Unauthorized");
    }
    
    try {
        await runProtectedMutation('toggle-code', req, async () => {
            const newRequireCode = !requirePlayerCode;
            requirePlayerCode = newRequireCode;
            manualOverride = true;
            manualOverrideState = newRequireCode ? 'locked' : 'open';
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to toggle code safely' });
    }
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        code: playerSignupCode 
    });
});

app.post('/api/admin/reset-schedule', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).send("Unauthorized");
    }
    
    try {
        await runProtectedMutation('reset-schedule', req, async () => {
            manualOverride = false;
            manualOverrideState = null;
            checkAutoLock();
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to restore auto schedule safely' });
    }
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        message: "Auto-schedule restored"
    });
});

app.post('/api/admin/toggle-waitlist-bypass', async (req, res) => {
    const { waitlistId, bypassAutoPromote } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");

    const index = waitlist.findIndex(p => String(p.id) === String(waitlistId));
    if (index === -1) return res.status(404).json({ error: "Player not found in waitlist" });

    const nextValue = !!bypassAutoPromote;

    try {
        await runProtectedMutation('toggle-waitlist-bypass', req, async () => {
            waitlist[index] = hydratePlayerRatingProfile({
                ...waitlist[index],
                bypassAutoPromote: nextValue
            });
        }, { waitlistId, bypassAutoPromote: nextValue });
    } catch (err) {
        console.error('Error toggling waitlist bypass:', err);
        return res.status(500).json({ error: "Failed to update waitlist bypass safely" });
    }

    return res.json({ success: true, waitlistId, bypassAutoPromote: nextValue });
});

app.post('/api/admin/promote-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    const index = waitlist.findIndex(p => String(p.id) === String(waitlistId));
    if (index === -1) return res.status(404).json({ error: "Player not found in waitlist" });
    const player = waitlist[index];
    const newPlayer = hydratePlayerRatingProfile({
        id: player.id, firstName: player.firstName, lastName: player.lastName, phone: player.phone,
        paymentMethod: player.paymentMethod, paid: false, paidAmount: null,
        rating: parseInt(player.rating) || 5, skatingRating: player.skatingRating, puckSkillsRating: player.puckSkillsRating,
        hockeySenseRating: player.hockeySenseRating, conditioningRating: player.conditioningRating, effortRating: player.effortRating,
        levelPlayed: player.levelPlayed, peerComparison: player.peerComparison, confidenceLevel: player.confidenceLevel,
        selfRatingRaw: player.selfRatingRaw, derivedRating: player.derivedRating, finalRating: player.finalRating,
        isGoalie: player.isGoalie, bypassAutoPromote: false, team: null, rulesAgreed: true
    });
    try {
        await runProtectedMutation('promote-waitlist', req, async () => {
            waitlist.splice(index, 1);
            players.push(newPlayer);
            if (!player.isGoalie && playerSpots > 0) playerSpots--;
        }, { waitlistId, promotedPlayerId: newPlayer.id });
    } catch (err) {
        console.error('Error promoting player:', err);
        return res.status(500).json({ error: "Failed to promote waitlist player safely" });
    }
    res.json({ success: true, player: newPlayer, spots: playerSpots, override: playerSpots <= 0 && !player.isGoalie });
});

app.post('/api/admin/remove-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    const index = waitlist.findIndex(p => String(p.id) === String(waitlistId));
    if (index === -1) return res.status(404).json({ error: "Player not found in waitlist" });
    const player = waitlist[index];
    try {
        await runProtectedMutation('remove-waitlist', req, async () => {
            appendCancellationLog({ id: player.id, firstName: player.firstName, lastName: player.lastName, phone: player.phone, rating: player.rating, isGoalie: player.isGoalie, paymentMethod: player.paymentMethod, source: 'waitlist', action: 'removed', cancelledBy: 'admin', cancelledAt: new Date().toISOString() });
            waitlist.splice(index, 1);
        }, { waitlistId });
    } catch (err) {
        console.error('Error removing from waitlist:', err);
        return res.status(500).json({ error: "Failed to remove waitlist player safely" });
    }
    res.json({ success: true });
});

app.post('/api/admin/add-player', async (req, res) => {
    const { password, sessionToken, firstName, lastName, phone, paymentMethod, rating, isGoalie, toWaitlist } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    if (!firstName || !lastName || !phone || !rating) return res.status(400).json({ error: "First name, last name, phone, and rating required" });
    const cleanFirstName = capitalizeFullName(firstName);
    const cleanLastName = capitalizeFullName(lastName);
    if (!validatePhoneNumber(phone)) return res.status(400).json({ error: "Invalid phone number format" });
    const formattedPhone = formatPhoneNumber(phone);
    const ratingNum = roundRating(parseFloat(rating) || 5);
    const isGoalieBool = isGoalie || false;
    if (toWaitlist) {
        const waitlistPlayer = hydratePlayerRatingProfile({ id: Date.now(), firstName: cleanFirstName, lastName: cleanLastName, phone: formattedPhone, paymentMethod: paymentMethod || 'Cash', rating: ratingNum, derivedRating: ratingNum, finalRating: ratingNum, selfRatingRaw: ratingNum, isGoalie: isGoalieBool, bypassAutoPromote: false, joinedAt: new Date() });
        try { await runProtectedMutation('admin-add-waitlist-player', req, async () => { waitlist.push(waitlistPlayer); }, { playerId: waitlistPlayer.id }); }
        catch (err) { console.error('Error adding to waitlist:', err); return res.status(500).json({ error: "Failed to add waitlist player safely" }); }
        return res.json({ success: true, player: waitlistPlayer, inWaitlist: true });
    }
    if (isGoalieBool && !isGoalieSpotsAvailable()) return res.status(400).json({ error: "Goalie spots are full (maximum 2)." });
    const newPlayer = hydratePlayerRatingProfile({ id: Date.now(), firstName: cleanFirstName, lastName: cleanLastName, phone: formattedPhone, paymentMethod: paymentMethod || 'Cash', paid: isGoalieBool ? true : false, paidAmount: isGoalieBool ? 0 : null, rating: ratingNum, derivedRating: ratingNum, finalRating: ratingNum, selfRatingRaw: ratingNum, isGoalie: isGoalieBool, team: null });
    try { await runProtectedMutation('admin-add-player', req, async () => { players.push(newPlayer); if (!isGoalieBool && playerSpots > 0) playerSpots--; }, { playerId: newPlayer.id }); }
    catch (err) { console.error('Error adding player:', err); return res.status(500).json({ error: "Failed to add player safely" }); }
    res.json({ success: true, player: newPlayer, inWaitlist: false });
});

// ADMIN REMOVE PLAYER - WORKS ON ANY PLAYER AT ANY TIME (NO RESTRICTIONS)
app.post('/api/admin/remove-player', async (req, res) => {
    const { password, sessionToken, playerId } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    const idToRemove = parseInt(playerId);
    if (isNaN(idToRemove)) return res.status(400).json({ error: "Invalid player ID" });
    const index = players.findIndex(p => String(p.id) === String(idToRemove));
    if (index === -1) return res.status(404).json({ error: "Player not found" });
    const player = players[index];
    try {
        await runProtectedMutation('remove-player', req, async () => {
            const removedPlayer = players.splice(index, 1)[0];
            appendCancellationLog({ id: removedPlayer.id, firstName: removedPlayer.firstName, lastName: removedPlayer.lastName, phone: removedPlayer.phone, rating: removedPlayer.rating, isGoalie: removedPlayer.isGoalie, paymentMethod: removedPlayer.paymentMethod, source: 'players', action: 'removed', cancelledBy: 'admin', cancelledAt: new Date().toISOString() });
            if (!removedPlayer.isGoalie) playerSpots++;
        }, { playerId: idToRemove });
    } catch (err) {
        console.error('Error removing player:', err);
        return res.status(500).json({ error: "Failed to remove player safely" });
    }
    res.json({ success: true, spots: playerSpots, removedPlayer: player });
});

app.post('/api/admin/update-spots', async (req, res) => {
    const { password, sessionToken, newSpots } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    const spotCount = parseInt(newSpots);
    if (isNaN(spotCount) || spotCount < 0 || spotCount > 30) return res.status(400).json({ error: "Invalid spot count (0-30 allowed)" });
    try { await runProtectedMutation('update-spots', req, async () => { playerSpots = spotCount; }, { spotCount }); }
    catch (err) { return res.status(500).json({ error: 'Failed to update spots safely' }); }
    res.json({ success: true, spots: playerSpots });
});

// Update paid amount endpoint
app.post('/api/admin/update-paid-amount', async (req, res) => {
    const { password, sessionToken, playerId, amount } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");

    const normalizedPlayerId = parseInt(playerId, 10);
    const player = players.find(p => parseInt(p.id, 10) === normalizedPlayerId);
    if (!player) return res.status(404).json({ error: "Player not found" });

    let paidAmount = null;
    let paid = false;
    if (amount !== '' && amount !== null && amount !== undefined) {
        const parsed = parseFloat(amount);
        if (!isNaN(parsed) && parsed >= 0) {
            paidAmount = parsed;
            paid = parsed > 0;
        }
    }

    try {
        player.paidAmount = paidAmount;
        player.paid = paid;

        if (pool) {
            await pool.query(
                'UPDATE players SET paid = $1, paid_amount = $2 WHERE id = $3',
                [paid, paidAmount, normalizedPlayerId]
            );
        }

        await saveData();

        const totalPaid = players.reduce((sum, p) => {
            const value = parseFloat(p && p.paidAmount);
            return sum + (Number.isFinite(value) ? value : 0);
        }, 0);

        res.json({ success: true, player, totalPaid: totalPaid.toFixed(2) });
    } catch (err) {
        console.error('Error updating paid amount:', err);
        res.status(500).json({ error: "Failed to update payment safely" });
    }
});

// Admin override for final player rating
app.post('/api/admin/update-rating', async (req, res) => {
    const { password, sessionToken, playerId, newRating } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    const ratingNum = roundRating(parseFloat(newRating));
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 10) return res.status(400).json({ error: "Rating must be a number between 1 and 10" });
    const player = players.find(p => p.id === parseInt(playerId)) || waitlist.find(p => p.id === parseInt(playerId));
    if (!player) return res.status(404).json({ error: "Player not found" });
    const oldRating = roundRating(player.finalRating ?? player.rating ?? 5);
    const derivedRating = roundRating(player.derivedRating ?? oldRating);
    try {
        await runProtectedMutation('update-rating', req, async () => {
            player.adminRating = ratingNum;
            player.adminAdjustment = roundRating(ratingNum - derivedRating);
            player.finalRating = ratingNum;
            player.rating = ratingNum;
        }, { playerId, oldRating, newRating: ratingNum });
        res.json({ success: true, player: hydratePlayerRatingProfile(player), oldRating, newRating: ratingNum });
    } catch (err) {
        console.error('Error updating rating:', err);
        res.status(500).json({ error: "Failed to update rating safely" });
    }
});

app.post('/api/admin/release-roster', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });
    if (players.length === 0) return res.status(400).json({ error: "No players registered yet" });
    try {
        const etTime = getCurrentETTime();
        const { week, year } = getWeekNumber(etTime);
        const teams = generateFairTeams();
        await runProtectedMutation('release-roster', req, async () => {
            rosterReleased = true;
            resetArmed = true;
            announcementEnabled = true;
            announcementText = buildRosterReleasePaymentAnnouncement();
            currentWeekData = { weekNumber: week, year, releaseDate: new Date().toISOString(), rosterReleaseTime: Date.now(), whiteTeam: teams.whiteTeam, darkTeam: teams.darkTeam };
        }, { week, year });
        await saveWeekHistory(year, week, teams.whiteTeam, teams.darkTeam);
        res.json({ success: true, message: "Roster released successfully. Reset arm is now ON.", whiteTeam: teams.whiteTeam, darkTeam: teams.darkTeam, whiteRating: teams.whiteRating.toFixed(1), darkRating: teams.darkRating.toFixed(1), signupLocked: true, rosterReleased: true });
    } catch (error) {
        console.error('Release roster error:', error);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

app.post('/api/admin/manual-reset', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!isAuthorizedAdminRequest(req)) return res.status(401).send("Unauthorized");
    await savePaymentReportSnapshot('manual_reset');
    if (rosterReleased && currentWeekData.weekNumber) {
        await saveWeekHistory(currentWeekData.year, currentWeekData.weekNumber, currentWeekData.whiteTeam, currentWeekData.darkTeam);
    }
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    try {
        await runProtectedMutation('manual-reset', req, async () => {
            playerSpots = 20; players = []; waitlist = []; rosterReleased = false; lastResetWeek = week; gameDate = calculateNextGameDate();
            currentWeekData = { weekNumber: week, year, releaseDate: null, whiteTeam: [], darkTeam: [] };
            manualOverride = false; manualOverrideState = null; requirePlayerCode = true; lastExactResetRunAt = ''; lastExactRosterReleaseRunAt = ''; clearAnnouncementState();
            await addAutoPlayers();
        }, { week, year });
    } catch (err) {
        console.error('Error resetting:', err);
        return res.status(500).json({ error: 'Manual reset could not be saved safely' });
    }
    res.json({ success: true, message: "Manual reset completed", code: playerSignupCode });
});

// ADMIN ONLY: Export payment data to CSV
app.get('/api/admin/export-payments', async (req, res) => {
    const { sessionToken } = req.query;

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized - Admin access only" });
    }

    try {
        const csvContent = buildPaymentReportCsv();
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="hockey-payments-${gameDate || 'current'}.csv"`);
        res.send(csvContent);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Failed to export payment report' });
    }
});

app.get('/api/admin/payment-reports', async (req, res) => {
    const { sessionToken, limit } = req.query;

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized - Admin access only' });
    }

    const reports = await listPaymentReports(limit);
    res.json({ reports });
});

app.get('/api/admin/payment-reports/latest', async (req, res) => {
    const { sessionToken } = req.query;

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized - Admin access only' });
    }

    const report = await getLatestPaymentReport();
    if (!report) {
        return res.status(404).json({ error: 'No saved payment reports found yet.' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${report.report_name}"`);
    res.send(report.report_csv);
});

app.get('/api/admin/payment-reports/:id/download', async (req, res) => {
    const { sessionToken } = req.query;

    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized - Admin access only' });
    }

    const reportId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reportId)) {
        return res.status(400).json({ error: 'Invalid report ID.' });
    }

    const report = await getPaymentReportById(reportId);
    if (!report) {
        return res.status(404).json({ error: 'Payment report not found.' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${report.report_name}"`);
    res.send(report.report_csv);
});

app.delete('/api/admin/payment-reports/:id', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized - Admin access only' });
    }

    const reportId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reportId)) {
        return res.status(400).json({ error: 'Invalid report ID.' });
    }

    const result = await deletePaymentReportById(reportId);
    if (!result.success) {
        return res.status(result.error === 'Payment report not found.' ? 404 : 500).json({
            error: result.error || 'Failed to delete payment report.'
        });
    }

    res.json({ success: true, deleted: result.deleted || 1, id: reportId });
});


function readLocalBackupSummary() {
    try {
        const best = getBestLocalSnapshot();
        if (!best || !best.data) {
            return { exists: false, players: 0, waitlist: 0, savedAt: null };
        }
        const raw = best.data;
        return {
            exists: true,
            file: best.file,
            players: Array.isArray(raw.players) ? raw.players.length : 0,
            waitlist: Array.isArray(raw.waitlist) ? raw.waitlist.length : 0,
            savedAt: raw.savedAt || null
        };
    } catch (err) {
        return {
            exists: false,
            players: 0,
            waitlist: 0,
            savedAt: null,
            error: err.message
        };
    }
}

function getSystemWarnings(dbInfo, backupInfo) {
    const warnings = [];
    const nowMs = Date.now();

    if (!lastSchedulerRunAt) {
        warnings.push('Scheduler has not run yet on this process.');
    } else if (nowMs - new Date(lastSchedulerRunAt).getTime() > 10 * 60 * 1000) {
        warnings.push('Scheduler has not run in the last 10 minutes.');
    }

    if (lastCronHeartbeatAt && nowMs - new Date(lastCronHeartbeatAt).getTime() > 10 * 60 * 1000) {
        warnings.push('No cron heartbeat received in the last 10 minutes.');
    }

    if (dbInfo && dbInfo.mode === 'postgres' && !dbInfo.ok) {
        warnings.push('Postgres ping failed. Running app may be degraded until Neon reconnects.');
    }

    if (consecutiveDbFailures >= 3) {
        warnings.push(`Database ping has failed ${consecutiveDbFailures} times in a row.`);
    }

    if (backupInfo && backupInfo.exists) {
        if (backupInfo.players !== players.length || backupInfo.waitlist !== waitlist.length) {
            warnings.push('Local backup counts do not match in-memory counts yet.');
        }
    } else {
        warnings.push('Local backup file is missing.');
    }

    return warnings;
}

app.get('/api/admin/system-status', async (req, res) => {
    if (!isAuthorizedAdminRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await pingDatabase();
    const backup = readLocalBackupSummary();
    const mem = process.memoryUsage();

    return res.json({
        ok: db.ok || db.mode === 'file',
        database: db,
        persistence: {
            strictDatabaseMode: STRICT_DATABASE_MODE,
            hasDatabaseUrl: HAS_DB,
            databaseGuardRetries: DB_GUARD_RETRIES,
            databaseGuardRetryDelayMs: DB_GUARD_RETRY_DELAY_MS,
            localSnapshotsAreEmergencyOnly: STRICT_DATABASE_MODE && HAS_DB
        },
        service: process.env.LEAGUE_NAME || 'hockey',
        uptimeSeconds: Math.round(process.uptime()),
        scheduler: {
            running: schedulerRunning,
            lastRunAt: lastSchedulerRunAt,
            lastDurationMs: lastSchedulerDurationMs,
            lastMinuteKey: lastSchedulerMinuteKey,
            lastError: lastSchedulerError || null
        },
        heartbeat: {
            lastCronHeartbeatAt,
            lastHealthPingAt,
            lastCronUserAgent
        },
        counts: {
            players: players.length,
            skaters: getPlayerCount(),
            goalies: getGoalieCount(),
            waitlist: waitlist.length,
            playerSpotsRemaining: playerSpots
        },
        consistency: {
            memoryPlayers: players.length,
            memoryWaitlist: waitlist.length,
            backupPlayers: backup.players,
            backupWaitlist: backup.waitlist,
            backupSavedAt: backup.savedAt,
            backupExists: backup.exists,
            latestSnapshotMeta: latestLocalSnapshotMeta
        },
        dataAudit: recentDataAudit,
        process: {
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
            nodeEnv: process.env.NODE_ENV || 'development'
        },
        warnings: getSystemWarnings(db, backup),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/cron/heartbeat', async (req, res) => {
    lastCronHeartbeatAt = new Date().toISOString();
    lastCronUserAgent = req.headers['user-agent'] || '';
    await runSchedulerTick();
    const db = await pingDatabase();
    res.status(db.ok || db.mode === 'file' ? 200 : 503).json({
        ok: db.ok || db.mode === 'file',
        scheduler: 'ran',
        database: db,
        gameDay: getGameDayName(),
        rosterReleased,
        playerCount: players.length,
        waitlistCount: waitlist.length,
        timestamp: new Date().toISOString()
    });
});

app.head('/api/cron/heartbeat', async (req, res) => {
    lastCronHeartbeatAt = new Date().toISOString();
    lastCronUserAgent = req.headers['user-agent'] || '';
    await runSchedulerTick();
    res.sendStatus(200);
});

// Health check endpoint (for Render + cron-job.org)
app.get('/health', async (req, res) => {
    lastHealthPingAt = new Date().toISOString();
    await runSchedulerTick();
    const db = await pingDatabase();
    res.status(db.ok || db.mode === 'file' ? 200 : 503).json({
        ok: db.ok || db.mode === 'file',
        service: process.env.LEAGUE_NAME || 'hockey',
        uptime: process.uptime(),
        database: db,
        schedulerRunning,
        lastSchedulerMinuteKey,
        gameDay: getGameDayName(),
        timestamp: new Date().toISOString()
    });
});

app.head('/health', async (req, res) => {
    lastHealthPingAt = new Date().toISOString();
    await runSchedulerTick();
    res.sendStatus(200);
});

app.get('/api/health', async (req, res) => {
    lastHealthPingAt = new Date().toISOString();
    await runSchedulerTick();
    const db = await pingDatabase();
    res.status(db.ok || db.mode === 'file' ? 200 : 503).json({
        ok: db.ok || db.mode === 'file',
        service: process.env.LEAGUE_NAME || 'hockey',
        uptime: process.uptime(),
        database: db,
        schedulerRunning,
        lastSchedulerMinuteKey,
        gameDay: getGameDayName(),
        timestamp: new Date().toISOString()
    });
});

app.head('/api/health', async (req, res) => {
    lastHealthPingAt = new Date().toISOString();
    await runSchedulerTick();
    res.sendStatus(200);
});


async function flushAndExit(code = 0, signal = 'exit') {
    try {
        await saveData(`shutdown-${String(signal).toLowerCase()}`);
        await appendDataAudit('shutdown_flush', 'success', { signal, code });
    } catch (err) {
        console.error('Shutdown flush error:', err.message);
    } finally {
        process.exit(code);
    }
}

process.on('SIGINT', () => { flushAndExit(0, 'SIGINT'); });
process.on('SIGTERM', () => { flushAndExit(0, 'SIGTERM'); });
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    flushAndExit(1, 'uncaughtException');
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    flushAndExit(1, 'unhandledRejection');
});

// Initialize and start
initDatabase().then(async () => {
    if (!STRICT_DATABASE_MODE) {
        await reconcileFromFileBackup();
        await runDatabaseSelfHeal('startup');
    }
    checkAutoLock();
    runSchedulerTick();
    
    // Safety net only: the app no longer depends on cron because every request runs catch-up logic.
    cron.schedule(process.env.INTERNAL_SCHEDULER_CRON || '* * * * *', async () => {
        await runSchedulerTick();
    }, {
        timezone: 'America/New_York'
    });

    setInterval(() => {
        runSchedulerTick().catch(err => console.error('Warm scheduler tick error:', err));
    }, Number(process.env.WARM_TICK_MS || 60000));
    
    app.listen(PORT, () => {
        console.log(`Phan's Friday Hockey server running on port ${PORT}`);
        console.log(`Location: ${gameLocation}`);
        console.log(`Time: ${gameTime}`);
        console.log(`Date: ${gameDate}`);
        console.log(`Current signup code: ${getDynamicSignupCode()}`);
        console.log(`Auto-add goalies for ${getGameDayName()}: ${getWeeklyAutoAddPlayers().filter(p => p.isGoalie).map(p => `${p.firstName} ${p.lastName}`).join(', ')}`);
        console.log(`Current players registered: ${players.length}`);
    });
}).catch(err => {
    console.error('Failed to initialize database, starting with file fallback:', err);
    loadDataFromFile();
    
    checkAutoLock();
    runSchedulerTick();
    
    // Safety net only: the app no longer depends on cron because every request runs catch-up logic.
    cron.schedule(process.env.INTERNAL_SCHEDULER_CRON || '* * * * *', async () => {
        await runSchedulerTick();
    }, {
        timezone: 'America/New_York'
    });

    setInterval(() => {
        runSchedulerTick().catch(err => console.error('Warm scheduler tick error:', err));
    }, Number(process.env.WARM_TICK_MS || 60000));
    
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (file fallback mode)`);
    });
});