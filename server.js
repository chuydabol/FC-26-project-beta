// server.js
// Pro Clubs league backend: admin login (plain env pw + session), secure manager codes,
// rankings/payouts/wallets, cup bonuses, EA pass-through, and UPCL fixtures.
// Node 18+ (uses global fetch). Works on Render. Persistent JSON in DATA_DIR.

const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// Sessions
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';

// Simple Admin password (plain, from env)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // set to "Chuyacc" on Render

// Optional header token for scripts/tools
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Data dir with fallback (handles Render /data permission issues)
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (e) {
  console.warn('[WARN] Cannot create DATA_DIR at', DATA_DIR, e.code, '- falling back to ./data');
  DATA_DIR = path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Economy (1-month season defaults; override via env)
const PAYOUTS = {
  elite: Number(process.env.PAYOUT_ELITE || 1_100_000),
  mid:   Number(process.env.PAYOUT_MID   ||   900_000),
  bottom:Number(process.env.PAYOUT_BOTTOM||   700_000),
};
const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || 10_000_000);

// Cup bonuses (one-time per season)
const CUP_BONUSES = {
  winner:       6_000_000,
  runner_up:    3_600_000,
  semifinal:    2_000_000,
  quarterfinal: 1_200_000,
  round_of_16:    600_000,
  none:               0,
  participation: 150_000,
};
const CUP_POINTS = { winner:60, runner_up:40, semifinal:25, quarterfinal:15, round_of_16:10, none:0 };

/* =========================
   FILE HELPERS
========================= */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/* =========================
   DATA FILES
========================= */
const rankingsFile  = path.join(DATA_DIR, 'rankings.json');   // { [clubId]: { leaguePos, cup, points, tier } }
const walletsFile   = path.join(DATA_DIR, 'wallets.json');    // { [clubId]: { balance, lastCollectedAt } }
const awardsFile    = path.join(DATA_DIR, 'awards.json');     // { cup: { [season]: { [clubId]: amount } } }
const usersFile     = path.join(DATA_DIR, 'users.json');      // { [userId]: { id, name, role, teamId } }
const clubCodesFile = path.join(DATA_DIR, 'club_codes.json'); // { [clubId]: { hash, rotatedAt, claimedBy? } }
const fixturesFile  = path.join(DATA_DIR, 'fixtures.json');   // { [id]: fixture }

let rankings  = readJson(rankingsFile, {});
let wallets   = readJson(walletsFile, {});
let awards    = readJson(awardsFile, { cup: {} });
let users     = readJson(usersFile, {});
let clubCodes = readJson(clubCodesFile, {});
let fixtures  = readJson(fixturesFile, {});

function writeFixtures(){ writeJson(fixturesFile, fixtures); }

/* =========================
   APP
========================= */
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// Static site
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teams.html')));

/* =========================
   AUTH (Admin + Manager)
========================= */
function isAdminSession(req) { return req.session?.admin === true; }
function requireAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  if (ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN) return next(); // optional
  return res.status(403).json({ error: 'Admin only' });
}
if (!ADMIN_PASSWORD && !ADMIN_TOKEN) {
  console.warn('[WARN] ADMIN_PASSWORD is not set. Admin login will fail until you set it.');
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Bad password' });
  req.session.admin = true;
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { req.session.admin = false; res.json({ ok: true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdminSession(req) }));

function me(req){ return req.session.user || null; }
function requireManagerOfClub(param='clubId'){
  return (req,res,next)=>{
    const u = me(req);
    if (!u || u.role!=='Manager' || u.teamId !== req.params[param]) return res.status(403).json({ error:'Manager of this club only' });
    next();
  };
}

/* =========================
   MANAGER CODES (secure)
========================= */
function genCode(len=8){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:len}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

// Admin: rotate manager code (returns plain code for you to share)
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, async (req, res) => {
  const { clubId } = req.params;
  const code = genCode(8);
  const hash = await bcrypt.hash(code, 10);
  const existing = clubCodes[clubId] || {};
  clubCodes[clubId] = { hash, rotatedAt: Date.now(), claimedBy: existing.claimedBy || null };
  writeJson(clubCodesFile, clubCodes);
  res.json({ ok:true, clubId, code });
});

