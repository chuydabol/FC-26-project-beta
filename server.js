// server.js — Pro Clubs League backend (Firestore)
// Features: Managers, squads, players, fixtures, Champions Cup, rankings & wallets,
//           result ingest (JSON + quick text), dynamic News (finals + hat-tricks),
//           Discord posting (test / snapshot / upcoming / auto), NO EA API.

// -----------------------------
// Imports & optional middleware
// -----------------------------
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { hasDuplicates, uniqueStrings } = require('./utils');
const pool = require('./db');
const eaApi = require('./services/eaApi');

let helmet = null, compression = null, cors = null, morgan = null;
try { helmet = require('helmet'); } catch {}
try { compression = require('compression'); } catch {}
try { cors = require('cors'); } catch {}
try { morgan = require('morgan'); } catch {}

// Node 18+ has global fetch; fallback for older/different envs
const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

// -----------------------------
// Firebase Admin
// -----------------------------
const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required (paste the service account JSON).');
}
const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (svc.private_key && svc.private_key.includes('\\n')) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(svc) });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const FieldPath  = admin.firestore.FieldPath;

// -----------------------------
// Config
// -----------------------------
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const PAYOUTS = {
  elite : Number(process.env.PAYOUT_ELITE  || 1_100_000),
  mid   : Number(process.env.PAYOUT_MID    ||   900_000),
  bottom: Number(process.env.PAYOUT_BOTTOM ||   700_000),
};
const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || 10_000_000);
const MANAGER_SESSION_HOURS = Number(process.env.MANAGER_SESSION_HOURS || 12);

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

// Discord
const DISCORD_WEBHOOK_CC  = process.env.DISCORD_WEBHOOK_CC || '';
const DISCORD_CRON_SECRET = process.env.DISCORD_CRON_SECRET || ''; // for /api/discord/cc/auto

// Default EA club IDs for league-wide player fetches
// Falls back to built-in list if LEAGUE_CLUB_IDS is not provided
const DEFAULT_CLUB_IDS = (process.env.LEAGUE_CLUB_IDS || `
576007,4933507,2491998,1969494,2086022,2462194,5098824,4869810,1527486,
4824736,481847,3050467,4154835,3638105,55408,4819681,35642
`).split(',').map(s => s.trim()).filter(Boolean);

// Tiny concurrency limiter so we don't hammer EA
let _inFlight = 0;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);
const _queue = [];
function limit(fn){
  return new Promise((resolve, reject) => {
    const run = async () => {
      _inFlight++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        _inFlight--;
        const next = _queue.shift();
        if (next) next();
      }
    };
    if (_inFlight < MAX_CONCURRENCY) run();
    else _queue.push(run);
  });
}

// Simple 60s in-memory cache for /api/players
let _playersCache = { at: 0, data: null };
const PLAYERS_TTL_MS = 60_000;

// -----------------------------
// Express app
// -----------------------------
const app = express();
app.set('trust proxy', 1);

if (helmet) app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
if (cors) app.use(cors({ origin: true, credentials: true }));
if (compression) app.use(compression());
app.use(express.json({ limit: '1mb' }));
if (morgan) app.use(morgan(isProd ? 'combined' : 'dev'));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*30 } // 30d
}));

// Static site
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'teams.html')));

// -----------------------------
// Collections & helpers
// -----------------------------
const COL = {
  rankings    : () => db.collection('rankings'),    // docId = clubId
  wallets     : () => db.collection('wallets'),     // docId = clubId
  awards      : () => db.collection('cupAwards'),   // docId = season
  users       : () => db.collection('users'),       // docId = userId (Players too)
  clubCodes   : () => db.collection('clubCodes'),   // docId = clubId { hash, rotatedAt, lastUsedAt? }
  freeAgents  : () => db.collection('freeAgents'),  // docId = userId
  players     : () => db.collection('players'),     // docId = playerId
  clubSquadSlots: (clubId) => db.collection('clubSquads').doc(clubId).collection('slots'),
  playerStats : () => db.collection('playerStats'), // docId = `${season}_${playerId}`
  champions   : () => db.collection('champions'),   // docId = cupId
  friendlies  : () => db.collection('friendlies'),  // docId = friendlyId
  news        : () => db.collection('news'),        // docId = newsId
};

const wrap = fn => (req,res,next)=> Promise.resolve(fn(req,res,next)).catch(next);
async function getDoc(col, id){
  if (col === 'fixtures') {
    const { rows } = await pool.query('SELECT details FROM fixtures WHERE id=$1', [id]);
    return rows[0]?.details || null;
  }
  if (col === 'leagues') {
    const { rows } = await pool.query('SELECT details FROM leagues WHERE id=$1', [id]);
    return rows[0]?.details || null;
  }
  const s = await COL[col]().doc(id).get();
  return s.exists ? s.data() : null;
}
async function setDoc(col, id, obj){
  if (col === 'fixtures') {
    await pool.query(
      `INSERT INTO fixtures (id, home, away, score, status, details, league_id, played_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET home=EXCLUDED.home, away=EXCLUDED.away, score=EXCLUDED.score, status=EXCLUDED.status, details=EXCLUDED.details, league_id=EXCLUDED.league_id, played_at=EXCLUDED.played_at`,
      [id, obj.home, obj.away, obj.score || null, obj.status || null, obj, obj.cup || obj.league_id || null, obj.played_at || null]
    );
    return obj;
  }
  if (col === 'leagues') {
    await pool.query(
      `INSERT INTO leagues (id, details)
       VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET details=EXCLUDED.details`,
      [id, obj]
    );
    return obj;
  }
  await COL[col]().doc(id).set(obj, { merge:false });
  return obj;
}
async function updateDoc(col, id, patch){
  if (col === 'fixtures') {
    const current = await getDoc('fixtures', id) || {};
    const next = { ...current, ...patch };
    await setDoc('fixtures', id, next);
    return;
    }
  if (col === 'leagues') {
    const current = await getDoc('leagues', id) || {};
    const next = { ...current, ...patch };
    await setDoc('leagues', id, next);
    return;
  }
  await COL[col]().doc(id).set(patch, { merge:true });
}
async function listAll(col){
  if (col === 'fixtures') {
    const { rows } = await pool.query('SELECT details FROM fixtures');
    return rows.map(r => r.details);
  }
  if (col === 'leagues') {
    const { rows } = await pool.query('SELECT details FROM leagues');
    return rows.map(r => r.details);
  }
  const snap = await COL[col]().get();
  return snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

async function fixturesByCup(cup) {
  const { rows } = await pool.query('SELECT details FROM fixtures WHERE league_id = $1', [cup]);
  return rows.map(r => r.details);
}

function isAdminSession(req) { return req.session?.admin === true; }
function me(req){ return req.session.user || null; }

function isManagerActive(req){
  const u = me(req);
  if (!u || u.role !== 'Manager') return false;
  return (req.session.managerExpiresAt || 0) > Date.now();
}
function userForClient(req){
  const u = me(req);
  if (!u) return null;
  if (u.role === 'Manager' && !isManagerActive(req)) return null;
  return u;
}

// Middleware
function requireAdmin(req,res,next){
  if (isAdminSession(req)) return next();
  return res.status(403).json({ error:'Admin only' });
}
function requireManagerOfClubParam(param='clubId'){
  return (req,res,next)=>{
    const u = me(req);
    if (!(u && u.role==='Manager' && isManagerActive(req) && String(u.teamId)===String(req.params[param])))
      return res.status(403).json({ error:'Manager of this club only' });
    next();
  };
}
function requireManagerOrAdminOfClubParam(param='clubId'){
  return (req,res,next)=>{
    if (isAdminSession(req)) return next();
    const u = me(req);
    if (!(u && u.role==='Manager' && isManagerActive(req) && String(u.teamId)===String(req.params[param])))
      return res.status(403).json({ error:'Manager of this club or Admin only' });
    next();
  };
}
function requireManagerOrAdmin(req,res,next){
  if (isAdminSession(req)) return next();
  const u = me(req);
  if (u && u.role==='Manager' && isManagerActive(req)) return next();
  return res.status(403).json({ error:'Managers or Admins only' });
}
function managerOwnsFixture(req, f){
  const u = me(req);
  return !!(u && u.role==='Manager' && isManagerActive(req) && [f.home, f.away].includes(u.teamId));
}

// Utils
function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayoutLocal(ranking){ const tier=(ranking?.tier)||'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }
function genCode(len=8){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:len},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
function seasonKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

// -----------------------------
// Auth (Admin + Session user)
// -----------------------------
if (!ADMIN_PASSWORD) console.warn('[WARN] ADMIN_PASSWORD not set — admin login will fail until you set it.');

app.post('/api/admin/login', wrap(async (req,res)=>{
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error:'ADMIN_PASSWORD not set' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(403).json({ error:'Bad password' });
  req.session.admin = true;
  res.json({ ok:true });
}));
app.post('/api/admin/logout', (req,res)=>{ req.session.admin = false; res.json({ ok:true }); });
app.get('/api/admin/me', (req,res)=> res.json({ admin: isAdminSession(req) }));

app.get('/api/auth/me', (req,res)=> res.json({ user: userForClient(req) }));
app.post('/api/auth/logout', (req,res)=> req.session.destroy(()=> res.json({ ok:true })));

// -----------------------------
// Manager Codes (stateless login)
// -----------------------------
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, wrap(async (req,res)=>{
  const { clubId } = req.params;
  const code = genCode(8);
  const hash = await bcrypt.hash(code, 10);
  await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now() });
  res.json({ ok:true, clubId, code });
}));

