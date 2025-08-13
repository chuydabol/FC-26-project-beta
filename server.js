/**
 * Pro Clubs League backend (Firestore)
 * - Admin auth, sessions
 * - Manager codes (rotate/reset/bulk export)
 * - Player claim + Free agents
 * - Rankings / wallets (daily payouts) / cup bonuses
 * - EA pass-through (numeric clubIds) with 60s cache
 * - Squad slots (15+) per club; players registry; name→id resolution
 * - Fixtures: create/list/public/scheduling/get/propose/vote/lineup/report/ingest-text
 * - Player season stats accumulation on report / ingest
 * - Champions Cup: randomize/save groups + live computed tables
 *
 * ENV (required): FIREBASE_SERVICE_ACCOUNT (JSON string), ADMIN_PASSWORD, SESSION_SECRET
 * ENV (optional): PAYOUT_ELITE, PAYOUT_MID, PAYOUT_BOTTOM, STARTING_BALANCE, NODE_ENV, PORT
 */

'use strict';

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');

// Node 18+ has global fetch; fallback to node-fetch if missing
const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));
const AbortControllerPoly = global.AbortController || (require('abort-controller'));

/* =========================
   FIREBASE ADMIN INIT
========================= */
const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required (paste the service account JSON).');
}
const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (svc.private_key && svc.private_key.includes('\\n')) {
  svc.private_key = svc.private_key.replace(/\\n/g, '\n');
}
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}
const db = admin.firestore();
const { FieldValue, FieldPath } = admin.firestore;

/* =========================
   CONFIG
========================= */
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
   EXPRESS APP
========================= */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*30 }
}));

// Static site (serves /public and /assets); default to index.html
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* =========================
   HELPERS / COLLECTIONS
========================= */
const COL = {
  rankings    : () => db.collection('rankings'),    // docId = clubId
  wallets     : () => db.collection('wallets'),     // docId = clubId
  awards      : () => db.collection('cupAwards'),   // docId = season
  users       : () => db.collection('users'),       // docId = userId
  clubCodes   : () => db.collection('clubCodes'),   // docId = clubId { hash, rotatedAt, claimedBy }
  fixtures    : () => db.collection('fixtures'),    // docId = fixtureId
  freeAgents  : () => db.collection('freeAgents'),  // docId = userId
  players     : () => db.collection('players'),     // docId = playerId
  clubSquadSlots: (clubId) => db.collection('clubSquads').doc(clubId).collection('slots'),
  playerStats : () => db.collection('playerStats'), // docId = `${season}_${playerId}`
  champions   : () => db.collection('champions'),   // docId = cupId
};

const wrap = fn => (req,res,next)=> Promise.resolve(fn(req,res,next)).catch(next);
async function getDoc(col, id){ const s = await COL[col]().doc(id).get(); return s.exists ? s.data() : null; }
async function setDoc(col, id, obj){ await COL[col]().doc(id).set(obj, { merge:false }); return obj; }
async function updateDoc(col, id, patch){ await COL[col]().doc(id).set(patch, { merge:true }); }
async function deleteDoc(col, id){ await COL[col]().doc(id).delete(); }
async function listAll(col){ const snap = await COL[col]().get(); return snap.docs.map(d=>({ id:d.id, ...d.data() })); }

function isAdminSession(req) { return req.session?.admin === true; }
function me(req){ return req.session.user || null; }

function requireAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  return res.status(403).json({ error: 'Admin only' });
}
function requireManagerOfClubParam(param = 'clubId') {
  return (req, res, next) => {
    const u = me(req);
    if (!u || u.role !== 'Manager' || String(u.teamId)!==String(req.params[param])) {
      return res.status(403).json({ error: 'Manager of this club only' });
    }
    next();
  };
}
function requireManagerOrAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  const u = me(req);
  if (u && u.role === 'Manager') return next();
  return res.status(403).json({ error: 'Managers or Admins only' });
}
function managerOwnsFixture(req, f) {
  const u = me(req);
  return !!(u && u.role==='Manager' && [f.home, f.away].includes(u.teamId));
}

