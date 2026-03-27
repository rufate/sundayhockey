const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '964888';
const PUBLIC_DIR = '/mnt/data';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ET_ZONE = 'America/New_York';
const PHAN_NAME = 'phan';
const DEFAULT_CODE = '9648';
const DEFAULT_ARENA = 'WFCU Grenon';
const DEFAULT_DAY_TIME = 'Sunday 9:30 PM';
const DEFAULT_GAME_DAY = 'Sunday';
const MAX_GOALIES = 2;

const REGULAR_GOALIES = {
  craig: { firstName: 'Craig', lastName: 'Scolack', phone: '(519) 982-6311', rating: 9, paymentMethod: 'N/A', position: 'Goalie', isGoalie: true, paidAmount: 0 },
  hao: { firstName: 'Hao', lastName: 'Chau', phone: '(519) 995-9884', rating: 8, paymentMethod: 'N/A', position: 'Goalie', isGoalie: true, paidAmount: 0 },
  mat: { firstName: 'Mat', lastName: 'Carriere', phone: '(226) 350-0217', rating: 7, paymentMethod: 'N/A', position: 'Goalie', isGoalie: true, paidAmount: 0 }
};

function nowIso() { return new Date().toISOString(); }
function safeLower(v) { return String(v || '').trim().toLowerCase(); }
function digitsOnly(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}
function formatPhone(value) {
  const d = digitsOnly(value).slice(0, 10);
  if (!d) return '';
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0,3)}) ${d.slice(3)}`;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,10)}`;
}
function capitalizeNamePart(part) {
  return String(part || '').toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
}
function capitalizeFullName(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).map(capitalizeNamePart).join(' ');
}
function fullName(p) { return `${p.first_name || p.firstName || ''} ${p.last_name || p.lastName || ''}`.trim(); }
function isGoaliePlayer(p) {
  return !!p.is_goalie || !!p.isGoalie || ['goalie', 'g'].includes(safeLower(p.position));
}
function isPhanPlayer(p) { return safeLower(p.first_name || p.firstName) === PHAN_NAME; }
function ratingOf(p) { return Number(p.rating) || 0; }
function sumRatings(arr) { return arr.reduce((s, p) => s + ratingOf(p), 0); }
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function uuid() { return crypto.randomUUID(); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function startOfTodayEt() {
  const s = new Date().toLocaleString('en-US', { timeZone: ET_ZONE });
  const d = new Date(s);
  d.setHours(0,0,0,0);
  return d;
}
function etNowDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: ET_ZONE }));
}
function weekdayNameFromDatePart(datePart) {
  const [y,m,d] = String(datePart || '').split('-').map(Number);
  if (![y,m,d].every(Number.isFinite)) return DEFAULT_GAME_DAY;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(Date.UTC(y, m - 1, d)));
}
function parseSelectedDayTime(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  const weekday = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  let hour = parseInt(m[2], 10);
  const minute = parseInt(m[3], 10);
  const ap = m[4].toUpperCase();
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  return { weekday, hour, minute };
}
function formatTime12(hour24, minute) {
  const hour12 = ((hour24 + 11) % 12) + 1;
  const ap = hour24 >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(minute).padStart(2, '0')} ${ap}`;
}
function nextOccurrenceForDayTime(dayName, hour24, minute) {
  const map = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  const now = etNowDate();
  const target = map[dayName] ?? 0;
  let daysAhead = (target - now.getDay() + 7) % 7;
  const past = daysAhead === 0 && (now.getHours() > hour24 || (now.getHours() === hour24 && now.getMinutes() >= minute));
  if (past) daysAhead = 7;
  const result = new Date(now);
  result.setDate(now.getDate() + daysAhead);
  result.setHours(hour24, minute, 0, 0);
  return result;
}
function isoNoSecondsEt(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${da}T${h}:${mi}`;
}
function gameDayFromSettings(settings) {
  if (settings.game_day_name) return settings.game_day_name;
  if (settings.game_date) return weekdayNameFromDatePart(settings.game_date);
  const parsed = parseSelectedDayTime(settings.selected_day_time || DEFAULT_DAY_TIME);
  return parsed?.weekday || DEFAULT_GAME_DAY;
}
function dynamicGoalieKeysForDay(dayName) {
  const day = String(dayName || '').trim();
  if (day === 'Friday') return ['craig', 'hao'];
  if (day === 'Sunday') return ['craig', 'mat'];
  return ['craig', 'hao'];
}

async function query(text, params=[]) { return pool.query(text, params); }