app.post('/api/admin/manager-codes/rotate-all', requireAdmin, wrap(async (req,res)=>{
  const clubs = Array.isArray(req.body?.clubs) ? req.body.clubs.map(String) : [];
  if (!clubs.length) return res.status(400).json({ error:'body.clubs array required' });
  const items = [];
  for (const clubId of clubs){
    const code = genCode(8);
    const hash = await bcrypt.hash(code, 10);
    await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now() });
    items.push({ clubId, code });
  }
  const csv = 'clubId,code\n' + items.map(x=>`${x.clubId},${x.code}`).join('\n');
  res.json({ ok:true, count: items.length, items, csv });
}));

app.get('/api/admin/manager-codes/export', requireAdmin, wrap(async (_req,res)=>{
  const snap = await COL.clubCodes().get();
  const rows = snap.docs.map(d=>{
    const x = d.data();
    return { clubId:d.id, hasCode: !!x.hash, rotatedAt: x.rotatedAt || 0, lastUsedAt: x.lastUsedAt || 0 };
  });
  const csv = 'clubId,hasCode,rotatedAt,lastUsedAt\n' + rows.map(r=>`${r.clubId},${r.hasCode},${r.rotatedAt},${r.lastUsedAt}`).join('\n');
  res.json({ ok:true, count: rows.length, csv, rows });
}));

app.post('/api/clubs/:clubId/claim-manager', wrap(async (req,res)=>{
  const { clubId } = req.params;
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error:'name and code required' });

  const rec = await getDoc('clubCodes', clubId);
  if (!rec || !rec.hash) return res.status(400).json({ error:'No manager code set. Ask admin.' });

  const ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error:'Invalid code' });

  req.session.user = { id: uuidv4(), name: String(name).trim(), role:'Manager', teamId: String(clubId) };
  req.session.managerExpiresAt = Date.now() + MANAGER_SESSION_HOURS * 60 * 60 * 1000;
  await updateDoc('clubCodes', clubId, { lastUsedAt: Date.now() });

  res.json({ ok:true, user: userForClient(req), expiresAt: req.session.managerExpiresAt });
}));

// -----------------------------
// Players + Free Agents
// -----------------------------
app.post('/api/players/claim', wrap(async (req,res)=>{
  const { name, teamId='' } = req.body || {};
  if (!name) return res.status(400).json({ error:'name required' });
  const id = uuidv4();
  const user = { id, name: String(name).trim(), role:'Player', teamId: String(teamId) };
  await setDoc('users', id, user);
  req.session.user = user;
  res.json({ ok:true, user });
}));

app.get('/api/free-agents', wrap(async (_req,res)=>{
  const snap = await COL.freeAgents().orderBy('listedAt','desc').get();
  res.json({ agents: snap.docs.map(d=>d.data()) });
}));
app.post('/api/free-agents/me', requireManagerOrAdmin, wrap(async (req,res)=>{
  const u = me(req);
  const { positions=[], foot='', region='', bio='', availability='', discord='', lookingFor='' } = req.body || {};
  const doc = {
    id: u.id, name: u.name, role: u.role, teamId: u.teamId || '',
    positions: Array.isArray(positions) ? positions : String(positions).split(',').map(s=>s.trim()).filter(Boolean),
    foot: String(foot||''), region: String(region||''), bio: String(bio||''),
    availability: String(availability||''), discord: String(discord||''), lookingFor: String(lookingFor||''),
    listedAt: Date.now()
  };
  await COL.freeAgents().doc(u.id).set(doc);
  res.json({ ok:true, agent: doc });
}));
app.delete('/api/free-agents/me', requireManagerOrAdmin, wrap(async (req,res)=>{
  const u = me(req);
  await COL.freeAgents().doc(u.id).delete();
  res.json({ ok:true });
}));

// -----------------------------
// Rankings / Wallets
// -----------------------------
app.get('/api/rankings', wrap(async (_req,res)=>{
  const all = await listAll('rankings');
  const map = {};
  for (const r of all) map[r.id] = { leaguePos:r.leaguePos||'', cup:r.cup||'none', points:r.points||0, tier:r.tier||'mid' };
  res.json({ rankings: map, payouts: PAYOUTS, cupPoints: CUP_POINTS });
}));

app.post('/api/rankings/bulk', requireAdmin, wrap(async (req,res)=>{
  const payload = req.body?.rankings || {};
  const ops = [];
  for (const clubId of Object.keys(payload)){
    const src = payload[clubId] || {};
    const leaguePos = Number(src.leaguePos || 0);
    const cup = String(src.cup || 'none');
    let tier = src.tier || 'mid';
    const points = leaguePoints(leaguePos) + (CUP_POINTS[cup] || 0);
    if (!src.tier) tier = tierFromPoints(points);
    ops.push(setDoc('rankings', clubId, { leaguePos, cup, points, tier }));
  }
  await Promise.all(ops);
  res.json({ ok:true });
}));

app.post('/api/rankings/recalc', requireAdmin, wrap(async (_req,res)=>{
  const all = await listAll('rankings');
  await Promise.all(all.map(r=>{
    const points = leaguePoints(r.leaguePos||0) + (CUP_POINTS[r.cup||'none']||0);
    const tier = tierFromPoints(points);
    return setDoc('rankings', r.id, { leaguePos:r.leaguePos||0, cup:r.cup||'none', points, tier });
  }));
  res.json({ ok:true });
}));

async function ensureWallet(clubId){
  const ref = COL.wallets().doc(clubId);
  const snap = await ref.get();
  if (!snap.exists){
    const doc = { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86_400_000 };
    await ref.set(doc);
    return doc;
  }
  return snap.data();
}
async function getRanking(clubId){
  const r = await getDoc('rankings', clubId);
  return r || { leaguePos:'', cup:'none', points:0, tier:'mid' };
}
async function collectPreview(clubId){
  const [w, r] = await Promise.all([ensureWallet(clubId), getRanking(clubId)]);
  const perDay = getDailyPayoutLocal(r);
  const days = Math.floor((Date.now() - (w.lastCollectedAt || 0)) / 86_400_000);
  return { days, perDay, amount: Math.max(0, days * perDay) };
}

app.get('/api/wallets/:clubId', wrap(async (req,res)=>{
  const { clubId } = req.params;
  const [w, preview, r] = await Promise.all([ensureWallet(clubId), collectPreview(clubId), getRanking(clubId)]);
  res.json({ wallet: w, preview, perDay: getDailyPayoutLocal(r) });
}));

app.post('/api/wallets/:clubId/collect', requireManagerOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId } = req.params;
  const result = await db.runTransaction(async (tx)=>{
    const wRef = COL.wallets().doc(clubId);
    const rRef = COL.rankings().doc(clubId);
    const [wSnap, rSnap] = await Promise.all([tx.get(wRef), tx.get(rRef)]);
    const w = wSnap.exists ? wSnap.data() : { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86_400_000 };
    const r = rSnap.exists ? rSnap.data() : { tier:'mid' };
    const perDay = getDailyPayoutLocal(r);
    const now = Date.now();
    const days = Math.floor((now - (w.lastCollectedAt || 0)) / 86_400_000);
    const amount = Math.max(0, days * perDay);
    if (amount <= 0) return { ok:false, message:'No payout available yet' };
    tx.set(wRef, {
      balance: Number(w.balance||0) + amount,
      lastCollectedAt: (w.lastCollectedAt || 0) + days * 86_400_000,
    }, { merge:false });
    return { ok:true, collected: amount };
  });
  const preview = await collectPreview(clubId);
  res.json({ ...result, preview });
}));