function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayoutLocal(ranking){ const tier=(ranking?.tier)||'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }
function genCode(len=8){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:len},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
function seasonKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* =========================
   AUTH (Admin + Session User)
========================= */
if (!ADMIN_PASSWORD) console.warn('[WARN] ADMIN_PASSWORD not set — admin login will fail until you set it.');

app.post('/api/admin/login', wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Bad password' });
  req.session.admin = true;
  res.json({ ok:true });
}));
app.post('/api/admin/logout', (req, res) => { req.session.admin = false; res.json({ ok:true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdminSession(req) }));

app.get('/api/auth/me', (req, res) => res.json({ user: me(req) }));
app.post('/api/auth/logout', (req,res)=> req.session.destroy(()=> res.json({ ok:true })));

/* =========================
   MANAGER CODES (Single + BULK)
========================= */
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, wrap(async (req, res) => {
  const { clubId } = req.params;
  const code = genCode(8);
  const hash = await bcrypt.hash(code, 10);
  const rec = await getDoc('clubCodes', clubId) || {};
  await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now(), claimedBy: rec.claimedBy || null });
  res.json({ ok:true, clubId, code });
}));
app.post('/api/clubs/:clubId/manager-code/reset', requireAdmin, wrap(async (req,res)=>{
  const { clubId } = req.params;
  const rec = await getDoc('clubCodes', clubId);
  if (!rec) return res.status(400).json({ error: 'No code set for this club' });
  await updateDoc('clubCodes', clubId, { claimedBy: null, rotatedAt: Date.now() });
  res.json({ ok:true });
}));
app.post('/api/clubs/:clubId/claim-manager', wrap(async (req,res)=>{
  const { clubId } = req.params;
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const rec = await getDoc('clubCodes', clubId);
  if (!rec) return res.status(400).json({ error: 'No manager code set. Ask admin.' });
  const ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error: 'Invalid code' });
  if (rec.claimedBy) return res.status(409).json({ error: 'Club already has a manager' });

  const id = uuidv4();
  const user = { id, name: String(name).trim(), role: 'Manager', teamId: String(clubId) };
  await setDoc('users', id, user);
  await updateDoc('clubCodes', clubId, { claimedBy: id });
  req.session.user = user;
  res.json({ ok:true, user });
}));

// BULK rotate manager codes (returns JSON + CSV). Body: { clubs: ["2491998","afc-warriors", ...] }
app.post('/api/admin/manager-codes/rotate-all', requireAdmin, wrap(async (req,res)=>{
  const clubs = Array.isArray(req.body?.clubs) ? req.body.clubs.map(String) : [];
  if (!clubs.length) return res.status(400).json({ error:'body.clubs array required' });
  const items = [];
  for (const clubId of clubs){
    const code = genCode(8);
    const hash = await bcrypt.hash(code, 10);
    const rec = await getDoc('clubCodes', clubId) || {};
    await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now(), claimedBy: rec.claimedBy || null });
    items.push({ clubId, code });
  }
  const csv = 'clubId,code\n' + items.map(x=>`${x.clubId},${x.code}`).join('\n');
  res.json({ ok:true, count: items.length, items, csv });
}));

// Export manager-code status (no plaintext codes)
app.get('/api/admin/manager-codes/export', requireAdmin, wrap(async (_req,res)=>{
  const snap = await COL.clubCodes().get();
  const rows = snap.docs.map(d=>{
    const x = d.data();
    return { clubId:d.id, hasCode: !!x.hash, claimedBy: x.claimedBy || '', rotatedAt: x.rotatedAt || 0 };
  });
  const csv = 'clubId,hasCode,claimedBy,rotatedAt\n' + rows.map(r=>`${r.clubId},${r.hasCode},${r.claimedBy},${r.rotatedAt}`).join('\n');
  res.json({ ok:true, count: rows.length, csv, rows });
}));