// (Optional) Admin: reset claimed manager (keeps current code, frees seat)
app.post('/api/clubs/:clubId/manager-code/reset', requireAdmin, (req, res) => {
  const { clubId } = req.params;
  const rec = clubCodes[clubId];
  if (!rec) return res.status(400).json({ error: 'No code set for this club' });
  rec.claimedBy = null; rec.rotatedAt = Date.now();
  writeJson(clubCodesFile, clubCodes);
  res.json({ ok:true });
});

// Claim manager role → creates session user
app.post('/api/clubs/:clubId/claim-manager', async (req, res) => {
  const { clubId } = req.params;
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const rec = clubCodes[clubId];
  if (!rec) return res.status(400).json({ error: 'No manager code set for this club. Ask admin.' });
  const ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error: 'Invalid code' });
  if (rec.claimedBy && users[rec.claimedBy]?.teamId === clubId) {
    return res.status(409).json({ error: 'Club already has a manager. Ask admin to reset or rotate.' });
  }
  const id = uuidv4();
  const user = { id, name: String(name).trim(), role: 'Manager', teamId: clubId };
  users[id] = user; writeJson(usersFile, users);
  clubCodes[clubId].claimedBy = id; writeJson(clubCodesFile, clubCodes);
  req.session.user = user;
  res.json({ ok:true, user });
});

app.get('/api/auth/me', (req,res)=> res.json({ user: me(req) }));
app.post('/api/auth/logout', (req,res)=> req.session.destroy(()=> res.json({ ok:true })));