// Proxy to fetch club members from EA API (avoids browser CORS)
app.get('/api/ea/clubs/:clubId/members', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(String(clubId))) {
    return res.status(400).json({ error: 'Invalid clubId' });
  }

  try {
    const raw = await limit(() => eaApi.fetchPlayersForClubWithRetry(clubId));
    let members = [];
    if (Array.isArray(raw)) {
      members = raw;
    } else if (Array.isArray(raw?.members)) {
      members = raw.members;
    } else if (raw?.members && typeof raw.members === 'object') {
      members = Object.values(raw.members);
    }
    return res.json({ members });
  } catch (err) {
    const msg = err?.error || err?.message || 'EA API error';
    const status = /abort|timeout|timed out|ETIMEDOUT/i.test(String(msg)) ? 504 : 502;
    return res
      .status(status)
      .json({ error: 'EA API request failed', details: msg });
  }
});


// Aggregate players from league (single call, old behavior)
app.get('/api/players', wrap(async (req, res) => {
  // Allow explicit override (?clubIds=1,2,3), otherwise use default league list
  const q = req.query.clubId || req.query.clubIds || req.query.ids || '';
  let clubIds = Array.isArray(q) ? q : String(q).split(',').map(s => s.trim()).filter(Boolean);
  if (!clubIds.length) clubIds = DEFAULT_CLUB_IDS.slice();

  // serve from short cache if fresh
  if (_playersCache.data && (Date.now() - _playersCache.at) < PLAYERS_TTL_MS) {
    return res.json(_playersCache.data);
  }

  const results = await Promise.all(
    clubIds.map(id =>
      limit(() => eaApi.fetchPlayersForClubWithRetry(id))
        .then(raw => ({ id, raw }))
        .catch(err => {
          console.error('fetchPlayersForClub failed', id, err?.message || err);
          return { id, raw: null };
        })
    )
  );

  const byClub = {};
  const union = [];
  const seen = new Set();

  for (const { id, raw } of results) {
    let members = [];
    if (Array.isArray(raw)) members = raw;
    else if (Array.isArray(raw?.members)) members = raw.members;
    else if (raw?.members && typeof raw.members === 'object') members = Object.values(raw.members);
    byClub[id] = members;

    for (const p of members) {
      const name = p?.name || p?.playername || p?.personaName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      union.push(p);
    }
  }

  const payload = { members: union, byClub };
  _playersCache = { at: Date.now(), data: payload };
  res.set('Cache-Control', 'public, max-age=60');
  return res.json(payload);
}));

// -----------------------------
// Squads (no EA; manual slots only)
// -----------------------------
app.post('/api/clubs/:clubId/squad/bootstrap', requireAdmin, wrap(async (req,res)=>{
  const { clubId } = req.params;
  const size = Math.max(1, Math.min(30, Number(req.body?.size || 15)));
  const batch = db.batch();
  for (let i=1;i<=size;i++){
    const slotId = `S${String(i).padStart(2,'0')}`;
    batch.set(COL.clubSquadSlots(clubId).doc(slotId), { slotId, clubId, label:`Slot ${i}`, playerId:'', createdAt: Date.now() }, { merge:false });
  }
  await batch.commit();
  res.json({ ok:true, created:size });
}));

app.get('/api/clubs/:clubId/squad', wrap(async (req,res)=>{
  const { clubId } = req.params;
  const snap = await COL.clubSquadSlots(clubId).orderBy('slotId').get();
  const slots = snap.docs.map(d=>d.data());
  const ids = Array.from(new Set(slots.map(s=>s.playerId).filter(Boolean)));
  const chunks = [];
  for (let i=0;i<ids.length;i+=10) chunks.push(ids.slice(i, i+10));
  const playersMap = new Map();
  for (const ch of chunks){
    const q = await COL.players().where(FieldPath.documentId(), 'in', ch).get();
    q.docs.forEach(p=> playersMap.set(p.id, p.data()));
  }
  const hydrated = slots.map(s=>({ ...s, player: s.playerId ? (playersMap.get(s.playerId) || null) : null }));
  res.json({ clubId, slots: hydrated });
}));

app.post('/api/clubs/:clubId/squad/slots/:slotId/assign', requireManagerOrAdminOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId, slotId } = req.params;
  let { playerId, eaName='', platform='manual', aliases=[] } = req.body || {};
  if (!playerId && !eaName) return res.status(400).json({ error:'playerId or eaName required' });

  if (!playerId){
    const id = uuidv4();
    const aliasArr = Array.isArray(aliases) ? aliases : String(aliases).split(',').map(s=>s.trim()).filter(Boolean);
    const search = [eaName, ...aliasArr].map(norm);
    await COL.players().doc(id).set({ id, eaName:String(eaName).trim(), platform, aliases:aliasArr, search, createdAt: Date.now() });
    playerId = id;
  }
  await COL.clubSquadSlots(clubId).doc(slotId).set({ playerId }, { merge:true });
  const slot = (await COL.clubSquadSlots(clubId).doc(slotId).get()).data();
  res.json({ ok:true, slot });
}));

app.post('/api/clubs/:clubId/squad/slots/:slotId/unassign', requireManagerOrAdminOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId, slotId } = req.params;
  await COL.clubSquadSlots(clubId).doc(slotId).set({ playerId:'' }, { merge:true });
  res.json({ ok:true });
}));

app.patch('/api/clubs/:clubId/squad/slots/:slotId', requireManagerOrAdminOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId, slotId } = req.params;
  const patch = {};
  if (req.body?.label) patch.label = String(req.body.label);
  await COL.clubSquadSlots(clubId).doc(slotId).set(patch, { merge:true });
  res.json({ ok:true });
}));

// Players registry
app.post('/api/players/register', wrap(async (req,res)=>{
  const { eaName, platform='manual', aliases=[] } = req.body || {};
  if (!eaName) return res.status(400).json({ error:'eaName required' });
  const id = uuidv4();
  const aliasArr = Array.isArray(aliases) ? aliases : String(aliases).split(',').map(s=>s.trim()).filter(Boolean);
  const search = [eaName, ...aliasArr].map(norm);
  const doc = { id, eaName:String(eaName).trim(), platform, aliases:aliasArr, search, createdAt: Date.now() };
  await COL.players().doc(id).set(doc);
  res.json({ ok:true, player: doc });
}));
app.post('/api/players/:playerId/update', requireAdmin, wrap(async (req,res)=>{
  const { playerId } = req.params;
  const patch = req.body || {};
  if (patch.eaName || patch.aliases){
    const aliasArr = Array.isArray(patch.aliases) ? patch.aliases : String(patch.aliases||'').split(',').map(s=>s.trim()).filter(Boolean);
    const base = patch.eaName ? String(patch.eaName).trim() : null;
    patch.search = [ base, ...aliasArr ].filter(Boolean).map(norm);
    patch.aliases = aliasArr;
    if (base) patch.eaName = base;
  }
  await COL.players().doc(playerId).set(patch, { merge:true });
  const doc = await COL.players().doc(playerId).get();
  res.json({ ok:true, player: doc.data() });
}));

app.get('/api/players/:playerId', wrap(async (req,res)=>{
  const { playerId } = req.params;
  const snap = await COL.players().doc(playerId).get();
  if (!snap.exists) return res.status(404).json({ error:'not found' });
  res.json({ ok:true, player: snap.data() });
}));

// -----------------------------
// Name → playerId resolution
// -----------------------------
async function resolvePlayerIdByName(name, clubId){
  const n = norm(name);
  if (!n) return null;
  const snap = await COL.clubSquadSlots(clubId).get();
  for (const d of snap.docs){
    const slot = d.data();
    if (!slot.playerId) continue;
    const p = await COL.players().doc(slot.playerId).get();
    if (p.exists){
      const pr = p.data();
      if ((pr.search||[]).includes(n)) return pr.id;
    }
  }
  const q = await COL.players().where('search','array-contains', n).limit(1).get();
  if (!q.empty) return q.docs[0].data().id;
  return null;
}