/* =========================
   PLAYER ROLE + FREE AGENTS
========================= */
app.post('/api/players/claim', wrap(async (req, res) => {
  const { name, teamId = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const user = { id, name: String(name).trim(), role: 'Player', teamId: String(teamId) };
  await setDoc('users', id, user);
  req.session.user = user;
  res.json({ ok: true, user });
}));

app.get('/api/free-agents', wrap(async (_req, res) => {
  const snap = await COL.freeAgents().orderBy('listedAt', 'desc').get();
  res.json({ agents: snap.docs.map(d => d.data()) });
}));
app.post('/api/free-agents/me', requireManagerOrAdmin, wrap(async (req, res) => {
  const u = me(req);
  const {
    positions = [], foot = '', region = '', bio = '',
    availability = '', discord = '', lookingFor = ''
  } = req.body || {};
  const doc = {
    id: u.id,
    name: u.name,
    role: u.role,
    teamId: u.teamId || '',
    positions: Array.isArray(positions) ? positions : String(positions).split(',').map(s => s.trim()).filter(Boolean),
    foot: String(foot || ''),
    region: String(region || ''),
    bio: String(bio || ''),
    availability: String(availability || ''),
    discord: String(discord || ''),
    lookingFor: String(lookingFor || ''),
    listedAt: Date.now()
  };
  await COL.freeAgents().doc(u.id).set(doc);
  res.json({ ok: true, agent: doc });
}));
app.delete('/api/free-agents/me', requireManagerOrAdmin, wrap(async (req, res) => {
  const u = me(req);
  await COL.freeAgents().doc(u.id).delete();
  res.json({ ok: true });
}));

/* =========================
   RANKINGS / PAYOUTS / WALLETS
========================= */
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

// Wallet helpers
async function ensureWallet(clubId){
  const w = await getDoc('wallets', clubId);
  if (!w) {
    const doc = { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86_400_000 };
    await setDoc('wallets', clubId, doc);
    return doc;
  }
  return w;
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

// Wallet endpoints
app.get('/api/wallets/:clubId', wrap(async (req,res)=>{
  const { clubId } = req.params;
  const [w, preview, r] = await Promise.all([
    ensureWallet(clubId),
    collectPreview(clubId),
    getRanking(clubId),
  ]);
  res.json({ wallet: w, preview, perDay: getDailyPayoutLocal(r) });
}));

// Transactional collect to avoid race/double payout
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
      lastCollectedAt: (w.lastCollectedAt || 0) + days * 86_400_000, // preserve partial day
    }, { merge:false });
    return { ok:true, collected: amount };
  });
  const preview = await collectPreview(clubId); // post-tx preview
  res.json({ ...result, preview });
}));

/* =========================
   CUP BONUSES (Admin)
========================= */
app.post('/api/bonuses/cup', requireAdmin, wrap(async (req,res)=>{
  const dryRun = !!req.body?.dryRun;
  const season = (req.body?.season || '').trim() || seasonKey();

  const awardsDocRef = COL.awards().doc(season);
  const awardsDoc = await awardsDocRef.get();
  const already = awardsDoc.exists ? (awardsDoc.data().paid || {}) : {};

  const allRankings = await listAll('rankings');
  let willAward = 0, actually = 0;
  const results = [];

  for (const r of allRankings){
    const cup = r.cup || 'none';
    const bonus = Number(CUP_BONUSES[cup] || 0);
    const paid = !!already[r.id];
    results.push({ clubId: r.id, cup, bonus, alreadyPaid: paid });
    willAward += bonus;
    if (!dryRun && bonus>0 && !paid){
      await COL.wallets().doc(r.id).set({
        balance: FieldValue.increment(bonus),
        lastCollectedAt: FieldValue.serverTimestamp(), // info only
      }, { merge:true });
      already[r.id] = bonus;
      actually += bonus;
    }
  }

  if (!dryRun){
    await awardsDocRef.set({ paid: already }, { merge:false });
  }
  res.json({ ok:true, season, dryRun, totalAwarded: dryRun ? willAward : actually, results });
}));
app.get('/api/bonuses/cup', requireAdmin, wrap(async (req,res)=>{
  const season = (req.query.season || '').trim() || seasonKey();
  const doc = await COL.awards().doc(season).get();
  res.json({ ok:true, season, paid: doc.exists ? (doc.data().paid || {}) : {} });
}));