async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    rating INTEGER DEFAULT 5,
    payment_method TEXT DEFAULT 'Cash',
    paid_amount NUMERIC(10,2) DEFAULT 0,
    is_goalie BOOLEAN DEFAULT FALSE,
    is_protected BOOLEAN DEFAULT FALSE,
    is_auto_added BOOLEAN DEFAULT FALSE,
    auto_group TEXT DEFAULT NULL,
    note TEXT DEFAULT NULL,
    position TEXT DEFAULT 'Player',
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    rating INTEGER DEFAULT 5,
    payment_method TEXT DEFAULT 'Cash',
    is_goalie BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    active BOOLEAN DEFAULT TRUE
  )`);
  await query(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY,
    require_code BOOLEAN DEFAULT TRUE,
    signup_code TEXT DEFAULT '${DEFAULT_CODE}',
    custom_title TEXT DEFAULT 'Phan\'s Hockey',
    selected_day_time TEXT DEFAULT '${DEFAULT_DAY_TIME}',
    game_day_name TEXT DEFAULT '${DEFAULT_GAME_DAY}',
    game_date TEXT DEFAULT NULL,
    selected_arena TEXT DEFAULT '${DEFAULT_ARENA}',
    maintenance_mode BOOLEAN DEFAULT FALSE,
    announcement_enabled BOOLEAN DEFAULT FALSE,
    announcement_text TEXT DEFAULT '',
    announcement_images JSONB DEFAULT '[]'::jsonb,
    roster_released BOOLEAN DEFAULT FALSE,
    roster JSONB DEFAULT '{}'::jsonb,
    roster_release_at TIMESTAMPTZ DEFAULT NULL,
    signup_lock_enabled BOOLEAN DEFAULT FALSE,
    signup_lock_start_at TIMESTAMPTZ DEFAULT NULL,
    signup_lock_end_at TIMESTAMPTZ DEFAULT NULL,
    roster_release_enabled BOOLEAN DEFAULT FALSE,
    reset_week_enabled BOOLEAN DEFAULT FALSE,
    reset_week_at TIMESTAMPTZ DEFAULT NULL,
    manual_override BOOLEAN DEFAULT FALSE,
    current_location TEXT DEFAULT '${DEFAULT_ARENA}',
    current_time TEXT DEFAULT '${DEFAULT_DAY_TIME}',
    player_spots INTEGER DEFAULT 20,
    last_reset_at TIMESTAMPTZ DEFAULT NULL,
    open_spots_notice TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS roster_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    year INTEGER NOT NULL,
    week_number INTEGER NOT NULL,
    created TIMESTAMPTZ DEFAULT NOW(),
    release_date TIMESTAMPTZ DEFAULT NOW(),
    game_date TEXT,
    formatted_date TEXT,
    game_location TEXT,
    game_time TEXT,
    white_team JSONB DEFAULT '[]'::jsonb,
    dark_team JSONB DEFAULT '[]'::jsonb
  )`);
  await query(`CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    remember BOOLEAN DEFAULT FALSE,
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_ip TEXT DEFAULT NULL,
    is_revoked BOOLEAN DEFAULT FALSE
  )`);
  await query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    at TIMESTAMPTZ DEFAULT NOW(),
    ip TEXT DEFAULT NULL,
    meta JSONB DEFAULT '{}'::jsonb
  )`);
  await query(`CREATE TABLE IF NOT EXISTS payment_report_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    file_name TEXT NOT NULL,
    csv_text TEXT NOT NULL
  )`);

  await query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS players_phone_active_idx ON players ((regexp_replace(phone, '\\D','','g'))) WHERE active = TRUE`);
  await query(`CREATE INDEX IF NOT EXISTS waitlist_created_idx ON waitlist (created_at ASC)`);
}

async function getSettings() {
  const { rows } = await query(`SELECT * FROM settings WHERE id = 1 LIMIT 1`);
  const s = rows[0] || {};
  s.announcement_images = Array.isArray(s.announcement_images) ? s.announcement_images : (s.announcement_images || []);
  return s;
}