// Helper to fetch player name by id
const _playerNameCache = new Map();
async function lookupPlayerName(playerId){
  if (!playerId) return '';
  if (_playerNameCache.has(playerId)) return _playerNameCache.get(playerId);
  const snap = await COL.players().doc(playerId).get();
  const data = snap.exists ? snap.data() : null;
  const name = data?.eaName || data?.name || '';
  _playerNameCache.set(playerId, name);
  return name;
}

// -----------------------------
// Player stats
// -----------------------------
async function bumpPlayerStatsFromFixture(f){
  const season = seasonKey();
  const updated = new Map();
  for (const side of ['home','away']){
    for (const r of (f.details?.[side]||[])){
      if (!r.playerId) continue;
      const id = `${season}_${r.playerId}`;
      const ref = COL.playerStats().doc(id);
      const snap = await ref.get();
      const prev = snap.exists ? snap.data() : {};
      const goals = Number(r.goals||0);
      const assists = Number(r.assists||0);
      const rating = Number(r.rating||0);
      const scored = goals>0;
      const assisted = assists>0;
      const contributed = scored || assisted;
      const next = {
        season,
        playerId: r.playerId,
        goals: (prev.goals||0) + goals,
        assists: (prev.assists||0) + assists,
        ratingsSum: (prev.ratingsSum||0) + rating,
        ratingsCount: (prev.ratingsCount||0) + (rating ? 1 : 0),
        goalStreak: scored ? (prev.goalStreak||0) + 1 : 0,
        assistStreak: assisted ? (prev.assistStreak||0) + 1 : 0,
        contribStreak: contributed ? (prev.contribStreak||0) + 1 : 0,
      };
      await ref.set(next, { merge:true });
      updated.set(r.playerId, next);
    }
  }
  return updated;
}

// -----------------------------
// Fixtures
// -----------------------------
app.post('/api/cup/fixtures', requireAdmin, wrap(async (req,res)=>{
  const { home, away, round, cup='UPCL', group=null, when=null } = req.body || {};
  if (!home || !away) return res.status(400).json({ error:'home and away required' });
  if (home === away) return res.status(400).json({ error:'home and away cannot match' });

  const id = uuidv4();
  const fixture = {
    id, cup,
    group: group ? String(group) : null,
    round: String(round || 'Round'),
    home: String(home), away: String(away),
    teams: [String(home), String(away)],
    status: when ? 'scheduled' : 'pending',
    timeLockedAt: when ? Date.now() : null,
    proposals: [],
    votes: {},
    when: when ? Number(when) : null,
    lineups: {},
    score: { hs:0, as:0 },
    report: { text:'', mvpHome:'', mvpAway:'', discordMsgUrl:'' },
    details: { home: [], away: [] },
    unresolved: [],
    createdAt: Date.now()
  };
  await setDoc('fixtures', id, fixture);
  res.json({ ok:true, fixture });
}));

// Public sanitized (optionally include lineups)
app.get('/api/cup/fixtures/public', wrap(async (req,res)=>{
  const cup = (req.query.cup || 'UPCL').trim();
  const includeLineups = String(req.query.includeLineups||'0')==='1';
  const fixtures = await fixturesByCup(cup);
  const list = fixtures.map(f=>{
    const base = {
      id:f.id, cup:f.cup, round:f.round, group:f.group||null,
      home:f.home, away:f.away, when:f.when||null, status:f.status,
      score: f.score || { hs:0, as:0 }, details: f.details || { home:[], away:[] }, createdAt: f.createdAt || 0
    };
    if (includeLineups) base.lineups = f.lineups || {};
    return base;
  });
  res.json({ fixtures: list });
}));

// Scheduling (Managers/Admins)
app.get('/api/cup/fixtures/scheduling', requireManagerOrAdmin, wrap(async (req,res)=>{
  const cup = (req.query.cup || 'UPCL').trim();
  const fixtures = await fixturesByCup(cup);
  res.json({ fixtures });
}));

// List (+ optional filter by club)
app.get('/api/cup/fixtures', wrap(async (req,res)=>{
  const cup = (req.query.cup || 'UPCL').trim();
  const clubId = (req.query.clubId || '').trim();
  let fixtures = await fixturesByCup(cup);
  if (clubId) fixtures = fixtures.filter(f=> f.home===clubId || f.away===clubId);
  res.json({ fixtures });
}));

app.get('/api/cup/fixtures/:id', wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  res.json({ fixture: f });
}));