/* =========================
   RANKINGS / PAYOUTS / WALLETS
========================= */
function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayout(clubId){ const tier=(rankings[clubId]?.tier)||'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }

function ensureWallet(clubId){
  if (!wallets[clubId]) wallets[clubId] = { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86_400_000 };
}
function collectPreview(clubId){
  ensureWallet(clubId);
  const w = wallets[clubId];
  const days = Math.floor((Date.now() - (w.lastCollectedAt || 0)) / 86_400_000);
  const perDay = getDailyPayout(clubId);
  return { days, perDay, amount: Math.max(0, days * perDay) };
}

// Public read
app.get('/api/rankings', (req,res)=>{
  res.json({ rankings, payouts: PAYOUTS, cupPoints: CUP_POINTS });
});

// Admin write
app.put('/api/rankings/:clubId', requireAdmin, (req,res)=>{
  const { clubId } = req.params; const { leaguePos, cup, tier } = req.body || {};
  const r = rankings[clubId] || { leaguePos:'', cup:'none', points:0, tier:'mid' };
  if (leaguePos !== undefined) r.leaguePos = Number(leaguePos||0);
  if (cup       !== undefined) r.cup       = String(cup||'none');
  r.points = leaguePoints(r.leaguePos) + (CUP_POINTS[r.cup] || 0);
  if (tier) r.tier = tier;
  rankings[clubId] = r; writeJson(rankingsFile, rankings);
  res.json({ ok:true, ranking:r, perDay:getDailyPayout(clubId) });
});

app.post('/api/rankings/bulk', requireAdmin, (req,res)=>{
  const payload = req.body?.rankings || {};
  Object.keys(payload).forEach(clubId=>{
    const src = payload[clubId] || {};
    const r = rankings[clubId] || { leaguePos:'', cup:'none', points:0, tier:'mid' };
    if ('leaguePos' in src) r.leaguePos = Number(src.leaguePos||0);
    if ('cup' in src)       r.cup       = String(src.cup||'none');
    if ('tier' in src && src.tier) r.tier = src.tier;
    r.points = leaguePoints(r.leaguePos) + (CUP_POINTS[r.cup] || 0);
    rankings[clubId] = r;
  });
  writeJson(rankingsFile, rankings);
  res.json({ ok:true, rankings });
});

app.post('/api/rankings/recalc', requireAdmin, (req,res)=>{
  Object.keys(rankings).forEach(clubId=>{
    const r = rankings[clubId];
    r.points = leaguePoints(r.leaguePos) + (CUP_POINTS[r.cup] || 0);
    r.tier = tierFromPoints(r.points);
  });
  writeJson(rankingsFile, rankings);
  res.json({ ok:true, rankings });
});

// Wallets
app.get('/api/wallets/:clubId', (req,res)=>{
  const { clubId } = req.params;
  ensureWallet(clubId);
  const w = wallets[clubId];
  const preview = collectPreview(clubId);
  res.json({ wallet:w, preview, perDay:getDailyPayout(clubId) });
});
app.post('/api/wallets/:clubId/collect', requireManagerOfClub('clubId'), (req,res)=>{
  const { clubId } = req.params;
  ensureWallet(clubId);
  const preview = collectPreview(clubId);
  if (preview.days <= 0) return res.json({ ok:false, message:'No payout available yet', preview });
  wallets[clubId].balance += preview.amount;
  wallets[clubId].lastCollectedAt = wallets[clubId].lastCollectedAt + preview.days * 86_400_000;
  writeJson(walletsFile, wallets);
  const updated = { wallet: wallets[clubId], preview: collectPreview(clubId), perDay: getDailyPayout(clubId) };
  res.json({ ok:true, ...updated });
});

/* =========================
   CUP BONUSES (Admin)
========================= */
function seasonKeyFromBody(req){
  const s = (req.body?.season || '').trim();
  if (s) return s; // e.g. "2025-08"
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
app.post('/api/bonuses/cup', requireAdmin, (req,res)=>{
  const season = seasonKeyFromBody(req);
  const dryRun = !!req.body?.dryRun;
  awards.cup[season] = awards.cup[season] || {};
  const already = awards.cup[season];
  const results = [];
  let willAward=0, actually=0;

  Object.keys(rankings).forEach(clubId=>{
    const cup = rankings[clubId]?.cup || 'none';
    const bonus = Number(CUP_BONUSES[cup] || 0);
    const paid = !!already[clubId];
    results.push({ clubId, cup, bonus, alreadyPaid: paid });
    willAward += bonus;
    if (!dryRun && bonus>0 && !paid){
      ensureWallet(clubId);
      wallets[clubId].balance += bonus;
      already[clubId] = bonus;
      actually += bonus;
    }
  });

  if (!dryRun) { writeJson(walletsFile, wallets); writeJson(awardsFile, awards); }
  res.json({ ok:true, season, dryRun, totalAwarded: dryRun ? willAward : actually, results });
});
app.get('/api/bonuses/cup', requireAdmin, (req,res)=>{
  const season = (req.query.season || '').trim() || seasonKeyFromBody({ body:{} });
  res.json({ ok:true, season, paid: awards.cup[season] || {} });
});

/* =========================
   EA PASS-THROUGH (optional)
========================= */
app.get('/api/teams/:clubId/players', async (req,res)=>{
  const { clubId } = req.params;
  if (!/^\d+$/.test(clubId)) return res.json({ members: [] }); // manual teams use string IDs
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0'}, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return res.status(response.status).json({ error:`EA API error: ${response.statusText}` });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'EA API timed out' });
    console.error('EA fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch players from EA API' });
  }
});

/* =========================
   UPCL FIXTURES
========================= */
// Create fixture (Admin)
app.post('/api/cup/fixtures', requireAdmin, (req, res) => {
  const { home, away, round, cup = 'UPCL' } = req.body || {};
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });
  if (home === away)   return res.status(400).json({ error: 'home and away cannot match' });

  const id = uuidv4();
  fixtures[id] = {
    id, cup,
    round: String(round || 'Round'),
    home: String(home), away: String(away),
    status: 'pending',          // pending | scheduled | live | final
    timeLockedAt: null,
    proposals: [],              // [{ at:number, by:string }]
    votes: {},                  // { "<timestamp>": { [clubId]: true|false } }
    when: null,                 // locked time (ms)
    lineups: {                  // set by managers per club
      [home]: { formation:'', lineup:{} },
      [away]: { formation:'', lineup:{} }
    },
    score: { hs:0, as:0 },
    report: { text:'', mvpHome:'', mvpAway:'', discordMsgUrl:'' },
    createdAt: Date.now()
  };
  writeFixtures();
  res.json({ ok:true, fixture: fixtures[id] });
});