async function patchSettings(patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return getSettings();
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const values = keys.map(k => patch[k]);
  values.push(1);
  await query(`UPDATE settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);
  return getSettings();
}

async function logAdmin(action, req, meta = {}) {
  try {
    await query(`INSERT INTO admin_audit_log (action, ip, meta) VALUES ($1, $2, $3::jsonb)`, [action, req.ip || null, JSON.stringify(meta)]);
  } catch (e) {
    console.error('Audit log error', e.message);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const token = req.headers['x-admin-auth'] || req.body.sessionToken || req.query.sessionToken;
    if (!token) return res.status(401).json({ error: 'Admin session required.' });
    const { rows } = await query(`SELECT * FROM admin_sessions WHERE token = $1 AND is_revoked = FALSE LIMIT 1`, [token]);
    const session = rows[0];
    if (!session) return res.status(401).json({ error: 'Invalid session.' });
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await query(`UPDATE admin_sessions SET is_revoked = TRUE WHERE token = $1`, [token]);
      return res.status(401).json({ error: 'Session expired.' });
    }
    req.adminSession = session;
    req.adminToken = token;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Session check failed.' });
  }
}

function playerToPublicRow(p) {
  return {
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    fullName: `${p.first_name} ${p.last_name}`.trim(),
    phone: p.phone,
    rating: Number(p.rating) || 0,
    paymentMethod: p.payment_method,
    paidAmount: Number(p.paid_amount || 0),
    isGoalie: !!p.is_goalie,
    isProtected: !!p.is_protected,
    isAutoAdded: !!p.is_auto_added,
    note: p.note || '',
    position: p.position || (p.is_goalie ? 'Goalie' : 'Player')
  };
}

async function getActivePlayers() {
  const { rows } = await query(`SELECT * FROM players WHERE active = TRUE ORDER BY created_at ASC`);
  return rows;
}
async function getActiveWaitlist() {
  const { rows } = await query(`SELECT * FROM waitlist WHERE active = TRUE ORDER BY created_at ASC`);
  return rows;
}

function sortPlayersForDisplay(players) {
  const goalies = players.filter(isGoaliePlayer).sort((a, b) => ratingOf(b) - ratingOf(a));
  const phan = players.filter(isPhanPlayer);
  const others = players.filter(p => !isGoaliePlayer(p) && !isPhanPlayer(p)).sort((a, b) => ratingOf(b) - ratingOf(a));
  return [...goalies, ...phan, ...others];
}

async function ensureDynamicGoalies(settings) {
  const gameDay = gameDayFromSettings(settings);
  const desired = dynamicGoalieKeysForDay(gameDay).map(k => REGULAR_GOALIES[k]);
  const players = await getActivePlayers();
  const activeGoalies = players.filter(isGoaliePlayer);
  const activeDigits = new Set(activeGoalies.map(p => digitsOnly(p.phone)));

  for (const g of desired) {
    if (!activeDigits.has(digitsOnly(g.phone))) {
      await query(`INSERT INTO players
        (first_name, last_name, phone, rating, payment_method, paid_amount, is_goalie, is_protected, is_auto_added, auto_group, note, position, active)
        VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,TRUE,'dynamic_goalie',$7,'Goalie',TRUE)`,
        [g.firstName, g.lastName, g.phone, g.rating, g.paymentMethod, g.paidAmount, `Auto-added for ${gameDay} game`]);
    }
  }

  // Remove the regular goalie that does not belong to the selected day if it is an auto-added dynamic goalie.
  const wantedDigits = new Set(desired.map(g => digitsOnly(g.phone)));
  for (const goalie of activeGoalies) {
    const dg = digitsOnly(goalie.phone);
    if (goalie.is_auto_added && goalie.auto_group === 'dynamic_goalie' && !wantedDigits.has(dg)) {
      await query(`UPDATE players SET active = FALSE, updated_at = NOW() WHERE id = $1`, [goalie.id]);
    }
  }
}

function eliteBalance(players) {
  const goalies = players.filter(isGoaliePlayer).sort((a, b) => ratingOf(b) - ratingOf(a));
  const phan = players.filter(isPhanPlayer);
  const skaters = players.filter(p => !isGoaliePlayer(p) && !isPhanPlayer(p)).sort((a, b) => ratingOf(b) - ratingOf(a));
  const white = [];
  const dark = [];

  if (goalies[0]) white.push(goalies[0]);
  if (goalies[1]) dark.push(goalies[1]);

  if (phan[0]) {
    if (sumRatings(white) <= sumRatings(dark)) white.push(phan[0]);
    else dark.push(phan[0]);
  }

  for (const p of skaters) {
    if (white.length <= dark.length) white.push(p);
    else if (dark.length < white.length) dark.push(p);
    else if (sumRatings(white) <= sumRatings(dark)) white.push(p);
    else dark.push(p);
  }

  const sortTeam = (team) => [
    ...team.filter(isGoaliePlayer),
    ...team.filter(isPhanPlayer),
    ...team.filter(p => !isGoaliePlayer(p) && !isPhanPlayer(p)).sort((a, b) => ratingOf(b) - ratingOf(a))
  ];

  return {
    whiteTeam: sortTeam(white).map(playerToPublicRow),
    darkTeam: sortTeam(dark).map(playerToPublicRow),
    whiteAvg: white.length ? (sumRatings(white) / white.length).toFixed(2) : '0.00',
    darkAvg: dark.length ? (sumRatings(dark) / dark.length).toFixed(2) : '0.00'
  };
}

async function savePaymentReportSnapshot(label = 'auto') {
  const players = (await getActivePlayers()).map(playerToPublicRow);
  const headers = ['First Name','Last Name','Phone','Rating','Payment Method','Paid Amount','Goalie','Protected'];
  const lines = [headers.join(',')];
  for (const p of players) {
    lines.push([
      p.firstName, p.lastName, p.phone, p.rating, p.paymentMethod, Number(p.paidAmount || 0).toFixed(2), p.isGoalie ? 'Yes' : 'No', p.isProtected ? 'Yes' : 'No'
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }
  const csv = lines.join('\n');
  const fileName = `payment-report-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  await query(`INSERT INTO payment_report_snapshots (file_name, csv_text) VALUES ($1,$2)`, [fileName, csv]);
}

async function promoteWaitlistIfNeeded() {
  const settings = await getSettings();
  const players = await getActivePlayers();
  const waitlist = await getActiveWaitlist();
  const skaters = players.filter(p => !isGoaliePlayer(p));
  if (!waitlist.length) return;
  if (skaters.length >= Number(settings.player_spots || 20)) return;
  const next = waitlist[0];
  await query(`INSERT INTO players (first_name,last_name,phone,rating,payment_method,paid_amount,is_goalie,position,active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)`, [next.first_name, next.last_name, next.phone, next.rating, next.payment_method, 0, !!next.is_goalie, next.is_goalie ? 'Goalie' : 'Player']);
  await query(`UPDATE waitlist SET active = FALSE WHERE id = $1`, [next.id]);
}

async function performWeeklyReset(source = 'manual') {
  await savePaymentReportSnapshot(source);
  await query(`UPDATE players SET active = FALSE WHERE active = TRUE AND (is_auto_added = FALSE OR is_auto_added = TRUE)`);
  await query(`UPDATE waitlist SET active = FALSE WHERE active = TRUE`);
  await patchSettings({ roster_released: false, roster: {}, last_reset_at: nowIso(), manual_override: false });
  const settings = await getSettings();
  await ensureDynamicGoalies(settings);
}