app.post('/api/cup/fixtures/:id/propose', requireManagerOrAdmin, wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  const at = Number(req.body?.at || 0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });

  const adminMode = isAdminSession(req);
  if (!adminMode && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  f.proposals = f.proposals || [];
  f.votes = f.votes || {};
  if (!f.proposals.some(p=>Number(p.at)===at)) f.proposals.push({ at, by: adminMode ? 'admin' : me(req).teamId });
  f.votes[String(at)] = f.votes[String(at)] || {};
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

app.post('/api/cup/fixtures/:id/vote', requireManagerOrAdmin, wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  const at = String(req.body?.at || '');
  const agree = !!req.body?.agree;
  if (!at) return res.status(400).json({ error:'invalid slot' });

  const adminMode = isAdminSession(req);
  if (!adminMode && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const teamId = adminMode ? 'admin' : me(req).teamId;
  f.votes = f.votes || {};
  f.votes[at] = f.votes[at] || {};
  f.votes[at][teamId] = agree;

  if (f.votes[at][f.home] === true && f.votes[at][f.away] === true){
    f.when = Number(at);
    f.status = 'scheduled';
    f.timeLockedAt = Date.now();
  }
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

app.put('/api/cup/fixtures/:id/lineup', requireManagerOrAdmin, wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  const adminMode = isAdminSession(req);
  if (!adminMode && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const { formation, lineup } = req.body || {};
  f.lineups = f.lineups || {};
  const owner = adminMode ? 'admin' : me(req).teamId;
  f.lineups[owner] = { formation:String(formation||''), lineup: (lineup && typeof lineup==='object') ? lineup : {}, at: Date.now() };
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// ---- Result submission (creates News) ----
async function newsFromFinal(f, statsMap=new Map()){
  // Derived strings used for all news items
  const hs = Number(f.score?.hs||0);
  const as = Number(f.score?.as||0);
  const summary = `${f.home} ${hs}\u2013${as} ${f.away}`;
  const winner = hs>as ? f.home : (hs<as ? f.away : f.home);

  const format = (obj)=>{
    let clubId = obj.clubId || winner;
    let title = summary;
    let body = summary;
    let tag  = obj.type;
    switch(obj.type){
      case 'final':
        body = f.cup ? `${f.cup} result` : 'Friendly result';
        tag = 'result';
        clubId = winner;
        break;
      case 'brace':
        title = `${obj.player} brace`;
        tag = 'brace';
        break;
      case 'hattrick':
        title = `${obj.player} hat-trick`;
        tag = 'hattrick';
        break;
      case 'haul':
        title = `${obj.player} ${obj.goals}-goal haul`;
        tag = 'haul';
        break;
      case 'assist_brace':
        title = `${obj.player} 2 assists`;
        tag = 'assist';
        break;
      case 'assist_hat':
        title = `${obj.player} ${obj.assists} assists`;
        tag = 'assist';
        break;
      case 'combo':
        title = `${obj.player} ${obj.goals}g/${obj.assists}a`;
        tag = 'combo';
        break;
      case 'high_rating':
        title = `${obj.player} ${obj.rating} rating`;
        tag = 'rating';
        break;
      case 'goal_milestone':
        title = `${obj.player} ${obj.goalsTotal} goals`;
        tag = 'milestone';
        break;
      case 'assist_milestone':
        title = `${obj.player} ${obj.assistsTotal} assists`;
        tag = 'milestone';
        break;
      case 'goal_streak':
        title = `${obj.player} ${obj.streak}-game goal streak`;
        tag = 'streak';
        break;
      case 'assist_streak':
        title = `${obj.player} ${obj.streak}-game assist streak`;
        tag = 'streak';
        break;
      case 'contrib_streak':
        title = `${obj.player} ${obj.streak}-game contrib streak`;
        tag = 'streak';
        break;
      case 'clean_sheet':
        title = `${clubId===f.home?f.home:f.away} clean sheet`;
        tag = 'clean_sheet';
        break;
      case 'high_scoring':
        title = 'High-scoring match';
        tag = 'high_scoring';
        break;
      case 'blowout':
        title = `${clubId===f.home?f.home:f.away} blowout win`;
        tag = 'blowout';
        break;
    }
    return { ...obj, title, body, tag, clubId };
  };

  const save = obj => COL.news().doc(obj.id).set(format(obj));

  // Final result news
  await save({ id:`final_${f.id}`, type:'final', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', home:f.home, away:f.away, score:f.score });

  const goalMilestones = [1,10,50];
  const assistMilestones = [1,10,50];

  for (const side of ['home','away']){
    for (const r of (f.details?.[side]||[])){
      const g = Number(r.goals||0);
      const a = Number(r.assists||0);
      const rating = Number(r.rating||0);
      const clubId = side==='home'?f.home:f.away;
      const playerName = r.player || await lookupPlayerName(r.playerId);

      // Multi-goal feats
      if (g===2){
        const nid = `brace_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'brace', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, goals:g });
      } else if (g===3){
        const nid = `hat_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'hattrick', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, goals:g });
      } else if (g>=4){
        const nid = `haul_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'haul', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, goals:g });
      }

      // Assist milestones
      if (a===2){
        const nid = `assist_brace_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'assist_brace', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, assists:a });
      } else if (a>=3){
        const nid = `assist_hat_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'assist_hat', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, assists:a });
      }

      // Combined contributions
      if (g>=2 && a>=2){
        const nid = `combo_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'combo', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, goals:g, assists:a });
      }

      // High rating
      if (rating>=9){
        const nid = `rating_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
        await save({ id:nid, type:'high_rating', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, rating });
      }

      const stats = statsMap.get(r.playerId) || null;
      if (stats){
        // Cumulative milestones
        if (g>0 && goalMilestones.includes(stats.goals)){
          const nid = `goal_ms_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
          await save({ id:nid, type:'goal_milestone', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, goalsTotal:stats.goals });
        }
        if (a>0 && assistMilestones.includes(stats.assists)){
          const nid = `assist_ms_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
          await save({ id:nid, type:'assist_milestone', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, assistsTotal:stats.assists });
        }
        // Streaks
        if (g>0 && stats.goalStreak>=3){
          const nid = `goal_streak_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
          await save({ id:nid, type:'goal_streak', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, streak:stats.goalStreak });
        }
        if (a>0 && stats.assistStreak>=3){
          const nid = `assist_streak_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
          await save({ id:nid, type:'assist_streak', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, streak:stats.assistStreak });
        }
        if ((g>0||a>0) && stats.contribStreak>=3){
          const nid = `contrib_streak_${f.id}_${side}_${norm(r.player||r.playerId||'x')}`;
          await save({ id:nid, type:'contrib_streak', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId, playerId:r.playerId||'', player:playerName, streak:stats.contribStreak });
        }
      }
    }
  }

  // Team-centric news
  const total = hs + as;
  const diff = Math.abs(hs - as);
  if (as===0){
    const nid = `cs_${f.id}_home`;
    await save({ id:nid, type:'clean_sheet', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId:f.home, score:f.score });
  }
  if (hs===0){
    const nid = `cs_${f.id}_away`;
    await save({ id:nid, type:'clean_sheet', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId:f.away, score:f.score });
  }
  if (total>=8){
    const nid = `high_scoring_${f.id}`;
    await save({ id:nid, type:'high_scoring', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', home:f.home, away:f.away, score:f.score });
  }
  if (diff>=5){
    const nid = `blowout_${f.id}`;
    await save({ id:nid, type:'blowout', ts:Date.now(), cup:f.cup, group:f.group||null, round:f.round||'', clubId:winner, score:f.score });
  }
}

app.post('/api/cup/fixtures/:id/report', requireManagerOrAdmin, wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!isAdminSession(req) && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only (or admin)' });

  const { hs, as, text, mvpHome, mvpAway, discordMsgUrl, details } = req.body || {};
  f.score  = { hs:Number(hs||0), as:Number(as||0) };
  f.report = { text:String(text||''), mvpHome:String(mvpHome||''), mvpAway:String(mvpAway||''), discordMsgUrl:String(discordMsgUrl||'') };

  if (details && typeof details==='object'){
    f.details = { home:[], away:[] };
    f.unresolved = [];
    for (const side of ['home','away']){
      for (const row of (details[side]||[])){
        let { playerId, player, goals=0, assists=0, rating=0 } = row || {};
        if (!playerId && player) playerId = await resolvePlayerIdByName(player, side==='home' ? f.home : f.away);
        const item = { playerId: playerId||'', player: player||'', goals:Number(goals||0), assists:Number(assists||0), rating:Number(rating||0) };
        f.details[side].push(item);
        if (!playerId && player) f.unresolved.push({ side, name: player });
      }
    }
  }
  f.status = 'final';
  if (!f.when) f.when = Date.now();

  await setDoc('fixtures', f.id, f);
  const statsMap = await bumpPlayerStatsFromFixture(f);
  await newsFromFinal(f, statsMap);
  res.json({ ok:true, fixture: f });
}));

app.post('/api/cup/fixtures/:id/ingest-text', requireAdmin, wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error:'text required' });

  const parsed = parseLooseResultText(text);
  if (!parsed) return res.status(400).json({ error:'could not parse input' });

  const out = { home:[], away:[] }, unresolved = [];
  for (const side of ['home','away']){
    for (const r of parsed.details[side]){
      let pid = r.playerId || null;
      if (!pid && r.player) pid = await resolvePlayerIdByName(r.player, side==='home' ? f.home : f.away);
      const item = { playerId: pid||'', player: r.player||'', goals:Number(r.goals||0), assists:Number(r.assists||0), rating:Number(r.rating||0) };
      out[side].push(item);
      if (!pid && r.player) unresolved.push({ side, name:r.player });
    }
  }

  f.score = parsed.score;
  f.details = out;
  f.unresolved = unresolved;
  f.status = 'final';
  if (!f.when) f.when = Date.now();

  await setDoc('fixtures', f.id, f);
  const statsMap = await bumpPlayerStatsFromFixture(f);
  await newsFromFinal(f, statsMap);
  res.json({ ok:true, fixture: f });
}));

function parseLooseResultText(str){
  const toks = String(str).replace(/\n/g, ',').split(',').map(s=>s.trim()).filter(Boolean);
  let side = 'home';
  const details = { home:[], away:[] };
  const score = { hs:0, as:0 };
  let cur = null;
  const commit = ()=>{
    if (cur && cur.player){
      cur.goals = Number(cur.goals||0);
      cur.assists = Number(cur.assists||0);
      cur.rating = Number(cur.rating||0);
      details[side].push(cur);
    }
    cur = null;
  };
  for (let t of toks){
    const low = t.toLowerCase();

    if (low.includes('home')) { commit(); side='home'; continue; }
    if (low.includes('away')) { commit(); side='away'; continue; }

    let m = t.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m){ score.hs=Number(m[1]); score.as=Number(m[2]); continue; }

    m = t.match(/score\s*:\s*(\d+)/i);
    if (m){ if (side==='home') score.hs=Number(m[1]); else score.as=Number(m[1]); continue; }

    m = t.match(/player\s*\d*\s*:\s*(.+)/i);
    if (m){ commit(); cur={ player:m[1].trim() }; continue; }

    m = t.match(/(\d+)\s*goal/i); if (m){ cur=cur||{}; cur.goals=Number(m[1]); continue; }
    m = t.match(/(\d+)\s*assist/i); if (m){ cur=cur||{}; cur.assists=Number(m[1]); continue; }
    m = t.match(/rating\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (m){ cur=cur||{}; cur.rating=Number(m[1]); continue; }

    if (!cur || !cur.player){
      if (t && !/^\d+(\.\d+)?$/.test(t) && !/^(score|rating|goal|assist)/i.test(t)){
        cur = cur || {};
        cur.player = (cur.player || t);
      }
    }
  }
  commit();
  return { score, details };
}

// -----------------------------
// UPCL League
// -----------------------------
async function computeLeagueTable(leagueId){
  const { rows: teamRows } = await pool.query(`
    SELECT clubid FROM (
      SELECT DISTINCT home AS clubid FROM fixtures WHERE league_id = $1
      UNION
      SELECT DISTINCT away AS clubid FROM fixtures WHERE league_id = $1
    ) t
  `, [leagueId]);
  const teamIds = teamRows.map(r => r.clubid);
  if (!teamIds.length) return { teams: [], standings: [] };

  const { rows } = await pool.query(`
    WITH f AS (
      SELECT home, away,
             (score->>'hs')::int AS hs,
             (score->>'as')::int AS away_score
      FROM fixtures
      WHERE league_id = $1
        AND status = 'final'
        AND COALESCE(details->>'matchType','league') = 'league'
    ),
    r AS (
      SELECT home AS clubid, hs AS gf, away_score AS ga,
             CASE WHEN hs>away_score THEN 1 ELSE 0 END AS w,
             CASE WHEN hs=away_score THEN 1 ELSE 0 END AS d,
             CASE WHEN hs<away_score THEN 1 ELSE 0 END AS l,
             0 AS ag,
             0 AS aw
      FROM f
      UNION ALL
      SELECT away AS clubid, away_score AS gf, hs AS ga,
             CASE WHEN away_score>hs THEN 1 ELSE 0 END AS w,
             CASE WHEN away_score=hs THEN 1 ELSE 0 END AS d,
             CASE WHEN away_score<hs THEN 1 ELSE 0 END AS l,
             away_score AS ag,
             CASE WHEN away_score>hs THEN 1 ELSE 0 END AS aw
      FROM f
    )
    SELECT clubid,
           COUNT(*) AS p,
           SUM(w) AS w,
           SUM(d) AS d,
           SUM(l) AS l,
           SUM(gf) AS gf,
           SUM(ga) AS ga,
           SUM(gf) - SUM(ga) AS gd,
           SUM(ag) AS ag,
           SUM(aw) AS aw,
           SUM(w)*3 + SUM(d) AS pts
    FROM r
    GROUP BY clubid
  `, [leagueId]);

  const table = {};
  const touch = id => table[id] = table[id] || { clubId:id, P:0, W:0, D:0, L:0, GF:0, GA:0, GD:0, AG:0, AW:0, Pts:0 };
  teamIds.forEach(id=> touch(id));
  for (const r of rows){
    const t = touch(r.clubid);
    t.P   = Number(r.p);
    t.W   = Number(r.w);
    t.D   = Number(r.d);
    t.L   = Number(r.l);
    t.GF  = Number(r.gf);
    t.GA  = Number(r.ga);
    t.GD  = Number(r.gd);
    t.AG  = Number(r.ag);
    t.AW  = Number(r.aw);
    t.Pts = Number(r.pts);
  }
  const standings = Object.values(table).sort((a,b)=>(b.Pts-a.Pts)||(b.GD-a.GD)||(b.GF-a-GF)||(b.AG-a.AG)||(b.W-a.W)||(b.AW-a.AW));
  return { teams: teamIds, standings };
}

app.post('/api/leagues/:leagueId/teams', requireAdmin, wrap(async (req,res)=>{
  const { leagueId } = req.params;
  const teams = Array.isArray(req.body?.teams) ? req.body.teams.map(String) : [];
  const doc = { leagueId, teams, createdAt: Date.now() };
  await setDoc('leagues', leagueId, doc);
  res.json({ ok:true, league: doc });
}));

app.get('/api/leagues/:leagueId', wrap(async (req,res)=>{
  const { leagueId } = req.params;
  const { teams, standings } = await computeLeagueTable(leagueId);
  res.json({ ok:true, teams, standings });
}));

app.get('/api/leagues/:leagueId/leaders', wrap(async (req,res)=>{
  const { leagueId } = req.params;
  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 5)));

  const { rows } = await pool.query(`
    WITH stats AS (
      SELECT (p->>'playerId') AS playerid,
             COALESCE(p->>'player','') AS name,
             f.home AS clubid,
             COALESCE((p->>'goals')::int,0) AS goals,
             COALESCE((p->>'assists')::int,0) AS assists
      FROM fixtures f
      CROSS JOIN LATERAL jsonb_array_elements(f.details->'home') p
      WHERE f.league_id=$1 AND f.status='final' AND COALESCE(f.details->>'matchType','league')='league'
      UNION ALL
      SELECT (p->>'playerId') AS playerid,
             COALESCE(p->>'player','') AS name,
             f.away AS clubid,
             COALESCE((p->>'goals')::int,0) AS goals,
             COALESCE((p->>'assists')::int,0) AS assists
      FROM fixtures f
      CROSS JOIN LATERAL jsonb_array_elements(f.details->'away') p
      WHERE f.league_id=$1 AND f.status='final' AND COALESCE(f.details->>'matchType','league')='league'
    )
    SELECT playerid, MAX(name) AS name, MAX(clubid) AS clubid,
           SUM(goals) AS goals, SUM(assists) AS assists
    FROM stats
    GROUP BY playerid
  `, [leagueId]);

  const meta = new Map();
  rows.forEach(r=> meta.set(r.playerid, { name:r.name || '', clubId:r.clubid || '' }));

  const ids = rows.filter(r=>!(r.name)).map(r=>r.playerid);
  const chunks = [];
  for (let i=0;i<ids.length;i+=10) chunks.push(ids.slice(i,i+10));
  for (const ch of chunks){
    const q = await COL.players().where(FieldPath.documentId(), 'in', ch).get();
    q.docs.forEach(p=>{ const m = meta.get(p.id); if (m) m.name = p.data()?.eaName || m.name; });
  }

  const toRows = (field)=> rows
    .filter(r=> Number(r[field])>0)
    .map(r=>({ playerId:r.playerid, count:Number(r[field]), name: meta.get(r.playerid)?.name || 'Unknown', clubId: meta.get(r.playerid)?.clubId || '' }))
    .sort((a,b)=>(b.count-a.count)||String(a.name).localeCompare(String(b.name)))
    .slice(0,limit);

  res.json({ ok:true, scorers: toRows('goals'), assisters: toRows('assists') });
}));

// Fetch latest EA league matches and upsert fixtures
app.post('/api/leagues/:leagueId/fetch-ea', requireAdmin, wrap(async (req,res)=>{
  const { leagueId } = req.params;
  const league = await getDoc('leagues', leagueId);
  if (!league) return res.status(404).json({ error:'League not found' });

  const teamIds = Array.isArray(league.teams) ? league.teams : [];
  let inserted = 0;

  const matchesByClub = await eaApi.fetchClubLeagueMatches(teamIds);
  for (const clubId of teamIds) {
    const matches = matchesByClub?.[clubId] || [];
    if (!Array.isArray(matches) || !matches.length) continue;

    const newestId = matches[0]?.matchId ? String(matches[0].matchId) : null;
    const { rows } = await pool.query('SELECT last_match_id FROM ea_last_matches WHERE club_id=$1', [clubId]);
    const lastId = rows[0]?.last_match_id || null;

    for (const m of matches) {
      if (lastId && String(m.matchId) === String(lastId)) break;
      const f = normalizeEAMatch(m, leagueId);
      await setDoc('fixtures', f.id, f);
      inserted++;
    }

    if (newestId && newestId !== lastId) {
      await pool.query(
        `INSERT INTO ea_last_matches (club_id, last_match_id) VALUES ($1,$2)
         ON CONFLICT (club_id) DO UPDATE SET last_match_id = EXCLUDED.last_match_id`,
        [clubId, newestId]
      );
    }
  }

  res.json({ ok:true, inserted });
}));

function normalizeEAMatch(m, leagueId){
  const homeClub = String(m?.home?.clubId || m?.homeClubId || '');
  const awayClub = String(m?.away?.clubId || m?.awayClubId || '');
  const hs = Number(m?.home?.goals ?? m?.home?.score ?? m?.homeGoals ?? 0);
  const as = Number(m?.away?.goals ?? m?.away?.score ?? m?.awayGoals ?? 0);
  const playedAt = m?.timestamp ? Date.parse(m.timestamp) : (m?.matchDate ? Date.parse(m.matchDate) : null);
  return {
    id: String(m.matchId),
    cup: leagueId,
    round: String(m.round || 'League'),
    home: homeClub,
    away: awayClub,
    teams: [homeClub, awayClub],
    status: 'final',
    when: playedAt || null,
    played_at: playedAt ? new Date(playedAt).toISOString() : null,
    score: { hs, as },
    report: { text:'', mvpHome:'', mvpAway:'', discordMsgUrl:'' },
    details: { home: [], away: [] },
    unresolved: [],
    createdAt: Date.now(),
  };
}

// -----------------------------
// Friendlies / Exhibition Matches
// -----------------------------
app.post('/api/friendlies/:frId/teams', requireAdmin, wrap(async (req,res)=>{
  const { frId } = req.params;
  const teams = Array.isArray(req.body?.teams) ? req.body.teams.map(String) : [];
  const doc = { frId, teams, createdAt: Date.now() };
  await COL.friendlies().doc(frId).set(doc);
  res.json({ ok:true, friendly: doc });
}));

app.get('/api/friendlies/:frId', wrap(async (req,res)=>{
  const { frId } = req.params;
  const snap = await COL.friendlies().doc(frId).get();
  const friendly = snap.exists ? snap.data() : { frId, teams:[], createdAt: Date.now() };
  res.json({ ok:true, friendly });
}));

app.post('/api/friendlies/:frId/generate', requireAdmin, wrap(async (req,res)=>{
  const { frId } = req.params;
  const snap = await COL.friendlies().doc(frId).get();
  const teams = snap.exists ? (snap.data().teams||[]) : [];
  if (teams.length < 2) return res.status(400).json({ error:'Need at least 2 teams' });
  const created = [];
  for (let i=0;i<teams.length;i++){
    for (let j=i+1;j<teams.length;j++){
      const id = uuidv4();
      const fixture = {
        id, cup: frId,
        group: null,
        round: 'Friendly',
        home: teams[i], away: teams[j],
        teams: [teams[i], teams[j]],
        status: 'pending',
        timeLockedAt: null,
        proposals: [], votes: {},
        when: null,
        lineups: {},
        score: { hs:0, as:0 },
        report: { text:'', mvpHome:'', mvpAway:'', discordMsgUrl:'' },
        details: { home:[], away:[] },
        unresolved: [],
        createdAt: Date.now()
      };
      await setDoc('fixtures', id, fixture);
      created.push(fixture);
    }
  }
  res.json({ ok:true, created: created.length });
}));

// -----------------------------
// Champions Cup
// -----------------------------
app.post('/api/champions/:cupId/groups', requireAdmin, wrap(async (req,res)=>{
  const { cupId } = req.params;
  const groups = req.body?.groups || {};
  const rawGroups = {
    A: Array.isArray(groups.A) ? groups.A : [],
    B: Array.isArray(groups.B) ? groups.B : [],
    C: Array.isArray(groups.C) ? groups.C : [],
    D: Array.isArray(groups.D) ? groups.D : [],
  };
  const allIds = [...rawGroups.A, ...rawGroups.B, ...rawGroups.C, ...rawGroups.D];
  if (hasDuplicates(allIds)) return res.status(400).json({ error:'Duplicate clubIds are not allowed' });
  const docGroups = {
    A: uniqueStrings(rawGroups.A),
    B: uniqueStrings(rawGroups.B),
    C: uniqueStrings(rawGroups.C),
    D: uniqueStrings(rawGroups.D),
  };
  const doc = { cupId, groups: docGroups, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

app.post('/api/champions/:cupId/randomize', requireAdmin, wrap(async (req,res)=>{
  const { cupId } = req.params;
  let clubs = Array.isArray(req.body?.clubs) ? req.body.clubs.slice() : [];
  if (!clubs.length) return res.status(400).json({ error:'Provide an array of clubIds in body.clubs' });
  if (hasDuplicates(clubs)) return res.status(400).json({ error:'Duplicate clubIds are not allowed' });
  clubs = uniqueStrings(clubs);
  shuffle(clubs);
  const groups = { A:[], B:[], C:[], D:[] };
  // Distribute round-robin into A-D; supports any multiple, not only 16
  clubs.forEach((id,i)=> groups[['A','B','C','D'][i%4]].push(id));
  const doc = { cupId, groups, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

async function computeGroupTables(cupId, groups){
  const fx = (await fixturesByCup(cupId)).filter(f=>f.status==='final');
  const table = { A:{}, B:{}, C:{}, D:{} };
  const touch = (g,id)=> table[g][id] = table[g][id] || { clubId:id, P:0, W:0, D:0, L:0, GF:0, GA:0, GD:0, Pts:0 };

  for (const g of ['A','B','C','D']){
    for (const id of (groups[g]||[])) touch(g,id);
  }
  for (const f of fx){
    const g = f.group || null; if(!g || !table[g]) continue;
    touch(g, f.home); touch(g, f.away);
    const H = table[g][f.home], A = table[g][f.away];
    const hs = Number(f.score?.hs||0), as = Number(f.score?.as||0);
    H.P++; A.P++;
    H.GF+=hs; H.GA+=as; H.GD=H.GF-H.GA;
    A.GF+=as; A.GA+=hs; A.GD=A.GF-A.GA;
    if(hs>as){ H.W++; H.Pts+=3; A.L++; }
    else if(hs<as){ A.W++; A.Pts+=3; H.L++; }
    else { H.D++; A.D++; H.Pts++; A.Pts++; }
  }
  const sorted = {};
  for (const g of ['A','B','C','D']){
    sorted[g] = Object.values(table[g]).sort((x,y)=>(y.Pts-x.Pts)||(y.GD-x.GD)||(y.GF-y.GF));
  }
  return sorted;
}

app.get('/api/champions/:cupId', wrap(async (req,res)=>{
  const { cupId } = req.params;
  const snap = await COL.champions().doc(cupId).get();
  const cup = snap.exists ? snap.data() : { cupId, groups:{A:[],B:[],C:[],D:[]}, createdAt: Date.now() };
  const tables = await computeGroupTables(cupId, cup.groups);
  const { rows } = await pool.query('SELECT COUNT(*) FROM fixtures WHERE league_id = $1', [cupId]);
  const stats = { fixtureCount: Number(rows[0]?.count || 0) };
  res.json({ ok:true, cup, tables, stats });
}));

// Leaders (Top scorers / assisters) — limit via ?limit=5
app.get('/api/champions/:cupId/leaders', wrap(async (req,res)=>{
  const { cupId } = req.params;
  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 5)));
  const fx = (await fixturesByCup(cupId)).filter(f=>f.status==='final');

  const goals = new Map(), assists = new Map(), meta = new Map();
  const bump = (m,k,n)=> m.set(k,(m.get(k)||0)+n);

  for (const f of fx){
    for (const side of ['home','away']){
      const clubId = side==='home' ? f.home : f.away;
      for (const r of (f.details?.[side]||[])){
        if (!r.playerId) continue;
        meta.set(r.playerId,{ name: r.player || '', clubId });
        if (r.goals)   bump(goals,   r.playerId, Number(r.goals||0));
        if (r.assists) bump(assists, r.playerId, Number(r.assists||0));
      }
    }
  }

  const ids = Array.from(meta.keys()).filter(id => !meta.get(id)?.name);
  const chunks = [];
  for (let i=0;i<ids.length;i+=10) chunks.push(ids.slice(i, i+10));
  for (const ch of chunks){
    const q = await COL.players().where(FieldPath.documentId(), 'in', ch).get();
    q.docs.forEach(p=>{ const m = meta.get(p.id); if (m) m.name = p.data()?.eaName || m.name; });
  }

  const toRows = (m)=> Array.from(m.entries())
    .map(([playerId,count])=>({ playerId, count, name: meta.get(playerId)?.name || 'Unknown', clubId: meta.get(playerId)?.clubId || '' }))
    .sort((a,b)=>(b.count-a.count)||String(a.name).localeCompare(String(b.name)))
    .slice(0,limit);

  res.json({ ok:true, scorers: toRows(goals), assisters: toRows(assists) });
}));

// -----------------------------
// News feed (finals + hat-tricks)
// -----------------------------
app.get('/api/news', wrap(async (req,res)=>{
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
  const snap = await COL.news().orderBy('ts','desc').limit(limit).get();
  const items = snap.docs.map(d=>d.data());
  res.json({ ok:true, items });
}));

// -----------------------------
// Discord helpers & endpoints
// -----------------------------
async function discordSend(webhookUrl, payload){
  if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_CC not set');
  const url = webhookUrl.includes('?') ? webhookUrl + '&wait=true' : webhookUrl + '?wait=true';
  const headers = { 'Content-Type':'application/json', 'User-Agent':'UPCL-LeagueBot/1.0 (+https://example.com)' };

  for (let attempt=0; attempt<3; attempt++){
    const res = await (global.fetch || fetchFn)(url, { method:'POST', headers, body: JSON.stringify(payload) });

    if (res.status !== 429){
      if (!res.ok){
        const body = await res.text().catch(()=> '');
        throw new Error(`Discord ${res.status}: ${body.slice(0,200)}`);
      }
      return await res.json().catch(()=> ({}));
    }
    let retry = 1;
    try { const j = await res.json(); if (j && j.retry_after) retry = Number(j.retry_after); } catch {}
    if (!retry) retry = Number(res.headers.get('retry-after')) || 1;
    await new Promise(r=> setTimeout(r, Math.ceil(retry*1000)));
  }
  throw new Error('Discord rate limit (429) after retries');
}

async function discordPostSimple(text){
  return discordSend(DISCORD_WEBHOOK_CC, { content: text });
}

app.post('/api/discord/test', requireAdmin, wrap(async (req,res)=>{
  const { msg='Ping from server ✅' } = req.body || {};
  const out = await discordSend(DISCORD_WEBHOOK_CC, { content: msg });
  res.json({ ok:true, result: out });
}));

app.get('/api/debug/discord', requireAdmin, (req,res)=>{
  res.json({
    ok:true,
    hasWebhook: !!DISCORD_WEBHOOK_CC,
    webhookSample: DISCORD_WEBHOOK_CC ? DISCORD_WEBHOOK_CC.slice(0,60)+'…' : ''
  });
});

// Champions Cup — upcoming (scheduled + TBD)
app.post('/api/discord/cc/upcoming', requireAdmin, wrap(async (req,res)=>{
  if (!DISCORD_WEBHOOK_CC) return res.status(500).json({ error:'DISCORD_WEBHOOK_CC not set' });
  const cup = (req.query.cup || 'UPCL_CC_2025_08').trim();
  const includeTbd = String(req.query.includeTbd||'1')==='1';
  const tz = req.query.tz || 'America/Los_Angeles';

  const fixtures = (await fixturesByCup(cup)).filter(f=> f.status!=='final');

  const now = Date.now();
  const scheduled = fixtures.filter(f=> f.when && f.when>=now).sort((a,b)=>(a.when||0)-(b.when||0));
  const tbd = includeTbd ? fixtures.filter(f=> !f.when) : [];

  const fmt = (ms)=> new Date(ms).toLocaleString('en-US',{ timeZone:tz, month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const line = (f)=> `**${f.home}** vs **${f.away}** — ${f.when ? fmt(f.when) : 'TBD'}`;

  const parts = [];
  if (scheduled.length) parts.push(`__Scheduled__:\n${scheduled.map(line).join('\n')}`);
  if (tbd.length)       parts.push(`__TBD__:\n${tbd.map(line).join('\n')}`);

  const embed = { title:`Champions Cup Fixtures (${cup})`, description: (parts.join('\n\n')||'No fixtures yet.').slice(0,3500), color:0xff4757 };
  const payload = { embeds:[embed] };

  // (Forum channels would need thread_name/thread_id, text channels do not)
  const dry = String(req.query.dry||'0')==='1';
  if (!dry) await discordSend(DISCORD_WEBHOOK_CC, payload);
  res.json({ ok:true, scheduled: scheduled.length, tbd: tbd.length, posted: !dry, dry });
}));

// Champions Cup snapshot (fixtures + group tables)
app.post('/api/discord/cc/snapshot', requireAdmin, wrap(async (req,res)=>{
  if (!DISCORD_WEBHOOK_CC) return res.status(500).json({ error:'DISCORD_WEBHOOK_CC not set' });
  const cup = (req.query.cup || 'UPCL_CC_2025_08').trim();
  const tz = req.query.tz || 'America/Los_Angeles';

  const cupSnap = await COL.champions().doc(cup).get();
  const groups = cupSnap.exists ? (cupSnap.data().groups || {A:[],B:[],C:[],D:[]}) : {A:[],B:[],C:[],D:[]};
  const tables = await computeGroupTables(cup, groups);

  const fixtures = await fixturesByCup(cup);
  const now = Date.now();
  const upcoming = fixtures.filter(f=> f.status!=='final' && f.when && f.when>=now).sort((a,b)=>(a.when||0)-(b.when||0));
  const tbd      = fixtures.filter(f=> f.status!=='final' && !f.when);

  const fmt = (ms)=> new Date(ms).toLocaleString('en-US',{ timeZone:tz, month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const line = (f)=> `**${f.home}** vs **${f.away}** — ${f.when ? fmt(f.when) : 'TBD'}`;

  const embeds = [];

  // Fixtures embed
  const parts = [];
  if (upcoming.length) parts.push(`__Scheduled__:\n${upcoming.map(line).join('\n')}`);
  if (tbd.length)      parts.push(`__TBD__:\n${tbd.map(line).join('\n')}`);
  embeds.push({ title:`Champions Cup Fixtures (${cup})`, description:(parts.join('\n\n')||'No fixtures yet.').slice(0,3500), color:0xff4757 });

  // Tables per group
  for (const g of ['A','B','C','D']){
    const rows = (tables[g]||[]);
    if (!rows.length) continue;
    const text = rows.map(r=> `**${r.clubId}** — P:${r.P}  W:${r.W}  D:${r.D}  L:${r.L}  GF:${r.GF}  GA:${r.GA}  GD:${r.GD}  Pts:${r.Pts}`).join('\n');
    embeds.push({ title:`Group ${g} Table`, description: text.slice(0,3000), color:0x7289da });
  }

  const dry = String(req.query.dry||'0')==='1';
  if (!dry) await discordSend(DISCORD_WEBHOOK_CC, { embeds });
  res.json({ ok:true, posted: !dry, counts:{ scheduled: upcoming.length, tbd: tbd.length }, cup });
}));

// Automatic cron endpoint (no login; uses shared secret)
app.post('/api/discord/cc/auto', wrap(async (req,res)=>{
  if (!DISCORD_CRON_SECRET || String(req.query.secret) !== DISCORD_CRON_SECRET){
    return res.status(403).json({ error:'bad secret' });
  }
  if (!DISCORD_WEBHOOK_CC) return res.status(500).json({ error:'DISCORD_WEBHOOK_CC not set' });

  const cup = (req.query.cup || 'UPCL_CC_2025_08').trim();
  const windowHours = Math.max(1, Math.min(168, Number(req.query.window || 48)));
  const includeTbd = String(req.query.tbd || '1') === '1';
  const tz = req.query.tz || 'America/Los_Angeles';

  const fixtures = (await fixturesByCup(cup)).filter(f=> f.status!=='final');

  const now = Date.now();
  const until = now + windowHours * 3600_000;

  const upcoming = fixtures.filter(f=> f.when && f.when>=now && f.when<=until).sort((a,b)=>(a.when||0)-(b.when||0));
  const tbd = includeTbd ? fixtures.filter(f=> !f.when) : [];

  const fmt = (ms)=> new Date(ms).toLocaleString('en-US',{ timeZone:tz, month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const line = (f)=> `**${f.home}** vs **${f.away}** — ${f.when ? fmt(f.when) : 'TBD'}`;

  const parts = [];
  if (upcoming.length) parts.push(`__Scheduled (next ${windowHours}h)__:\n${upcoming.map(line).join('\n')}`);
  if (tbd.length)      parts.push(`__TBD__:\n${tbd.map(line).join('\n')}`);

  const embed = {
    title:`Champions Cup Fixtures — ${cup}`,
    description: (parts.join('\n\n') || 'No fixtures yet.').slice(0,3500),
    color:0xff4757, timestamp:new Date().toISOString(), footer:{ text:`Auto-post • ${tz}` }
  };

  const dry = String(req.query.dry||'0')==='1';
  if (!dry) await discordSend(DISCORD_WEBHOOK_CC, { embeds:[embed] });

  res.json({ ok:true, posted: !dry, scheduled: upcoming.length, tbd: tbd.length, cup, windowHours });
}));

// -----------------------------
// Health & errors
// -----------------------------
app.get('/healthz', (_req,res)=> res.json({ ok:true, ts: Date.now() }));

app.use((err, _req, res, _next)=>{
  const code = err.status || 500;
  if (NODE_ENV !== 'test') console.error(err);
  res.status(code).json({ error: err.message || 'Server error' });
});

// -----------------------------
// Start
// -----------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} (env: ${NODE_ENV})`);
    console.log(`Firestore project: ${admin.app().options.projectId || '(loaded)'}`);
  });
}

module.exports = app;