/* =========================
   EA PASS-THROUGH (with 60s cache)
========================= */
const EA_CACHE = new Map(); // key: clubId, value: { ts, data }
const EA_TTL_MS = 60 * 1000;

app.get('/api/teams/:clubId/players', wrap(async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(clubId)) return res.json({ members: [] }); // manual clubs are strings

  const cached = EA_CACHE.get(clubId);
  const now = Date.now();
  if (cached && now - cached.ts < EA_TTL_MS) {
    return res.json(cached.data);
  }

  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  const Controller = AbortControllerPoly || AbortController;
  const controller = new Controller();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetchFn(url, { headers:{'User-Agent':'Mozilla/5.0', 'Accept':'application/json'}, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return res.status(response.status).json({ error:`EA API error: ${response.statusText}` });
    const data = await response.json();
    // normalize: ensure members array exists
    const out = Array.isArray(data?.members) ? data : { members: [] };
    EA_CACHE.set(clubId, { ts: now, data: out });
    res.json(out);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'EA API timed out' });
    console.error('EA fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch players from EA API' });
  }
}));

/* =========================
   SQUAD SLOTS (with batched hydration)
========================= */
// Bootstrap S01..S15 (admin)
app.post('/api/clubs/:clubId/squad/bootstrap', requireAdmin, wrap(async (req, res) => {
  const { clubId } = req.params;
  const size = Math.max(1, Math.min(30, Number(req.body?.size || 15)));
  const batch = db.batch();
  for (let i=1;i<=size;i++){
    const slotId = `S${String(i).padStart(2,'0')}`;
    batch.set(COL.clubSquadSlots(clubId).doc(slotId), {
      slotId, clubId, label: `Slot ${i}`, playerId: '', createdAt: Date.now()
    }, { merge: false });
  }
  await batch.commit();
  res.json({ ok:true, created:size });
}));

// List squad (hydrated with batched player fetches)
app.get('/api/clubs/:clubId/squad', wrap(async (req, res) => {
  const { clubId } = req.params;
  const snap = await COL.clubSquadSlots(clubId).orderBy('slotId').get();
  const slots = snap.docs.map(d => d.data());
  const ids = Array.from(new Set(slots.map(s=>s.playerId).filter(Boolean)));
  const chunks = []; // Firestore 'in' supports up to 10 ids
  for (let i=0;i<ids.length;i+=10) chunks.push(ids.slice(i, i+10));

  const playersMap = new Map();
  for (const ch of chunks) {
    const q = await COL.players().where(FieldPath.documentId(), 'in', ch).get();
    q.docs.forEach(p => playersMap.set(p.id, p.data()));
  }

  const hydrated = slots.map(s => ({ ...s, player: s.playerId ? (playersMap.get(s.playerId) || null) : null }));
  res.json({ clubId, slots: hydrated });
}));

// Assign a username to a slot (create player if needed)
app.post('/api/clubs/:clubId/squad/slots/:slotId/assign', requireManagerOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId, slotId } = req.params;
  let { playerId, eaName='', platform='ps', aliases=[] } = req.body || {};
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

// Unassign / Rename slot
app.post('/api/clubs/:clubId/squad/slots/:slotId/unassign', requireManagerOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId, slotId } = req.params;
  await COL.clubSquadSlots(clubId).doc(slotId).set({ playerId:'' }, { merge:true });
  res.json({ ok:true });
}));
app.patch('/api/clubs/:clubId/squad/slots/:slotId', requireManagerOfClubParam('clubId'), wrap(async (req,res)=>{
  const { clubId, slotId } = req.params;
  const patch = {};
  if (req.body?.label) patch.label = String(req.body.label);
  await COL.clubSquadSlots(clubId).doc(slotId).set(patch, { merge:true });
  res.json({ ok:true });
}));