async function releaseRosterInternal(reqMeta = null) {
  const settings = await getSettings();
  await ensureDynamicGoalies(settings);
  const players = sortPlayersForDisplay(await getActivePlayers());
  const roster = eliteBalance(players);
  const enriched = {
    released: true,
    date: settings.game_date || '',
    formattedDate: settings.game_date || '',
    location: settings.selected_arena || settings.current_location || DEFAULT_ARENA,
    time: settings.selected_day_time || settings.current_time || DEFAULT_DAY_TIME,
    whiteTeam: roster.whiteTeam,
    darkTeam: roster.darkTeam,
    whiteAvg: roster.whiteAvg,
    darkAvg: roster.darkAvg,
    releasedAt: nowIso()
  };
  await patchSettings({ roster_released: true, roster: enriched });

  const today = new Date();
  const week = isoWeek(today);
  await query(`INSERT INTO roster_history (year, week_number, release_date, game_date, formatted_date, game_location, game_time, white_team, dark_team)
    VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [week.year, week.week, settings.game_date || '', settings.game_date || '', settings.selected_arena || DEFAULT_ARENA, settings.selected_day_time || DEFAULT_DAY_TIME, JSON.stringify(enriched.whiteTeam), JSON.stringify(enriched.darkTeam)]);

  if (reqMeta?.req) await logAdmin('release_roster', reqMeta.req, { gameDay: gameDayFromSettings(settings) });
  return enriched;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function rosterReleaseHeadline(status) {
  const gameDay = status.gameDayName || DEFAULT_GAME_DAY;
  if (!status.rosterReleaseAt) return `📅 Check Back ${gameDay} • Roster Release TBD`;
  const dt = new Date(status.rosterReleaseAt);
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_ZONE,
    weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(dt).replace(' at ', ' • ');
  return `📅 Check Back ${label} ET`;
}

async function buildStatus() {
  const settings = await getSettings();
  await ensureDynamicGoalies(settings);
  const allPlayers = sortPlayersForDisplay(await getActivePlayers());
  const waitlist = await getActiveWaitlist();
  const skaters = allPlayers.filter(p => !isGoaliePlayer(p));
  const spots = Math.max(0, Number(settings.player_spots || 20) - skaters.length);
  const now = Date.now();
  const start = settings.signup_lock_start_at ? new Date(settings.signup_lock_start_at).getTime() : null;
  const end = settings.signup_lock_end_at ? new Date(settings.signup_lock_end_at).getTime() : null;
  const isLockedWindow = !!(settings.signup_lock_enabled && start && end && now >= start && now < end);
  const requireCode = settings.manual_override ? !!settings.require_code : !!(settings.require_code || isLockedWindow);
  const openLine = end ? `✅ Signup opens ${new Intl.DateTimeFormat('en-US',{ timeZone: ET_ZONE, weekday:'long', hour:'numeric', minute:'2-digit', hour12:true }).format(new Date(end))} ET` : '✅ Signup opens to all players at the scheduled unlock time';
  const rosterReleaseLine = settings.roster_release_at ? `Roster release: ${new Intl.DateTimeFormat('en-US',{ timeZone: ET_ZONE, weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true }).format(new Date(settings.roster_release_at))} ET` : 'Roster release time to be announced';
  return {
    customTitle: settings.custom_title || "Phan's Hockey",
    selectedArena: settings.selected_arena || DEFAULT_ARENA,
    location: settings.selected_arena || DEFAULT_ARENA,
    currentLocation: settings.selected_arena || DEFAULT_ARENA,
    gameDate: settings.game_date || '',
    currentDate: settings.game_date || '',
    time: settings.selected_day_time || DEFAULT_DAY_TIME,
    currentTime: settings.selected_day_time || DEFAULT_DAY_TIME,
    gameDayName: gameDayFromSettings(settings),
    maintenanceMode: !!settings.maintenance_mode,
    announcementEnabled: !!settings.announcement_enabled,
    announcementText: settings.announcement_text || '',
    announcementImages: Array.isArray(settings.announcement_images) ? settings.announcement_images : [],
    playerSpots: Number(settings.player_spots || 20),
    playerSpotsAvailable: spots,
    isFull: spots <= 0,
    rosterReleased: !!settings.roster_released,
    rosterReleaseAt: settings.roster_release_at,
    rosterReleaseAtIso: settings.roster_release_at,
    rosterReleaseLine,
    rosterReleaseMessage: rosterReleaseHeadline({ rosterReleaseAt: settings.roster_release_at, gameDayName: gameDayFromSettings(settings) }),
    rosterReleaseHeadline: rosterReleaseHeadline({ rosterReleaseAt: settings.roster_release_at, gameDayName: gameDayFromSettings(settings) }),
    players: allPlayers.map(playerToPublicRow),
    waitlist: waitlist.map((p, i) => ({ ...playerToPublicRow(p), position: i + 1, canCancel: true })),
    requireCode,
    signupLocked: requireCode,
    isLockedWindow,
    openLine,
    noCodeLine: 'No code required after signup opens to all players.',
    lockWindowShort: settings.signup_lock_start_at && settings.signup_lock_end_at ? 'scheduled window' : '',
    gameDateFormatted: settings.game_date || '',
    backupGoalies: [
      { firstName:'Mat', lastName:'Carriere', phone:'(226) 350-0217', rating:7 },
      { firstName:'Jesse', lastName:'Laframboise', phone:'(519) 566-6711', rating:7 },
      { firstName:'Kent', lastName:'Nelson', phone:'(250) 884-6609', rating:7 }
    ]
  };
}

app.get('/health', (req, res) => res.send('OK'));
app.get('/api/health', (req, res) => res.send('OK'));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/history', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'history.html')));
app.get('/roster', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'roster.html')));
app.get('/rules', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'rules.html')));
app.get('/waitlist', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'waitlist.html')));

app.get('/api/status', async (req, res) => {
  try { res.json(await buildStatus()); } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load status.' }); }
});
app.get('/api/public', async (req, res) => {
  try { res.json(await buildStatus()); } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load public snapshot.' }); }
});
app.get('/api/waitlist', async (req, res) => {
  try {
    const status = await buildStatus();
    res.json({
      totalWaitlist: status.waitlist.length,
      waitlist: status.waitlist,
      rosterReleased: status.rosterReleased,
      location: status.location,
      time: status.time,
      date: status.gameDate,
      formattedDate: status.gameDate
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load waitlist.' }); }
});
app.get('/api/history', async (req, res) => {
  try {
    const { rows } = await query(`SELECT year, week_number AS "weekNumber", created FROM roster_history ORDER BY created DESC`);
    res.json({ history: rows });
  } catch (e) { console.error(e); res.json({ history: [] }); }
});
app.get('/api/history/:year/:week', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM roster_history WHERE year = $1 AND week_number = $2 ORDER BY created DESC LIMIT 1`, [Number(req.params.year), Number(req.params.week)]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'History not found.' });
    res.json({
      year: row.year,
      weekNumber: row.week_number,
      releaseDate: row.release_date,
      gameLocation: row.game_location,
      gameTime: row.game_time,
      whiteTeam: row.white_team || [],
      darkTeam: row.dark_team || []
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load history.' }); }
});
app.get('/api/roster', async (req, res) => {
  try {
    const settings = await getSettings();
    const roster = settings.roster || {};
    if (!settings.roster_released || !roster.whiteTeam) {
      return res.json({
        released: false,
        location: settings.selected_arena || DEFAULT_ARENA,
        time: settings.selected_day_time || DEFAULT_DAY_TIME,
        date: settings.game_date || '',
        formattedDate: settings.game_date || ''
      });
    }
    res.json(roster);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load roster.' }); }
});

app.post('/api/verify-code', async (req, res) => {
  try {
    const settings = await getSettings();
    const code = String(req.body.code || '');
    const status = await buildStatus();
    if (!status.requireCode) return res.json({ success: true, open: true });
    if (code === String(settings.signup_code || DEFAULT_CODE)) return res.json({ success: true });
    return res.status(400).json({ error: 'Invalid code' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Code check failed.' }); }
});

app.post('/api/register-init', async (req, res) => {
  try {
    const status = await buildStatus();
    if (status.maintenanceMode) return res.status(400).json({ error: 'Portal is in maintenance mode.' });
    const firstName = capitalizeFullName(req.body.firstName);
    const lastName = capitalizeFullName(req.body.lastName);
    const phone = formatPhone(req.body.phone);
    const rating = Math.max(1, Math.min(10, Number(req.body.rating) || 1));
    const paymentMethod = String(req.body.paymentMethod || 'Cash');
    const signupCode = String(req.body.signupCode || '');
    if (!firstName || !lastName) return res.status(400).json({ error: 'Name is required.' });
    if (digitsOnly(phone).length !== 10) return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
    const activePhone = digitsOnly(phone);
    const existingPlayer = await query(`SELECT id FROM players WHERE active = TRUE AND regexp_replace(phone, '\\D','','g') = $1 LIMIT 1`, [activePhone]);
    if (existingPlayer.rowCount) return res.status(400).json({ error: 'This phone number is already registered.' });
    const existingWaitlist = await query(`SELECT id FROM waitlist WHERE active = TRUE AND regexp_replace(phone, '\\D','','g') = $1 LIMIT 1`, [activePhone]);
    if (existingWaitlist.rowCount) return res.status(400).json({ error: 'This phone number is already on the waitlist.' });
    if (status.requireCode) {
      const settings = await getSettings();
      if (signupCode !== String(settings.signup_code || DEFAULT_CODE)) return res.status(400).json({ error: 'Invalid signup code.' });
    }
    if (status.isFull) {
      const inserted = await query(`INSERT INTO waitlist (first_name,last_name,phone,rating,payment_method,is_goalie,active) VALUES ($1,$2,$3,$4,$5,FALSE,TRUE) RETURNING id`, [firstName, lastName, phone, rating, paymentMethod]);
      const waitlist = await getActiveWaitlist();
      const pos = waitlist.findIndex(w => w.id === inserted.rows[0].id) + 1;
      return res.json({ success: true, inWaitlist: true, waitlistPosition: pos });
    }
    return res.json({
      success: true,
      proceedToRules: true,
      tempData: { firstName, lastName, phone, rating, paymentMethod, isGoalie: false }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to continue signup.' }); }
});

app.post('/api/register-final', async (req, res) => {
  try {
    const temp = req.body.tempData || {};
    if (!req.body.rulesAgreed) return res.status(400).json({ error: 'Rules must be accepted.' });
    const firstName = capitalizeFullName(temp.firstName);
    const lastName = capitalizeFullName(temp.lastName);
    const phone = formatPhone(temp.phone);
    const rating = Math.max(1, Math.min(10, Number(temp.rating) || 1));
    const paymentMethod = String(temp.paymentMethod || 'Cash');
    await query(`INSERT INTO players (first_name,last_name,phone,rating,payment_method,paid_amount,is_goalie,position,active)
      VALUES ($1,$2,$3,$4,$5,$6,FALSE,'Player',TRUE)`, [firstName, lastName, phone, rating, paymentMethod, 0]);
    res.json({ success: true, isGoalie: false });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Registration failed.' }); }
});

app.post('/api/cancel-registration', async (req, res) => {
  try {
    const playerId = req.body.playerId;
    const phoneDigits = digitsOnly(req.body.phone);
    if (phoneDigits.length !== 10) return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
    const p = await query(`SELECT * FROM players WHERE id = $1 AND active = TRUE LIMIT 1`, [playerId]);
    if (p.rowCount) {
      if (digitsOnly(p.rows[0].phone) !== phoneDigits) return res.status(400).json({ error: 'Phone number does not match.' });
      await query(`UPDATE players SET active = FALSE WHERE id = $1`, [playerId]);
      await promoteWaitlistIfNeeded();
      return res.json({ success: true });
    }
    const w = await query(`SELECT * FROM waitlist WHERE id = $1 AND active = TRUE LIMIT 1`, [playerId]);
    if (w.rowCount) {
      if (digitsOnly(w.rows[0].phone) !== phoneDigits) return res.status(400).json({ error: 'Phone number does not match.' });
      await query(`UPDATE waitlist SET active = FALSE WHERE id = $1`, [playerId]);
      return res.json({ success: true });
    }
    return res.status(404).json({ error: 'Registration not found.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Cancellation failed.' }); }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const password = String(req.body.password || '');
    const rememberMe = !!req.body.rememberMe;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Wrong Password' });
    const token = makeToken();
    const issued = new Date();
    const expires = new Date(Date.now() + (rememberMe ? REMEMBER_SESSION_TTL_MS : ADMIN_SESSION_TTL_MS));
    await query(`INSERT INTO admin_sessions (token, remember, issued_at, expires_at, created_ip, is_revoked) VALUES ($1,$2,$3,$4,$5,FALSE)`, [token, rememberMe, issued, expires, req.ip || null]);
    await logAdmin('login', req, { rememberMe });
    res.json({ success: true, sessionToken: token, remember: rememberMe });
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: 'Login failed.' }); }
});
app.post('/api/admin/check-session', async (req, res) => {
  const token = req.headers['x-admin-auth'] || req.body.sessionToken;
  if (!token) return res.json({ loggedIn: false });
  const { rows } = await query(`SELECT * FROM admin_sessions WHERE token = $1 AND is_revoked = FALSE LIMIT 1`, [token]);
  const session = rows[0];
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return res.json({ loggedIn: false });
  res.json({ loggedIn: true });
});
app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  await query(`UPDATE admin_sessions SET is_revoked = TRUE WHERE token = $1`, [req.adminToken]);
  await logAdmin('logout', req, {});
  res.json({ success: true });
});
app.post('/api/admin/logout-all', requireAdmin, async (req, res) => {
  await query(`UPDATE admin_sessions SET is_revoked = TRUE WHERE token <> $1`, [req.adminToken]);
  await logAdmin('logout_all', req, {});
  res.json({ success: true, message: 'Other devices logged out.' });
});
app.get('/api/admin/session-info', requireAdmin, async (req, res) => {
  res.json({ remember: !!req.adminSession.remember, issuedAt: req.adminSession.issued_at, expiresAt: req.adminSession.expires_at });
});
app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
  const { rows } = await query(`SELECT * FROM admin_audit_log ORDER BY at DESC LIMIT $1`, [limit]);
  res.json({ entries: rows });
});

app.post('/api/admin/app-settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      maintenanceMode: !!settings.maintenance_mode,
      customTitle: settings.custom_title,
      selectedDayTime: settings.selected_day_time,
      gameDate: settings.game_date,
      selectedArena: settings.selected_arena,
      backupGoalies: [
        { firstName:'Mat', lastName:'Carriere', phone:'(226) 350-0217', rating:7 },
        { firstName:'Jesse', lastName:'Laframboise', phone:'(519) 566-6711', rating:7 },
        { firstName:'Kent', lastName:'Nelson', phone:'(250) 884-6609', rating:7 }
      ],
      announcementEnabled: !!settings.announcement_enabled,
      announcementText: settings.announcement_text || '',
      announcementImages: Array.isArray(settings.announcement_images) ? settings.announcement_images : []
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load app settings.' }); }
});