// List fixtures (optionally by clubId & cup)
app.get('/api/cup/fixtures', (req, res) => {
  const { clubId, cup = 'UPCL' } = req.query;
  const list = Object.values(fixtures).filter(
    f => f.cup === cup && (!clubId || f.home === clubId || f.away === clubId)
  );
  res.json({ fixtures: list });
});

// Get one
app.get('/api/cup/fixtures/:id', (req, res) => {
  const f = fixtures[req.params.id];
  if (!f) return res.status(404).json({ error: 'not found' });
  res.json({ fixture: f });
});

// Propose time (Manager of either club)
app.post('/api/cup/fixtures/:id/propose', (req, res) => {
  const f = fixtures[req.params.id]; if (!f) return res.status(404).json({ error:'not found' });
  const user = req.session.user;
  if (!user || user.role!=='Manager' || (user.teamId!==f.home && user.teamId!==f.away))
    return res.status(403).json({ error:'Managers of these clubs only' });
  const at = Number(req.body?.at||0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });
  f.proposals.push({ at, by:user.teamId });
  f.votes[String(at)] = f.votes[String(at)] || {};
  writeFixtures();
  res.json({ ok:true, fixture:f });
});

// Vote agree/decline (Manager)
app.post('/api/cup/fixtures/:id/vote', (req, res) => {
  const f = fixtures[req.params.id]; if (!f) return res.status(404).json({ error:'not found' });
  const user = req.session.user;
  if (!user || user.role!=='Manager' || (user.teamId!==f.home && user.teamId!==f.away))
    return res.status(403).json({ error:'Managers of these clubs only' });
  const at = String(req.body?.at||''); const agree = !!req.body?.agree;
  if (!at || !f.votes[at]) return res.status(400).json({ error:'invalid slot' });
  f.votes[at][user.teamId] = agree;
  const bothAgreed = f.votes[at][f.home]===true && f.votes[at][f.away]===true;
  if (bothAgreed) { f.when = Number(at); f.status='scheduled'; f.timeLockedAt=Date.now(); }
  writeFixtures();
  res.json({ ok:true, fixture:f });
});

// Set lineup for this match (Manager)
app.put('/api/cup/fixtures/:id/lineup', (req, res) => {
  const f = fixtures[req.params.id]; if (!f) return res.status(404).json({ error:'not found' });
  const user = req.session.user;
  if (!user || user.role!=='Manager' || (user.teamId!==f.home && user.teamId!==f.away))
    return res.status(403).json({ error:'Managers of these clubs only' });
  const { formation, lineup } = req.body || {};
  f.lineups[user.teamId] = { formation:String(formation||''), lineup: lineup && typeof lineup==='object' ? lineup : {} };
  writeFixtures();
  res.json({ ok:true, fixture:f });
});

// Submit result (either club manager)
app.post('/api/cup/fixtures/:id/report', (req, res) => {
  const f = fixtures[req.params.id]; if (!f) return res.status(404).json({ error:'not found' });
  const user = req.session.user;
  if (!user || user.role!=='Manager' || (user.teamId!==f.home && user.teamId!==f.away))
    return res.status(403).json({ error:'Managers of these clubs only' });
  const { hs, as, text, mvpHome, mvpAway, discordMsgUrl } = req.body || {};
  f.score  = { hs:Number(hs||0), as:Number(as||0) };
  f.report = { text:String(text||''), mvpHome:String(mvpHome||''), mvpAway:String(mvpAway||''), discordMsgUrl:String(discordMsgUrl||'') };
  f.status = 'final';
  writeFixtures();
  res.json({ ok:true, fixture:f });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (env: ${NODE_ENV})`);
  console.log(`Data dir: ${DATA_DIR}`);
});