/* =========================
   PLAYER REGISTRY (EA usernames + aliases)
========================= */
app.post('/api/players/register', wrap(async (req, res) => {
  const { eaName, platform='ps', aliases=[] } = req.body || {};
  if (!eaName) return res.status(400).json({ error:'eaName required' });
  const id = uuidv4();
  const aliasArr = Array.isArray(aliases) ? aliases : String(aliases).split(',').map(s=>s.trim()).filter(Boolean);
  const search = [eaName, ...aliasArr].map(norm);
  const doc = { id, eaName:String(eaName).trim(), platform, aliases:aliasArr, search, createdAt: Date.now() };
  await COL.players().doc(id).set(doc);
  res.json({ ok:true, player: doc });
}));
app.post('/api/players/:playerId/update', requireAdmin, wrap(async (req, res) => {
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

/* =========================
   NAME → ID RESOLUTION
========================= */
async function resolvePlayerIdByName(name, clubId){
  const n = norm(name);
  if (!n) return null;

  // 1) Prefer the club's assigned slots
  const snap = await COL.clubSquadSlots(clubId).get();
  for (const d of snap.docs){
    const slot = d.data();
    if (!slot.playerId) continue;
    const p = await COL.players().doc(slot.playerId).get();
    if (p.exists) {
      const pr = p.data();
      if ((pr.search||[]).includes(n)) return pr.id;
    }
  }
  // 2) Fallback global alias match
  const q = await COL.players().where('search','array-contains', n).limit(1).get();
  if (!q.empty) return q.docs[0].data().id;

  return null;
}

/* =========================
   PLAYER STATS (per season)
========================= */
async function bumpPlayerStatsFromFixture(f){
  const season = seasonKey();
  for (const side of ['home','away']){
    for (const r of (f.details?.[side]||[])){
      if (!r.playerId) continue; // only counted when resolved
      const id = `${season}_${r.playerId}`;
      const ref = COL.playerStats().doc(id);
      await ref.set({
        season, playerId:r.playerId,
        goals: FieldValue.increment(Number(r.goals||0)),
        assists: FieldValue.increment(Number(r.assists||0)),
        ratingsSum: FieldValue.increment(Number(r.rating||0)),
        ratingsCount: FieldValue.increment(r.rating ? 1 : 0),
      }, { merge:true });
    }
  }
}

/* =========================
   UPCL & OTHER FIXTURES
========================= */
// Create fixture (Admin). Use cup ids: "UPCL" (league cup), "UPCL_CC_2025_08" (Champions Cup), etc.
app.post('/api/cup/fixtures', requireAdmin, wrap(async (req, res) => {
  const { home, away, round, cup = 'UPCL', group=null, when=null } = req.body || {};
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });
  if (home === away)   return res.status(400).json({ error: 'home and away cannot match' });

  const id = uuidv4();
  const fixture = {
    id, cup,
    group: group ? String(group) : null,
    round: String(round || 'Round'),
    home: String(home), away: String(away),
    teams: [String(home), String(away)],
    status: when ? 'scheduled' : 'pending', // pending | scheduled | final
    timeLockedAt: when ? Date.now() : null,
    proposals: [],              // [{ at:number, by:string }]
    votes: {},                  // { "<timestamp>": { [clubId]: true|false } }
    when: when ? Number(when) : null, // locked time (ms)
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

// Public sanitized feed
app.get('/api/cup/fixtures/public', wrap(async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const snap = await COL.fixtures().where('cup','==',cup).get();
  const list = snap.docs.map(d => {
    const f = d.data();
    return {
      id: f.id, cup: f.cup, round: f.round, group: f.group||null,
      home: f.home, away: f.away,
      when: f.when || null, status: f.status,
      score: f.score || { hs: 0, as: 0 },
      details: f.details || { home: [], away: [] },
      createdAt: f.createdAt || 0
    };
  });
  res.json({ fixtures: list });
}));

// Scheduling feed (Managers/Admins)
app.get('/api/cup/fixtures/scheduling', requireManagerOrAdmin, wrap(async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const snap = await COL.fixtures().where('cup', '==', cup).get();
  res.json({ fixtures: snap.docs.map(d => d.data()) });
}));

// List (compat) + filter by club
app.get('/api/cup/fixtures', wrap(async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const clubId = (req.query.clubId || '').trim();
  const snap = await COL.fixtures().where('cup','==',cup).get();
  let fixtures = snap.docs.map(d => d.data());
  if (clubId) fixtures = fixtures.filter(f => f.home === clubId || f.away === clubId);
  res.json({ fixtures });
}));

// Get single fixture
app.get('/api/cup/fixtures/:id', wrap(async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  res.json({ fixture: f });
}));

// Propose time (Managers/Admin)
app.post('/api/cup/fixtures/:id/propose', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  const at = Number(req.body?.at || 0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });
  const isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  f.proposals = f.proposals || [];
  f.votes = f.votes || {};
  if (!f.proposals.some(p=>Number(p.at)===at)) f.proposals.push({ at, by: isAdmin ? 'admin' : me(req).teamId });
  f.votes[String(at)] = f.votes[String(at)] || {};
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// Vote (Managers/Admin)
app.post('/api/cup/fixtures/:id/vote', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  const at = String(req.body?.at || '');
  const agree = !!req.body?.agree;
  if (!at) return res.status(400).json({ error:'invalid slot' });

  const isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const teamId = isAdmin ? 'admin' : me(req).teamId;
  f.votes = f.votes || {};
  f.votes[at] = f.votes[at] || {};
  f.votes[at][teamId] = agree;

  if (f.votes[at][f.home] === true && f.votes[at][f.away] === true) {
    f.when = Number(at);
    f.status = 'scheduled';
    f.timeLockedAt = Date.now();
  }
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// Set lineup (Managers/Admin)
app.put('/api/cup/fixtures/:id/lineup', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  const isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const { formation, lineup } = req.body || {};
  f.lineups = f.lineups || {};
  const owner = isAdmin ? 'admin' : me(req).teamId;
  f.lineups[owner] = { formation: String(formation||''), lineup: lineup && typeof lineup==='object' ? lineup : {} , at: Date.now() };
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// Report final (Admin OR managers). Accepts playerId OR player (username)
app.post('/api/cup/fixtures/:id/report', wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });

  const isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) {
    return res.status(403).json({ error: 'Managers of these clubs only (or admin)' });
  }

  const { hs, as, text, mvpHome, mvpAway, discordMsgUrl, details } = req.body || {};
  f.score  = { hs: Number(hs||0), as: Number(as||0) };
  f.report = { text: String(text||''), mvpHome: String(mvpHome||''), mvpAway: String(mvpAway||''), discordMsgUrl: String(discordMsgUrl||'') };
  if (details && typeof details === 'object') {
    f.details = { home: [], away: [] };
    f.unresolved = [];
    for (const side of ['home','away']){
      for (const row of (details[side]||[])){
        let { playerId, player, goals=0, assists=0, rating=0 } = row || {};
        if (!playerId && player){
          playerId = await resolvePlayerIdByName(player, side==='home' ? f.home : f.away);
        }
        const item = { playerId: playerId||'', player: player||'', goals:Number(goals||0), assists:Number(assists||0), rating:Number(rating||0) };
        f.details[side].push(item);
        if (!playerId && player) f.unresolved.push({ side, name: player });
      }
    }
  }
  f.status = 'final';
  if (!f.when) f.when = Date.now();

  await setDoc('fixtures', f.id, f);
  await bumpPlayerStatsFromFixture(f);
  res.json({ ok: true, fixture: f });
}));