app.post('/api/admin/update-app-settings', requireAdmin, async (req, res) => {
  try {
    const patch = {};
    if ('maintenanceMode' in req.body) patch.maintenance_mode = !!req.body.maintenanceMode;
    if ('announcementEnabled' in req.body) patch.announcement_enabled = !!req.body.announcementEnabled;
    if ('announcementText' in req.body) patch.announcement_text = String(req.body.announcementText || '');
    if ('announcementImages' in req.body) patch.announcement_images = JSON.stringify(Array.isArray(req.body.announcementImages) ? req.body.announcementImages : []);
    if ('selectedArena' in req.body) {
      patch.selected_arena = String(req.body.selectedArena || DEFAULT_ARENA);
      patch.current_location = patch.selected_arena;
    }
    if ('customTitle' in req.body) patch.custom_title = String(req.body.customTitle || "Phan's Hockey");
    if ('selectedDayTime' in req.body) {
      patch.selected_day_time = String(req.body.selectedDayTime || DEFAULT_DAY_TIME);
      patch.current_time = patch.selected_day_time;
      const parsed = parseSelectedDayTime(patch.selected_day_time);
      if (parsed) patch.game_day_name = parsed.weekday;
    }
    if ('gameDate' in req.body) {
      patch.game_date = String(req.body.gameDate || '');
      if (patch.game_date) patch.game_day_name = weekdayNameFromDatePart(patch.game_date);
    }
    const settings = await patchSettings(patch);
    await ensureDynamicGoalies(settings);
    await logAdmin('update_app_settings', req, patch);
    res.json({ success: true, settings });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to update app settings.' }); }
});

app.get('/api/admin/data', requireAdmin, async (req, res) => {
  try {
    const players = sortPlayersForDisplay(await getActivePlayers()).map(playerToPublicRow);
    const waitlist = (await getActiveWaitlist()).map((w, i) => ({ ...playerToPublicRow(w), position: i + 1 }));
    const totalPaid = players.reduce((s, p) => s + Number(p.paidAmount || 0), 0);
    res.json({ players, waitlist, totalPaid, goalieCount: players.filter(p => p.isGoalie).length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load admin data.' }); }
});

app.post('/api/admin/update-schedules', requireAdmin, async (req, res) => {
  try {
    const settings = await patchSettings({
      signup_lock_enabled: !!req.body.signupLockEnabled,
      signup_lock_start_at: req.body.signupLockStart || null,
      signup_lock_end_at: req.body.signupLockEnd || null,
      roster_release_enabled: !!req.body.rosterReleaseEnabled,
      roster_release_at: req.body.rosterReleaseAt || null,
      reset_week_enabled: !!req.body.resetWeekEnabled,
      reset_week_at: req.body.resetWeekAt || null
    });
    await logAdmin('update_schedules', req, req.body);
    res.json({
      signupLockSchedule: { enabled: !!settings.signup_lock_enabled },
      signupLockStartAt: settings.signup_lock_start_at,
      signupLockEndAt: settings.signup_lock_end_at,
      rosterReleaseSchedule: { enabled: !!settings.roster_release_enabled },
      rosterReleaseAt: settings.roster_release_at,
      resetWeekSchedule: { enabled: !!settings.reset_week_enabled },
      resetWeekAt: settings.reset_week_at
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to save schedules.' }); }
});
app.post('/api/admin/update-code', requireAdmin, async (req, res) => {
  const newCode = String(req.body.newCode || '').trim();
  if (!/^\d{4}$/.test(newCode)) return res.status(400).json({ error: 'Please enter a valid 4-digit code.' });
  await patchSettings({ signup_code: newCode, require_code: true, manual_override: true });
  await logAdmin('update_code', req, { newCode });
  res.json({ code: newCode });
});
app.post('/api/admin/toggle-code', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  const nextRequire = !settings.require_code;
  const next = await patchSettings({ require_code: nextRequire, manual_override: true });
  await logAdmin('toggle_code', req, { requireCode: nextRequire });
  res.json({ requireCode: !!next.require_code, code: next.signup_code });
});
app.post('/api/admin/reset-schedule', requireAdmin, async (req, res) => {
  const s = await patchSettings({ manual_override: false });
  await logAdmin('reset_schedule', req, {});
  res.json({ success: true, requireCode: !!s.require_code });
});
app.post('/api/admin/update-player-spots', requireAdmin, async (req, res) => {
  const spots = Math.max(0, Math.min(40, Number(req.body.playerSpots) || 20));
  await patchSettings({ player_spots: spots });
  await logAdmin('update_player_spots', req, { spots });
  res.json({ success: true, playerSpots: spots });
});
app.post('/api/admin/add-player', requireAdmin, async (req, res) => {
  try {
    const firstName = capitalizeFullName(req.body.firstName);
    const lastName = capitalizeFullName(req.body.lastName);
    const phone = formatPhone(req.body.phone);
    const rating = Math.max(1, Math.min(10, Number(req.body.rating) || 1));
    const paymentMethod = String(req.body.paymentMethod || 'Cash');
    const isGoalie = !!req.body.isGoalie;
    const toWaitlist = !!req.body.toWaitlist;
    if (!firstName || !lastName || digitsOnly(phone).length !== 10) return res.status(400).json({ error: 'Please fill required fields.' });
    const table = toWaitlist ? 'waitlist' : 'players';
    const sql = toWaitlist
      ? `INSERT INTO waitlist (first_name,last_name,phone,rating,payment_method,is_goalie,active) VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`
      : `INSERT INTO players (first_name,last_name,phone,rating,payment_method,paid_amount,is_goalie,is_protected,is_auto_added,note,position,active) VALUES ($1,$2,$3,$4,$5,0,$6,FALSE,FALSE,NULL,$7,TRUE) RETURNING *`;
    const params = toWaitlist ? [firstName,lastName,phone,rating,paymentMethod,isGoalie] : [firstName,lastName,phone,rating,paymentMethod,isGoalie,isGoalie ? 'Goalie' : 'Player'];
    const out = await query(sql, params);
    await logAdmin('add_player', req, { firstName, lastName, toWaitlist, isGoalie });
    res.json({ success: true, player: playerToPublicRow(out.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to add player.' }); }
});
app.post('/api/admin/add-backup-goalie', requireAdmin, async (req, res) => {
  const list = [
    { firstName:'Mat', lastName:'Carriere', phone:'(226) 350-0217', rating:7 },
    { firstName:'Jesse', lastName:'Laframboise', phone:'(519) 566-6711', rating:7 },
    { firstName:'Kent', lastName:'Nelson', phone:'(250) 884-6609', rating:7 }
  ];
  const idx = Number(req.body.goalieIndex);
  const g = list[idx];
  if (!g) return res.status(400).json({ error: 'Invalid backup goalie.' });
  const out = await query(`INSERT INTO players (first_name,last_name,phone,rating,payment_method,paid_amount,is_goalie,is_protected,is_auto_added,note,position,active)
    VALUES ($1,$2,$3,$4,'N/A',0,TRUE,FALSE,FALSE,'Backup goalie substitute','Goalie',TRUE) RETURNING *`, [g.firstName, g.lastName, g.phone, g.rating]);
  await logAdmin('add_backup_goalie', req, { goalie: `${g.firstName} ${g.lastName}` });
  res.json({ success: true, goalie: playerToPublicRow(out.rows[0]) });
});
app.post('/api/admin/remove-player', requireAdmin, async (req, res) => {
  const id = req.body.playerId;
  await query(`UPDATE players SET active = FALSE WHERE id = $1`, [id]);
  await query(`UPDATE waitlist SET active = FALSE WHERE id = $1`, [id]);
  await promoteWaitlistIfNeeded();
  await logAdmin('remove_player', req, { id });
  res.json({ success: true });
});
app.post('/api/admin/release-roster', requireAdmin, async (req, res) => {
  try { res.json(await releaseRosterInternal({ req })); } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to release roster.' }); }
});
app.post('/api/admin/manual-reset', requireAdmin, async (req, res) => {
  try {
    await performWeeklyReset('manual');
    await logAdmin('manual_reset', req, { dynamicGoalies: true });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to reset week.' }); }
});
app.post('/api/admin/update-paid-amount', requireAdmin, async (req, res) => {
  const amount = Number(req.body.paidAmount || 0);
  await query(`UPDATE players SET paid_amount = $2 WHERE id = $1`, [req.body.playerId, amount]);
  await logAdmin('update_paid_amount', req, { playerId: req.body.playerId, amount });
  res.json({ success: true });
});
app.get('/api/admin/payment-report-snapshots', requireAdmin, async (req, res) => {
  const { rows } = await query(`SELECT id, file_name AS "fileName", created_at AS "createdAt" FROM payment_report_snapshots ORDER BY created_at DESC LIMIT 50`);
  res.json({ snapshots: rows });
});
app.get('/api/admin/payment-report-snapshots/:id', requireAdmin, async (req, res) => {
  const { rows } = await query(`SELECT * FROM payment_report_snapshots WHERE id = $1 LIMIT 1`, [req.params.id]);
  const row = rows[0];
  if (!row) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(row.csv_text);
});
app.get('/api/admin/payment-report-latest', requireAdmin, async (req, res) => {
  const { rows } = await query(`SELECT * FROM payment_report_snapshots ORDER BY created_at DESC LIMIT 1`);
  const row = rows[0];
  if (!row) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.send(row.csv_text);
});
app.get('/api/admin/backup', requireAdmin, async (req, res) => {
  const payload = {
    exportedAt: nowIso(),
    settings: await getSettings(),
    players: (await getActivePlayers()).map(playerToPublicRow),
    waitlist: (await getActiveWaitlist()).map(playerToPublicRow)
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hockey-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});
app.post('/api/admin/restore-backup', requireAdmin, async (req, res) => {
  try {
    const backup = req.body || {};
    await performWeeklyReset('restore');
    const settings = backup.settings || {};
    await patchSettings({
      custom_title: settings.custom_title || settings.customTitle || "Phan's Hockey",
      selected_day_time: settings.selected_day_time || settings.selectedDayTime || DEFAULT_DAY_TIME,
      game_day_name: settings.game_day_name || settings.gameDayName || DEFAULT_GAME_DAY,
      game_date: settings.game_date || settings.gameDate || '',
      selected_arena: settings.selected_arena || settings.selectedArena || DEFAULT_ARENA,
      player_spots: Number(settings.player_spots || settings.playerSpots || 20),
      signup_code: settings.signup_code || settings.signupCode || DEFAULT_CODE,
      require_code: !!(settings.require_code ?? settings.requireCode ?? true),
      announcement_enabled: !!(settings.announcement_enabled ?? settings.announcementEnabled),
      announcement_text: settings.announcement_text || settings.announcementText || '',
      announcement_images: JSON.stringify(settings.announcement_images || settings.announcementImages || [])
    });
    for (const p of backup.players || []) {
      await query(`INSERT INTO players (first_name,last_name,phone,rating,payment_method,paid_amount,is_goalie,is_protected,is_auto_added,note,position,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`, [p.firstName,p.lastName,p.phone,p.rating,p.paymentMethod || 'Cash',Number(p.paidAmount || 0),!!p.isGoalie,!!p.isProtected,!!p.isAutoAdded,p.note || null,p.position || (p.isGoalie ? 'Goalie' : 'Player')]);
    }
    for (const w of backup.waitlist || []) {
      await query(`INSERT INTO waitlist (first_name,last_name,phone,rating,payment_method,is_goalie,active)
        VALUES ($1,$2,$3,$4,$5,$6,TRUE)`, [w.firstName,w.lastName,w.phone,w.rating,w.paymentMethod || 'Cash',!!w.isGoalie]);
    }
    await logAdmin('restore_backup', req, { players: (backup.players || []).length, waitlist: (backup.waitlist || []).length });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to restore backup.' }); }
});

async function maybeRunAutoJobs() {
  try {
    const settings = await getSettings();
    const now = Date.now();
    if (settings.reset_week_enabled && settings.reset_week_at && new Date(settings.reset_week_at).getTime() <= now) {
      const lastReset = settings.last_reset_at ? new Date(settings.last_reset_at).getTime() : 0;
      if (now - lastReset > 60 * 1000) await performWeeklyReset('scheduled');
    }
    if (settings.roster_release_enabled && settings.roster_release_at && !settings.roster_released && new Date(settings.roster_release_at).getTime() <= now) {
      await releaseRosterInternal();
    }
  } catch (e) {
    console.error('Auto job error', e);
  }
}

(async () => {
  try {
    await ensureSchema();
    await maybeRunAutoJobs();
    setInterval(maybeRunAutoJobs, 30000);
    app.listen(PORT, () => {
      console.log(`Phan's Hockey merged server running on port ${PORT}`);
    });
  } catch (e) {
    console.error('Server startup failed', e);
    process.exit(1);
  }
})();
