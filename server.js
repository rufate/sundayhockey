const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const HAS_DB = !!process.env.DATABASE_URL;

// IMPORTANT: Render (and many hosts) will NOT have Postgres listening on localhost.
// If DATABASE_URL is not set, we run in "file mode" and skip all DB calls.
const pool = HAS_DB ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    min: 0,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500
}) : null;

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

// Middleware
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.static('public'));

// --- DATA STORE ---
let playerSpots = 20;
let players = []; 
let waitlist = [];
const ADMIN_PASSWORD = "964888";

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

function getDynamicSignupCode(dayName = getGameDayName()) {
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


// Store admin sessions
let adminSessions = {};

// Weekly reset tracking
let lastResetWeek = null;
let rosterReleased = false;
let currentWeekData = {
    weekNumber: null,
    year: null,
    releaseDate: null,
    rosterReleaseTime: null,
    whiteTeam: [],
    darkTeam: []
};

const MAX_GOALIES = 2;

const GAME_RULES = [
    "No Contact, may tie up player along board plays.",
    "Keep negative comments to yourself.",
    "Pass the puck!",
    "Don't stick handle around everyone each and every shift. Don't be a hotdog.",
    "Shift OFF often.",
    "No slashing period., lift the bloody stick. If you slash, intentional or not and hurt the opposing player. You are done for the night and future infraction will end in being Banned period.",
    "Skate hard, shift off when you're huffing and puffing.",
    "Don't need to be overly aggressive, tone down the aggression. If pickup hockey.",
    "Slap shots, don't take it if you can't control it. If you hit goalies in the head, or hurt anyone, you are banned from taking slapshots.",
    "Have fun! And don't forget Traditional Handshake/Fist bump when game ends!"
];

// ============================================
// NEW CONFIGURATION SECTION - ADD THESE HERE
// ============================================

// --- AUTO-ADD PLAYERS CONFIG ---
const AUTO_ADD_PLAYERS = [
    {
        firstName: "Phan",
        lastName: "Ly",
        phone: "(519) 566-9288",
        rating: 6,
        isGoalie: false,
        isFree: true,
        paymentMethod: "FREE",
        protected: true  // Cannot be cancelled from signup page
    },
    {
        firstName: "Craig",
        lastName: "Scolack",  // FIXED: Scolak -> Scolack
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
];

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

function shouldBeLocked() {
    if (!signupLockSchedule || !signupLockSchedule.enabled) return false;
    if (!signupLockStartAt || !signupLockEndAt) return false;

    const etNow = getCurrentETTime();
    const startAt = parseDatetimeLocalToETDate(signupLockStartAt);
    const endAt = parseDatetimeLocalToETDate(signupLockEndAt);
    if (!startAt || !endAt) return false;

    const nowKey = nowETMinuteKey(etNow);
    const startKey = etPartsToMinuteKey(startAt);
    const endKey = etPartsToMinuteKey(endAt);
    if (endKey <= startKey) return false;

    return nowKey >= startKey && nowKey < endKey;
}

function checkAutoLock() {
    refreshDynamicSignupCode();
    const etTime = getCurrentETTime();

    if (rosterReleased) {
        if (!requirePlayerCode || manualOverrideState !== 'locked' || !manualOverride) {
            requirePlayerCode = true;
            manualOverride = true;
            manualOverrideState = 'locked';
            saveData();
        }
        return {
            requirePlayerCode: true,
            manualOverride: true,
            manualOverrideState: 'locked',
            isLockedWindow: true,
            rosterReleased: true
        };
    }

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


// Auto-release roster at the exact admin-scheduled ET datetime
async function autoReleaseRoster() {
    const etTime = getCurrentETTime();

    if (!rosterReleaseSchedule || !rosterReleaseSchedule.enabled) return false;
    if (!rosterReleaseAt) return false;
    if (rosterReleased || players.length === 0) return false;

    const exactReleaseAt = parseDatetimeLocalToETDate(rosterReleaseAt);
    if (!exactReleaseAt) return false;

    const exactKey = rosterReleaseAt;
    const nowKey = nowETMinuteKey(etTime);
    const releaseKey = etPartsToMinuteKey(exactReleaseAt);

    if (nowKey < releaseKey) return false;
    if (lastExactRosterReleaseRunAt === exactKey) return false;

    lastExactRosterReleaseRunAt = exactKey;

    try {
        const { week, year } = getWeekNumber(etTime);
        const teams = generateFairTeams();

        rosterReleased = true;
        requirePlayerCode = true;
        manualOverride = true;
        manualOverrideState = 'locked';

        // Auto-enable payment reminder when roster is released
        announcementEnabled = true;
        announcementText = 'E-transfer required immediately after roster release.';

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
        }

        if (pool) {
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
    console.log('Adding auto-players for new week...');
    let addedCount = 0;
    
    for (const autoPlayer of AUTO_ADD_PLAYERS) {
        // Check if player already exists
        const normalizedName = (autoPlayer.firstName + ' ' + autoPlayer.lastName).toLowerCase().trim();
        const normalizedPhone = autoPlayer.phone.replace(/\D/g, '');
        
        const exists = players.find(p => 
            (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
            p.phone.replace(/\D/g, '') === normalizedPhone
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
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                 newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, 
                 autoPlayer.isGoalie, null, true]
            );
            players.push(newPlayer);
            
            if (!autoPlayer.isGoalie) {
                playerSpots--;
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


// Weekly reset - exact admin-scheduled ET datetime only
async function checkWeeklyReset() {
    const etTime = getCurrentETTime();
    const { week: currentWeek, year: currentYear } = getWeekNumber(etTime);

    if (!resetWeekSchedule || !resetWeekSchedule.enabled) return false;
    if (!resetWeekAt) return false;

    const exactResetAt = parseDatetimeLocalToETDate(resetWeekAt);
    if (!exactResetAt) return false;

    const exactKey = resetWeekAt;
    const nowKey = nowETMinuteKey(etTime);
    const resetKeyNum = etPartsToMinuteKey(exactResetAt);

    if (nowKey < resetKeyNum) return false;
    if (lastExactResetRunAt === exactKey) return false;

    lastExactResetRunAt = exactKey;

    await savePaymentReportSnapshot('scheduled_reset');

    if (rosterReleased && currentWeekData.weekNumber &&
        (currentWeekData.whiteTeam.length > 0 || currentWeekData.darkTeam.length > 0) && pool) {
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
    refreshDynamicSignupCode();
    resetWeekAt = '';
    signupLockStartAt = '';
    signupLockEndAt = '';
    rosterReleaseAt = '';
    signupLockSchedule.start = null;
    signupLockSchedule.end = null;
    rosterReleaseSchedule.at = null;
    resetWeekSchedule.at = null;
    lastExactRosterReleaseRunAt = '';

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

async function runSchedulerTick() {
    if (schedulerRunning) return;

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
    } catch (err) {
        console.error('Scheduler tick error:', err);
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
                rating INTEGER NOT NULL,
                is_goalie BOOLEAN DEFAULT false,
                team VARCHAR(10),
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                rules_agreed BOOLEAN DEFAULT false
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS waitlist (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                rating INTEGER NOT NULL,
                is_goalie BOOLEAN DEFAULT false,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
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
        
        await loadDataFromDB();
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
        if (settings.currentWeekData) currentWeekData = settings.currentWeekData;
        if (settings.signupLockStartAt !== undefined) signupLockStartAt = settings.signupLockStartAt || '';
        if (settings.signupLockEndAt !== undefined) signupLockEndAt = settings.signupLockEndAt || '';
        if (settings.rosterReleaseAt !== undefined) rosterReleaseAt = settings.rosterReleaseAt || '';
        if (settings.resetWeekAt !== undefined) resetWeekAt = settings.resetWeekAt || '';
        if (settings.lastExactResetRunAt !== undefined) lastExactResetRunAt = settings.lastExactResetRunAt || '';
        if (settings.lastExactRosterReleaseRunAt !== undefined) lastExactRosterReleaseRunAt = settings.lastExactRosterReleaseRunAt || '';
        if (settings.signupLockSchedule) signupLockSchedule = settings.signupLockSchedule;
        if (settings.rosterReleaseSchedule) rosterReleaseSchedule = settings.rosterReleaseSchedule;
        if (settings.resetWeekSchedule) resetWeekSchedule = settings.resetWeekSchedule;
        refreshDynamicSignupCode();
        
        const playersRes = await pool.query('SELECT * FROM players ORDER BY registered_at');
        players = playersRes.rows.map(p => ({
            id: Number(p.id),
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            paid: !!p.paid,
            paidAmount: p.paid_amount == null ? null : Number(p.paid_amount),
            rating: Number(p.rating),
            isGoalie: !!p.is_goalie,
            team: p.team,
            registeredAt: p.registered_at,
            rulesAgreed: !!p.rules_agreed
        }));
        
        // FIX: Recalculate playerSpots based on actual player count
        const nonGoalieCount = players.filter(p => !p.isGoalie).length;
        playerSpots = Math.max(0, 20 - nonGoalieCount);
                
        const waitlistRes = await pool.query('SELECT * FROM waitlist ORDER BY joined_at');
        waitlist = waitlistRes.rows.map(p => ({
            id: Number(p.id),
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            rating: Number(p.rating),
            isGoalie: !!p.is_goalie,
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
        if (appSettings.announcementImages !== undefined) {
            try {
                announcementImages = JSON.parse(appSettings.announcementImages || '[]');
                if (!Array.isArray(announcementImages)) announcementImages = [];
            } catch {
                announcementImages = [];
            }
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

async function saveData() {
    try {
        await saveSetting('playerSpots', playerSpots);
        await saveSetting('gameLocation', gameLocation);
        await saveSetting('gameTime', gameTime);
        await saveSetting('gameDate', gameDate);
        await saveSetting('playerSignupCode', playerSignupCode);
        await saveSetting('requirePlayerCode', requirePlayerCode);
        await saveSetting('manualOverride', manualOverride);
        await saveSetting('manualOverrideState', manualOverrideState);
        await saveSetting('lastResetWeek', lastResetWeek);
        await saveSetting('rosterReleased', rosterReleased);
        await saveSetting('currentWeekData', currentWeekData);
        await saveSetting('signupLockStartAt', signupLockStartAt);
        await saveSetting('signupLockEndAt', signupLockEndAt);
        await saveSetting('rosterReleaseAt', rosterReleaseAt);
        await saveSetting('resetWeekAt', resetWeekAt);
        await saveSetting('lastExactResetRunAt', lastExactResetRunAt);
        await saveSetting('lastExactRosterReleaseRunAt', lastExactRosterReleaseRunAt);
        await saveSetting('signupLockSchedule', signupLockSchedule);
        await saveSetting('rosterReleaseSchedule', rosterReleaseSchedule);
        await saveSetting('resetWeekSchedule', resetWeekSchedule);
        await saveAppSetting('maintenanceMode', maintenanceMode);
        await saveAppSetting('customTitle', customTitle);
        await saveAppSetting('announcementEnabled', announcementEnabled.toString());
        await saveAppSetting('announcementText', announcementText);
        await saveAppSetting('announcementImages', JSON.stringify(announcementImages));
        await saveAppSetting('selectedDayTime', gameTime);
        await saveAppSetting('selectedArena', gameLocation);
        await saveAppSetting('gameDate', gameDate);
        writeSettingsBackup('saveData');
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

const DATA_FILE = './data.json';
const SETTINGS_BACKUP_FILE = './app-settings.backup.json';

function getSettingsSnapshot() {
    return {
        savedAt: new Date().toISOString(),
        maintenanceMode,
        customTitle,
        announcementEnabled,
        announcementText,
        announcementImages,
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
        currentWeekData
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
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            playerSpots = data.playerSpots ?? 20;
            players = data.players ?? [];
            waitlist = data.waitlist ?? [];
            gameLocation = data.gameLocation ?? "Capri Recreation Complex";
            gameTime = data.gameTime ?? "Friday 9:30 PM";
            gameDate = data.gameDate ?? calculateNextGameDate();
            playerSignupCode = data.playerSignupCode ?? '9855';
            requirePlayerCode = data.requirePlayerCode ?? true;
            manualOverride = data.manualOverride ?? false;
            manualOverrideState = data.manualOverrideState ?? null;
            lastResetWeek = data.lastResetWeek ?? null;
            rosterReleased = data.rosterReleased ?? false;
            signupLockStartAt = data.signupLockStartAt ?? '';
            signupLockEndAt = data.signupLockEndAt ?? '';
            rosterReleaseAt = data.rosterReleaseAt ?? '';
            resetWeekAt = data.resetWeekAt ?? '';
            lastExactResetRunAt = data.lastExactResetRunAt ?? '';
            lastExactRosterReleaseRunAt = data.lastExactRosterReleaseRunAt ?? '';
            signupLockSchedule = data.signupLockSchedule ?? signupLockSchedule;
            rosterReleaseSchedule = data.rosterReleaseSchedule ?? rosterReleaseSchedule;
            resetWeekSchedule = data.resetWeekSchedule ?? resetWeekSchedule;
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

function generateFairTeams() {
    const goalies = players.filter(p => p.isGoalie);
    const skaters = players.filter(p => !p.isGoalie);
    
    skaters.sort((a, b) => {
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    goalies.sort((a, b) => {
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    let whiteTeam = [];
    let darkTeam = [];
    let whiteRating = 0;
    let darkRating = 0;
    
    if (goalies.length >= 2) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        darkTeam.push({ ...goalies[1], team: 'Dark' });
        whiteRating += parseInt(goalies[0].rating) || 0;
        darkRating += parseInt(goalies[1].rating) || 0;
    } else if (goalies.length === 1) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        whiteRating += parseInt(goalies[0].rating) || 0;
    }
    
    let whiteTurn = whiteTeam.length <= darkTeam.length;
    
    for (let i = 0; i < skaters.length; i++) {
        const skater = skaters[i];
        
        if (whiteTurn) {
            whiteTeam.push({ ...skater, team: 'White' });
            whiteRating += parseInt(skater.rating) || 0;
        } else {
            darkTeam.push({ ...skater, team: 'Dark' });
            darkRating += parseInt(skater.rating) || 0;
        }
        
        whiteTurn = !whiteTurn;
        
        if (Math.abs(whiteTeam.length - darkTeam.length) > 1) {
            whiteTurn = whiteTeam.length < darkTeam.length;
        }
    }
    
    const sortTeam = (team) => {
        return team.sort((a, b) => {
            if (a.isGoalie && !b.isGoalie) return -1;
            if (!a.isGoalie && b.isGoalie) return 1;
            const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
            const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
            return nameA.localeCompare(nameB);
        });
    };
    
    whiteTeam = sortTeam(whiteTeam);
    darkTeam = sortTeam(darkTeam);
    
    players = [...whiteTeam, ...darkTeam];
    
    return { whiteTeam, darkTeam, whiteRating, darkRating };
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
            escapeCsvValue(p.rating),
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
            escapeCsvValue(p.rating),
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
        const reportName = `payment-report-${safeGameDate}-week-${activeWeek}-${Date.now()}.csv`;
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
    return `${String(etParts.year).padStart(4, '0')}-${String(etParts.month).padStart(2, '0')}-${String(etParts.day).padStart(2, '0')}T${String(etParts.hour).padStart(2, '0')}:${String(etParts.minute).padStart(2, '0')}:00-05:00`;
}

function getSignupOpenMessageData() {
    const nextOpenAt = (signupLockSchedule && signupLockSchedule.enabled && signupLockEndAt)
        ? parseDatetimeLocalToETDate(signupLockEndAt)
        : null;
    const openLabel = nextOpenAt ? formatETDateTimeLong(nextOpenAt) : null;

    const releaseAtParts = (rosterReleaseSchedule && rosterReleaseSchedule.enabled && rosterReleaseAt)
        ? parseDatetimeLocalToETDate(rosterReleaseAt)
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
            : `Team rosters are released at the scheduled time`
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
    
    res.json({
        playerSpotsRemaining: playerSpots > 0 ? playerSpots : 0,
        goalieCount: goalieCount,
        goalieSpotsAvailable: MAX_GOALIES - goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        isFull: playerSpots === 0,
        waitlistCount: waitlist.length,
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
        rosterReleaseLine: signupMessageData.rosterReleaseLine
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
    
    if (!adminSessions[sessionToken]) {
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

app.post('/api/verify-code', (req, res) => {
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

app.post('/api/register-init', async (req, res) => {
    refreshDynamicSignupCode();
    checkAutoLock();

    const { firstName, lastName, phone, paymentMethod, rating, signupCode } = req.body;

    if (rosterReleased) {
        return res.status(403).json({ error: 'Signup is closed after roster release.' });
    }

    if (!firstName || !lastName || !phone || !paymentMethod || !rating) {
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

    const ratingNum = parseInt(rating);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 10) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 10." });
    }

    if (playerSpots <= 0) {
        const formattedPhone = cleanPhone;
        const waitlistPlayer = {
            id: Date.now(),
            firstName: cleanFirstName,
            lastName: cleanLastName,
            phone: formattedPhone,
            paymentMethod,
            rating: ratingNum,
            isGoalie: false,
            joinedAt: new Date()
        };

        try {
            await pool.query(
                `INSERT INTO waitlist (id, first_name, last_name, phone, payment_method, rating, is_goalie)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName, 
                 waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating, false]
            );
            waitlist.push(waitlistPlayer);
        } catch (err) {
            console.error('Error adding to waitlist:', err);
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
            rating: ratingNum,
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
    
    const newPlayer = {
        id: Date.now(),
        firstName: tempData.firstName,
        lastName: tempData.lastName,
        phone: tempData.phone,
        paymentMethod: tempData.paymentMethod,
        paid: false,
        paidAmount: null,
        rating: parseInt(tempData.rating) || 5,
        isGoalie: false,
        team: null,
        registeredAt: new Date().toISOString(),
        rulesAgreed: true
    };

    try {
        await pool.query(
            `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
             newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, false, null, true]
        );
        players.push(newPlayer);
        playerSpots--;
        await saveData();
    } catch (err) {
        console.error('Error saving player:', err);
        return res.status(500).json({ error: "Database error" });
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
app.post('/api/cancel-registration', async (req, res) => {
    const { playerId, phone } = req.body;

    if (playerId === undefined || playerId === null || !phone) {
        return res.status(400).json({ error: "Player ID and phone number are required." });
    }

    const idToRemove = String(playerId).trim();
    if (!idToRemove) {
        return res.status(400).json({ error: "Invalid player ID." });
    }

    if (rosterReleased) {
        return res.status(403).json({ error: "Cannot cancel after roster has been released." });
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
    if (playerIndex !== -1) {
        const player = players[playerIndex];

        if (isProtectedPlayer(player)) {
            return res.status(403).json({ error: "This player cannot be cancelled online. Please contact admin." });
        }

        const storedPhone = normalizePhoneDigits(player.phone);
        if (submittedPhone !== storedPhone) {
            return res.status(401).json({ error: "Phone number does not match registration." });
        }

        try {
            if (pool) {
                await pool.query('DELETE FROM players WHERE id = $1', [player.id]);
            }
        } catch (err) {
            console.error('Error removing from players database:', err);
        }

        players.splice(playerIndex, 1);
        playerSpots++;

        let promotedPlayer = null;

        if (waitlist.length > 0) {
            const waitlistPlayer = waitlist.shift();

            promotedPlayer = {
                id: waitlistPlayer.id,
                firstName: waitlistPlayer.firstName,
                lastName: waitlistPlayer.lastName,
                phone: waitlistPlayer.phone,
                paymentMethod: waitlistPlayer.paymentMethod,
                paid: false,
                paidAmount: null,
                rating: parseInt(waitlistPlayer.rating) || 5,
                isGoalie: waitlistPlayer.isGoalie,
                team: null,
                registeredAt: new Date().toISOString(),
                rulesAgreed: true
            };

            players.push(promotedPlayer);
            playerSpots--;

            try {
                if (pool) {
                    await pool.query('DELETE FROM waitlist WHERE id = $1', [waitlistPlayer.id]);
                    await pool.query(
                        `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                        [promotedPlayer.id, promotedPlayer.firstName, promotedPlayer.lastName, promotedPlayer.phone,
                         promotedPlayer.paymentMethod, promotedPlayer.paid, promotedPlayer.paidAmount, promotedPlayer.rating, promotedPlayer.isGoalie, null, true]
                    );
                }
            } catch (err) {
                console.error('Error promoting waitlist player:', err);
            }
        }

        await saveData();

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

    const waitlistIndex = findById(waitlist);
    if (waitlistIndex !== -1) {
        const waitlistPlayer = waitlist[waitlistIndex];

        if (isProtectedPlayer(waitlistPlayer)) {
            return res.status(403).json({ error: "This player cannot be cancelled online. Please contact admin." });
        }

        const storedPhone = normalizePhoneDigits(waitlistPlayer.phone);
        if (submittedPhone !== storedPhone) {
            return res.status(401).json({ error: "Phone number does not match registration." });
        }

        try {
            if (pool) {
                await pool.query('DELETE FROM waitlist WHERE id = $1', [waitlistPlayer.id]);
            }
        } catch (err) {
            console.error('Error removing from waitlist database:', err);
        }

        waitlist.splice(waitlistIndex, 1);
        await saveData();

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
    const { sessionToken } = req.body;
    if (adminSessions[sessionToken]) {
        res.json({ loggedIn: true });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const sessionToken = Date.now().toString() + Math.random().toString();
        adminSessions[sessionToken] = true;
        res.json({ success: true, sessionToken: sessionToken });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============================================
// NEW ADMIN ENDPOINTS - ADD THESE HERE
// ============================================

// Get app settings (maintenance mode, title, etc.)
app.post('/api/admin/app-settings', (req, res) => {
    const { sessionToken } = req.body;
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    res.json({
        maintenanceMode,
        customTitle,
        announcementEnabled,
        announcementText,
        announcementImages,
        selectedDayTime: gameTime,
        selectedArena: gameLocation,
        gameDate,
        arenaOptions: ARENA_OPTIONS,
        dayTimeOptions: DAY_TIME_OPTIONS,
        backupGoalies: BACKUP_GOALIES
    });
});

// Update app settings
app.post('/api/admin/update-app-settings', async (req, res) => {
    const { sessionToken, maintenanceMode: newMaintenance, customTitle: newTitle,
            announcementEnabled: newAnnouncementEnabled, announcementText: newAnnouncementText, announcementImages: newAnnouncementImages,
            selectedDayTime, selectedArena, gameDate: newGameDate } = req.body;

    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        if (newMaintenance !== undefined) maintenanceMode = !!newMaintenance;
        if (newTitle !== undefined) customTitle = String(newTitle || '').trim() || customTitle;
        if (newAnnouncementEnabled !== undefined) announcementEnabled = !!newAnnouncementEnabled;
        if (newAnnouncementText !== undefined) announcementText = String(newAnnouncementText || '').trim();
        if (newAnnouncementImages !== undefined) {
            announcementImages = normalizeAnnouncementImages(newAnnouncementImages);
        }
        if (selectedDayTime) gameTime = selectedDayTime;
        if (selectedArena) gameLocation = selectedArena;
        if (newGameDate) gameDate = newGameDate;

        await saveAppSetting('maintenanceMode', maintenanceMode.toString());
        await saveAppSetting('customTitle', customTitle);
        await saveAppSetting('announcementEnabled', announcementEnabled.toString());
        await saveAppSetting('announcementText', announcementText);
        await saveAppSetting('announcementImages', JSON.stringify(announcementImages));
        await saveAppSetting('selectedDayTime', gameTime);
        await saveAppSetting('selectedArena', gameLocation);
        await saveAppSetting('gameDate', gameDate);
        writeSettingsBackup('update-app-settings');
        console.log('[ADMIN] App settings updated');

        res.json({
            success: true,
            maintenanceMode,
            customTitle,
            announcementEnabled,
            announcementText,
            announcementImages,
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

// Add backup goalie to roster
app.post('/api/admin/add-backup-goalie', async (req, res) => {
    const { sessionToken, goalieIndex } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    if (goalieIndex < 0 || goalieIndex >= BACKUP_GOALIES.length) {
        return res.status(400).json({ error: "Invalid goalie selection" });
    }
    
    const backupGoalie = BACKUP_GOALIES[goalieIndex];
    
    // Check if already exists
    const normalizedPhone = backupGoalie.phone.replace(/\D/g, '');
    const exists = players.find(p => p.phone.replace(/\D/g, '') === normalizedPhone);
    
    if (exists) {
        return res.status(400).json({ error: "This goalie is already registered" });
    }
    
    const newGoalie = {
        id: Date.now(),
        firstName: backupGoalie.firstName,
        lastName: backupGoalie.lastName,
        phone: backupGoalie.phone,
        paymentMethod: "N/A",
        paid: true,
        paidAmount: 0,
        rating: backupGoalie.rating,
        isGoalie: true,
        team: null,
        registeredAt: new Date().toISOString(),
        rulesAgreed: true
    };
    
    try {
        await pool.query(
            `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [newGoalie.id, newGoalie.firstName, newGoalie.lastName, newGoalie.phone,
             newGoalie.paymentMethod, newGoalie.paid, newGoalie.paidAmount, newGoalie.rating, true, null, true]
        );
        players.push(newGoalie);
        await saveData();
        
        res.json({
            success: true,
            goalie: newGoalie,
            message: `${backupGoalie.firstName} ${backupGoalie.lastName} added as substitute goalie`
        });
    } catch (err) {
        console.error('Error adding backup goalie:', err);
        res.status(500).json({ error: "Database error" });
    }
});

// END NEW ADMIN ENDPOINTS

// ADMIN ONLY: Get full player data with payment AND rating info
app.post('/api/admin/players-full', (req, res) => {
    const { sessionToken } = req.body;
    
    if (!sessionToken || !adminSessions[sessionToken]) {
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
        location: gameLocation, 
        time: gameTime,
        date: gameDate,
        rosterReleased, 
        currentWeekData, 
        playerSignupCode, 
        requirePlayerCode 
    });
});

// DEPRECATED: Old endpoint - redirect to new secure one
app.post('/api/admin/players', (req, res) => {
    // Forward to new secure endpoint
    req.url = '/api/admin/players-full';
    app._router.handle(req, res);
});

app.post('/api/admin/settings', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
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
        signupLockSchedule,
        rosterReleaseSchedule,
        resetWeekSchedule,
        signupLockStartAt,
        signupLockEndAt,
        rosterReleaseAt,
        resetWeekAt
    });
});

app.post('/api/admin/update-details', (req, res) => {
    const { password, sessionToken, location, time, date } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    if (location && location.trim().length > 0) {
        gameLocation = location.trim();
    }
    if (time && time.trim().length > 0) {
        gameTime = time.trim();
    }
    if (date && date.trim().length > 0) {
        gameDate = date.trim();
    }
    
    saveData();
    
    res.json({ 
        success: true, 
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate)
    });
});

app.post('/api/admin/update-code', (req, res) => {
    const { password, sessionToken, newCode } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized - invalid session" });
    }
    
    if (!newCode || !/^\d{4}$/.test(newCode)) {
        return res.status(400).json({ error: "Code must be exactly 4 digits" });
    }
    
    playerSignupCode = getDynamicSignupCode();
    saveData();
    
    res.json({ 
        success: true, 
        code: playerSignupCode, 
        requireCode: requirePlayerCode 
    });
});


app.post('/api/admin/update-schedules', async (req, res) => {
        const body = req.body || {};
    const { password, sessionToken, signupLockEnabled, signupLockStart, signupLockEnd, rosterReleaseEnabled, rosterReleaseAt: rosterReleaseAtInput, resetWeekEnabled, resetWeekAt: resetWeekAtInput } = body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    if (typeof signupLockEnabled === 'boolean') {
        signupLockSchedule.enabled = signupLockEnabled;
    }
    if (typeof rosterReleaseEnabled === 'boolean') {
        rosterReleaseSchedule.enabled = rosterReleaseEnabled;
    }
    if (typeof resetWeekEnabled === 'boolean') {
        resetWeekSchedule.enabled = resetWeekEnabled;
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

    signupLockStartAt = signupLockStart || '';
    signupLockEndAt = signupLockEnd || '';
    rosterReleaseAt = rosterReleaseAtInput || '';
    resetWeekAt = resetWeekAtInput || '';

    signupLockSchedule.start = signupLockStartAt ? parseDatetimeLocalToDowTime(signupLockStartAt) : null;
    signupLockSchedule.end = signupLockEndAt ? parseDatetimeLocalToDowTime(signupLockEndAt) : null;
    rosterReleaseSchedule.at = rosterReleaseAt ? parseDatetimeLocalToDowTime(rosterReleaseAt) : null;
    resetWeekSchedule.at = resetWeekAt ? parseDatetimeLocalToDowTime(resetWeekAt) : null;

    await saveData();
    writeSettingsBackup('update-schedules');
    console.log('[ADMIN] Schedules updated');
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
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow
    });
});

app.post('/api/admin/toggle-code', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const newRequireCode = !requirePlayerCode;
    
    requirePlayerCode = newRequireCode;
    manualOverride = true;
    manualOverrideState = newRequireCode ? 'locked' : 'open';
    
    saveData();
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        code: playerSignupCode 
    });
});

app.post('/api/admin/reset-schedule', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    manualOverride = false;
    manualOverrideState = null;
    
    const result = checkAutoLock();
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        message: "Auto-schedule restored"
    });
});

app.post('/api/admin/promote-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const index = waitlist.findIndex(p => String(p.id) === String(waitlistId));
    if (index === -1) {
        return res.status(404).json({ error: "Player not found in waitlist" });
    }

    const player = waitlist.splice(index, 1)[0];
    
    const newPlayer = {
        id: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        phone: player.phone,
        paymentMethod: player.paymentMethod,
        paid: false,
        paidAmount: null,
        rating: parseInt(player.rating) || 5,
        isGoalie: player.isGoalie,
        team: null
    };
    
    try {
        if (pool) {
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                 newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, newPlayer.isGoalie, null]
            );
        }
        players.push(newPlayer);
        
        if (!player.isGoalie && playerSpots > 0) {
            playerSpots--;
        }
        
        await saveData();
    } catch (err) {
        console.error('Error promoting player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    res.json({ 
        success: true, 
        player: newPlayer,
        spots: playerSpots,
        override: playerSpots <= 0 && !player.isGoalie
    });
});

app.post('/api/admin/remove-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const index = waitlist.findIndex(p => String(p.id) === String(waitlistId));
    if (index === -1) {
        return res.status(404).json({ error: "Player not found in waitlist" });
    }

    const player = waitlist.splice(index, 1)[0];
    
    try {
        if (pool) {
            await pool.query('DELETE FROM waitlist WHERE id = $1', [player.id]);
        }
    } catch (err) {
        console.error('Error removing from waitlist:', err);
    }
    
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/add-player', async (req, res) => {
    const { password, sessionToken, firstName, lastName, phone, paymentMethod, rating, isGoalie, toWaitlist } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    if (!firstName || !lastName || !phone || !rating) {
        return res.status(400).json({ error: "First name, last name, phone, and rating required" });
    }

    const cleanFirstName = capitalizeFullName(firstName);
    const cleanLastName = capitalizeFullName(lastName);
    if (!validatePhoneNumber(phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
    }

    const formattedPhone = formatPhoneNumber(phone);
    const ratingNum = parseInt(rating) || 5;
    const isGoalieBool = isGoalie || false;

    if (toWaitlist) {
        const waitlistPlayer = {
            id: Date.now(),
            firstName: cleanFirstName,
            lastName: cleanLastName,
            phone: formattedPhone,
            paymentMethod: paymentMethod || 'Cash',
            rating: ratingNum,
            isGoalie: isGoalieBool,
            joinedAt: new Date()
        };
        
        try {
            await pool.query(
                `INSERT INTO waitlist (id, first_name, last_name, phone, payment_method, rating, is_goalie)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName,
                 waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating, isGoalieBool]
            );
            waitlist.push(waitlistPlayer);
        } catch (err) {
            console.error('Error adding to waitlist:', err);
            return res.status(500).json({ error: "Database error" });
        }
        
        saveData();
        res.json({ success: true, player: waitlistPlayer, inWaitlist: true });
    } else {
        if (isGoalieBool && !isGoalieSpotsAvailable()) {
            return res.status(400).json({ error: "Goalie spots are full (maximum 2)." });
        }
        
        const newPlayer = {
            id: Date.now(),
            firstName: cleanFirstName,
            lastName: cleanLastName,
            phone: formattedPhone,
            paymentMethod: paymentMethod || 'Cash',
            paid: isGoalieBool ? true : false,
            paidAmount: isGoalieBool ? 0 : null,
            rating: ratingNum,
            isGoalie: isGoalieBool,
            team: null
        };
        
        try {
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                 newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, isGoalieBool, null]
            );
            players.push(newPlayer);
            
            if (!isGoalieBool && playerSpots > 0) {
                playerSpots--;
            }
            
            await saveData();
        } catch (err) {
            console.error('Error adding player:', err);
            return res.status(500).json({ error: "Database error" });
        }
        
        res.json({ success: true, player: newPlayer, inWaitlist: false });
    }
});

// ADMIN REMOVE PLAYER - WORKS ON ANY PLAYER AT ANY TIME (NO RESTRICTIONS)
app.post('/api/admin/remove-player', async (req, res) => {
    const { password, sessionToken, playerId } = req.body;
    
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const idToRemove = parseInt(playerId);
    if (isNaN(idToRemove)) {
        return res.status(400).json({ error: "Invalid player ID" });
    }

    const index = players.findIndex(p => String(p.id) === String(idToRemove));
    
    if (index === -1) {
        return res.status(404).json({ error: "Player not found" });
    }

    const wasGoalie = players[index].isGoalie;
    const player = players.splice(index, 1)[0];
    
    try {
        await pool.query('DELETE FROM players WHERE id = $1', [player.id]);
        
        if (!wasGoalie) {
            playerSpots++;
        }
        
        await saveData();
    } catch (err) {
        console.error('Error removing player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    // Return the removed player info for confirmation message
    res.json({ 
        success: true, 
        spots: playerSpots, 
        removedPlayer: player 
    });
});

app.post('/api/admin/update-spots', (req, res) => {
    const { password, sessionToken, newSpots } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const spotCount = parseInt(newSpots);
    if (isNaN(spotCount) || spotCount < 0 || spotCount > 30) {
        return res.status(400).json({ error: "Invalid spot count (0-30 allowed)" });
    }
    
    playerSpots = spotCount;
    saveData();
    res.json({ success: true, spots: playerSpots });
});

// Update paid amount endpoint
app.post('/api/admin/update-paid-amount', async (req, res) => {
    const { password, sessionToken, playerId, amount } = req.body;
    
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const player = players.find(p => p.id === playerId);
    if (!player) {
        return res.status(404).json({ error: "Player not found" });
    }

    // Parse amount - allow empty/null for unpaid
    let paidAmount = null;
    let paid = false;
    
    if (amount !== '' && amount !== null && amount !== undefined) {
        const parsed = parseFloat(amount);
        if (!isNaN(parsed) && parsed >= 0) {
            paidAmount = parsed;
            paid = parsed > 0;
        }
    }

    player.paidAmount = paidAmount;
    player.paid = paid;

    try {
        await pool.query('UPDATE players SET paid_amount = $1, paid = $2 WHERE id = $3', 
            [paidAmount, paid, player.id]);
        saveData();
        
        // Calculate new total
        const totalPaid = players.reduce((sum, p) => {
            if (p.paidAmount && !isNaN(parseFloat(p.paidAmount))) {
                return sum + parseFloat(p.paidAmount);
            }
            return sum;
        }, 0);
        
        res.json({ success: true, player, totalPaid: totalPaid.toFixed(2) });
    } catch (err) {
        console.error('Error updating paid amount:', err);
        res.status(500).json({ error: "Database error" });
    }
});

// FIX: Store old rating before updating
app.post('/api/admin/update-rating', async (req, res) => {
    const { password, sessionToken, playerId, newRating } = req.body;

    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const ratingNum = parseInt(newRating);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 10) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 10" });
    }

    const player = players.find(p => p.id === parseInt(playerId));
    if (!player) {
        return res.status(404).json({ error: "Player not found" });
    }

    const oldRating = player.rating; // Store old rating before update
    player.rating = ratingNum;

    try {
        await pool.query('UPDATE players SET rating = $1 WHERE id = $2', [ratingNum, player.id]);
        saveData();
        res.json({ success: true, player, oldRating: oldRating, newRating: ratingNum });
    } catch (err) {
        console.error('Error updating rating:', err);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/admin/release-roster', async (req, res) => {
    const { password, sessionToken } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    if (players.length === 0) {
        return res.status(400).json({ error: "No players registered yet" });
    }
    
    try {
        const etTime = getCurrentETTime();
        const { week, year } = getWeekNumber(etTime);
        
        const teams = generateFairTeams();
        
        rosterReleased = true;
        requirePlayerCode = true;
        manualOverride = true;  // Keep locked after manual release
        manualOverrideState = 'locked';  // Force locked state

        // Auto-enable payment reminder when roster is released
        announcementEnabled = true;
        announcementText = 'E-transfer required immediately after roster release.';
        
        currentWeekData = {
            weekNumber: week,
            year: year,
            releaseDate: new Date().toISOString(),
            rosterReleaseTime: Date.now(),
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam
        };
        
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

        await saveData();
        
        res.json({ 
            success: true, 
            message: "Roster released successfully. Signup is now LOCKED until Monday 6pm.",
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam,
            whiteRating: teams.whiteRating.toFixed(1),
            darkRating: teams.darkRating.toFixed(1),
            signupLocked: true,
            rosterReleased: true
        });
    } catch (error) {
        console.error('Release roster error:', error);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

app.post('/api/admin/manual-reset', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    await savePaymentReportSnapshot('manual_reset');

    if (rosterReleased && currentWeekData.weekNumber) {
        await saveWeekHistory(
            currentWeekData.year,
            currentWeekData.weekNumber,
            currentWeekData.whiteTeam,
            currentWeekData.darkTeam
        );
    }
    
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    
    playerSpots = 20;
    players = [];
    waitlist = [];
    rosterReleased = false;
    lastResetWeek = week;
    gameDate = calculateNextGameDate();
    
    currentWeekData = {
        weekNumber: week,
        year: year,
        releaseDate: null,
        whiteTeam: [],
        darkTeam: []
    };
    
    manualOverride = false;
    manualOverrideState = null;
    requirePlayerCode = true;
    lastExactResetRunAt = '';
    
    // Code stays as 9855 - no auto-generation
    
    try {
        await pool.query('DELETE FROM players');
        await pool.query('DELETE FROM waitlist');
        
        // Auto-add predefined players after reset
        await addAutoPlayers();
        
        await saveData();
    } catch (err) {
        console.error('Error resetting:', err);
    }
    
    res.json({ success: true, message: "Manual reset completed", code: playerSignupCode });
});

// ADMIN ONLY: Export payment data to CSV
app.get('/api/admin/export-payments', async (req, res) => {
    const { sessionToken } = req.query;

    if (!sessionToken || !adminSessions[sessionToken]) {
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

    if (!sessionToken || !adminSessions[sessionToken]) {
        return res.status(401).json({ error: 'Unauthorized - Admin access only' });
    }

    const reports = await listPaymentReports(limit);
    res.json({ reports });
});

app.get('/api/admin/payment-reports/latest', async (req, res) => {
    const { sessionToken } = req.query;

    if (!sessionToken || !adminSessions[sessionToken]) {
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

    if (!sessionToken || !adminSessions[sessionToken]) {
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

// Initialize and start
initDatabase().then(() => {
    checkAutoLock();
    checkWeeklyReset();
    
    cron.schedule('* * * * *', async () => {
        await autoReleaseRoster();
        await checkWeeklyReset();
    }, {
        timezone: 'America/New_York'
    });
    
    app.listen(PORT, () => {
        console.log(`Phan's Friday Hockey server running on port ${PORT}`);
        console.log(`Location: ${gameLocation}`);
        console.log(`Time: ${gameTime}`);
        console.log(`Date: ${gameDate}`);
        console.log(`Current signup code: ${getDynamicSignupCode()}`);
        console.log(`Current players registered: ${players.length}`);
    });
}).catch(err => {
    console.error('Failed to initialize database, starting with file fallback:', err);
    loadDataFromFile();
    
    checkAutoLock();
    checkWeeklyReset();
    
    cron.schedule('* * * * *', async () => {
        await autoReleaseRoster();
        await checkWeeklyReset();
    }, {
        timezone: 'America/New_York'
    });
    
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (file fallback mode)`);
    });
});