// Admin paste: parse quick text -> score + scorers
app.post('/api/cup/fixtures/:id/ingest-text', requireAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  const parsed = parseLooseResultText(text, f);
  if (!parsed) return res.status(400).json({ error: 'could not parse input' });

  // resolve names to ids
  const out = { home: [], away: [] }, unresolved = [];
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
  await bumpPlayerStatsFromFixture(f);
  res.json({ ok: true, fixture: f });
}));

// Tolerant parser for "quick text" format
function parseLooseResultText(str, f) {
  const toks = String(str).replace(/\n/g, ',').split(',').map(s => s.trim()).filter(Boolean);
  let side = 'home';
  const details = { home: [], away: [] };
  const score = { hs: 0, as: 0 };
  let cur = null;
  const commit = () => {
    if (cur && cur.player) {
      cur.goals = Number(cur.goals || 0);
      cur.assists = Number(cur.assists || 0);
      cur.rating = Number(cur.rating || 0);
      details[side].push(cur);
    }
    cur = null;
  };
  for (let t of toks) {
    const low = t.toLowerCase();

    // side switching hints
    if (low.includes('home')) { commit(); side='home'; continue; }
    if (low.includes('away')) { commit(); side='away'; continue; }

    let m = t.match(/(\d+)\s*[-–]\s*(\d+)/); // "3-1"
    if (m) { score.hs = Number(m[1]); score.as = Number(m[2]); continue; }

    m = t.match(/score\s*:\s*(\d+)/i);
    if (m) { if (side==='home') score.hs = Number(m[1]); else score.as = Number(m[1]); continue; }

    m = t.match(/player\s*\d*\s*:\s*(.+)/i);
    if (m) { commit(); cur = { player: m[1].trim() }; continue; }

    m = t.match(/(\d+)\s*goal/i); if (m) { cur = cur || {}; cur.goals = Number(m[1]); continue; }
    m = t.match(/(\d+)\s*assist/i); if (m) { cur = cur || {}; cur.assists = Number(m[1]); continue; }
    m = t.match(/rating\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (m) { cur = cur || {}; cur.rating = Number(m[1]); continue; }

    if (!cur || !cur.player) {
      if (t && !/^\d+(\.\d+)?$/.test(t) && !/^(score|rating|goal|assist)/i.test(t)) {
        cur = cur || {};
        cur.player = (cur.player || t);
      }
    }
  }
  commit();
  return { score, details };
}

/* =========================
   CHAMPIONS CUP (Groups A–D)
========================= */
app.post('/api/champions/:cupId/groups', requireAdmin, wrap(async (req,res)=>{
  const { cupId } = req.params;
  const groups = req.body?.groups || {};
  const doc = { cupId, groups:{ A:groups.A||[], B:groups.B||[], C:groups.C||[], D:groups.D||[] }, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

app.post('/api/champions/:cupId/randomize', requireAdmin, wrap(async (req,res)=>{
  const { cupId } = req.params;
  let clubs = Array.isArray(req.body?.clubs) ? req.body.clubs.slice() : [];
  if (clubs.length!==16) return res.status(400).json({ error:'Provide exactly 16 clubIds in body.clubs' });
  shuffle(clubs);
  const groups = { A:[], B:[], C:[], D:[] };
  clubs.forEach((id,i)=> groups[['A','B','C','D'][i%4]].push(String(id)));
  const doc = { cupId, groups, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

async function computeGroupTables(cupId, groups){
  const snap = await COL.fixtures().where('cup','==',cupId).get();
  const fx = snap.docs.map(d=>d.data()).filter(f=>f.status==='final');
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
    sorted[g] = Object.values(table[g]).sort((x,y)=>
      (y.Pts-x.Pts) || (y.GD-x.GD) || (y.GF - x.GF));
  }
  return sorted;
}

app.get('/api/champions/:cupId', wrap(async (req,res)=>{
  const { cupId } = req.params;
  const snap = await COL.champions().doc(cupId).get();
  const cup = snap.exists ? snap.data() : { cupId, groups:{A:[],B:[],C:[],D:[]}, createdAt: Date.now() };
  const tables = await computeGroupTables(cupId, cup.groups);
  res.json({ ok:true, cup, tables });
}));

/* =========================
   ERROR HANDLING
========================= */
app.use((err, _req, res, _next)=>{
  const code = err.status || 500;
  if (NODE_ENV !== 'test') console.error(err);
  res.status(code).json({ error: err.message || 'Server error' });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (env: ${NODE_ENV})`);
  console.log(`Firestore project: ${admin.app().options.projectId || '(loaded)'}`);
});
