// server.js — Pro Clubs League backend (Firestore)
// Removed EA dependency (returns empty members), added dynamic News generation (hattrick, finals, streaks),
// JSON/quick-paste ingest, Champions Cup, squads, rankings, wallets, free agents.

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Optional middlewares (used if installed)
let helmet = null, compression = null, cors = null, morgan = null;
try { helmet = require('helmet'); } catch (e) {}
try { compression = require('compression'); } catch (e) {}
try { cors = require('cors'); } catch (e) {}
try { morgan = require('morgan'); } catch (e) {}

// Node 18+ has global fetch; fallback if needed (not used, but left here if you add remote calls)
const fetchFn = global.fetch || (function(){ return (...a) => import('node-fetch').then(m => m.default(...a)); })();

/* =========================
   FIREBASE ADMIN INIT
========================= */
const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required (paste the service account JSON).');
}
const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (svc.private_key && svc.private_key.indexOf('\\n') !== -1) {
  svc.private_key = svc.private_key.replace(/\\n/g, '\n');
}
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const FieldPath  = admin.firestore.FieldPath;

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// No numeric separators (for older Node)
const PAYOUTS = {
  elite : Number(process.env.PAYOUT_ELITE  || 1100000),
  mid   : Number(process.env.PAYOUT_MID    || 900000),
  bottom: Number(process.env.PAYOUT_BOTTOM || 700000),
};
const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || 10000000);

// Manager session lifetime (hours)
const MANAGER_SESSION_HOURS = Number(process.env.MANAGER_SESSION_HOURS || 12);

const CUP_BONUSES = {
  winner:       6000000,
  runner_up:    3600000,
  semifinal:    2000000,
  quarterfinal: 1200000,
  round_of_16:  600000,
  none:         0,
  participation:150000,
};
const CUP_POINTS = { winner:60, runner_up:40, semifinal:25, quarterfinal:15, round_of_16:10, none:0 };

/* =========================
   EXPRESS APP
========================= */
const app = express();
app.set('trust proxy', 1);

if (helmet) app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
if (cors) app.use(cors({ origin: true, credentials: true }));
if (compression) app.use(compression());
app.use(express.json({ limit: '1mb' }));
if (morgan) app.use(morgan(isProd ? 'combined' : 'dev')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*30 } // 30d
}));

// Static site
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', function(_req, res){ res.sendFile(path.join(__dirname, 'public', 'teams.html')); });

/* =========================
   HELPERS / COLLECTIONS
========================= */
const COL = {
  rankings    : function(){ return db.collection('rankings'); },     // docId = clubId
  wallets     : function(){ return db.collection('wallets'); },      // docId = clubId
  awards      : function(){ return db.collection('cupAwards'); },    // docId = season
  users       : function(){ return db.collection('users'); },        // docId = userId
  clubCodes   : function(){ return db.collection('clubCodes'); },    // docId = clubId { hash, rotatedAt, lastUsedAt? }
  fixtures    : function(){ return db.collection('fixtures'); },     // docId = fixtureId
  freeAgents  : function(){ return db.collection('freeAgents'); },   // docId = userId
  players     : function(){ return db.collection('players'); },      // docId = playerId
  clubSquadSlots: function(clubId){ return db.collection('clubSquads').doc(clubId).collection('slots'); },
  playerStats : function(){ return db.collection('playerStats'); },  // docId = `${season}_${playerId}`
  champions   : function(){ return db.collection('champions'); },    // docId = cupId
  news        : function(){ return db.collection('news'); },         // docId = newsId
};

function wrap(fn){ return function(req,res,next){ return Promise.resolve(fn(req,res,next)).catch(next); }; }
async function getDoc(col, id){ var s = await COL[col]().doc(id).get(); return s.exists ? s.data() : null; }
async function setDoc(col, id, obj){ await COL[col]().doc(id).set(obj, { merge:false }); return obj; }
async function updateDoc(col, id, patch){ await COL[col]().doc(id).set(patch, { merge:true }); }
async function listAll(col){ var snap = await COL[col]().get(); return snap.docs.map(function(d){ return { id:d.id, data:d.data() }; }); }

function isAdminSession(req) { return req.session && req.session.admin === true; }
function me(req){ return (req.session && req.session.user) ? req.session.user : null; }

// Manager session validity
function isManagerActive(req){
  var u = me(req);
  if (!u || u.role !== 'Manager') return false;
  return (req.session.managerExpiresAt || 0) > Date.now();
}

// Only expose active sessions to client
function userForClient(req){
  var u = me(req);
  if (!u) return null;
  if (u.role === 'Manager' && !isManagerActive(req)) return null;
  return u;
}

// Middleware
function requireAdmin(req,res,next){
  if (isAdminSession(req)) return next();
  return res.status(403).json({ error:'Admin only' });
}
function requireManagerOfClubParam(param){
  var p = param || 'clubId';
  return function(req, res, next){
    var u = me(req);
    if (!(u && u.role==='Manager' && isManagerActive(req) && String(u.teamId)===String(req.params[p]))) {
      return res.status(403).json({ error: 'Manager of this club only' });
    }
    next();
  };
}
function requireManagerOrAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  var u = me(req);
  if (u && u.role === 'Manager' && isManagerActive(req)) return next();
  return res.status(403).json({ error: 'Managers or Admins only' });
}
function requirePlayerOrActiveManager(req,res,next){
  var u = me(req);
  if (!u) return res.status(403).json({ error:'Players or Managers only' });
  if (u.role==='Player') return next();
  if (u.role==='Manager' && isManagerActive(req)) return next();
  return res.status(403).json({ error:'Players or active Managers only' });
}
function managerOwnsFixture(req, f) {
  var u = me(req);
  return !!(u && u.role==='Manager' && isManagerActive(req) && (f.home===u.teamId || f.away===u.teamId));
}

// utils
function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayoutLocal(ranking){ var tier=(ranking && ranking.tier) ? ranking.tier : 'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }
function genCode(len){ var L=len||8; var chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; var out=''; for(var i=0;i<L;i++){ out+=chars[Math.floor(Math.random()*chars.length)]; } return out; }
function seasonKey(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function shuffle(a){ for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var tmp=a[i]; a[i]=a[j]; a[j]=tmp; } return a; }
function nameKey(s){ return norm(s); }

/* =========================
   AUTH (Admin + Session User)
========================= */
if (!ADMIN_PASSWORD) console.warn('[WARN] ADMIN_PASSWORD not set — admin login will fail until you set it.');

app.post('/api/admin/login', wrap(async function(req, res){
  var password = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Bad password' });
  req.session.admin = true;
  res.json({ ok:true });
}));
app.post('/api/admin/logout', function(req, res){ req.session.admin = false; res.json({ ok:true }); });
app.get('/api/admin/me', function(req, res){ res.json({ admin: isAdminSession(req) }); });

app.get('/api/auth/me', function(req, res){ res.json({ user: userForClient(req) }); });
app.post('/api/auth/logout', function(req,res){ req.session.destroy(function(){ res.json({ ok:true }); }); });

/* =========================
   MANAGER CODES (Session login; no "claimedBy")
========================= */
// Rotate one code (admin)
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, wrap(async function(req, res){
  var clubId = req.params.clubId;
  var code = genCode(8);
  var hash = await bcrypt.hash(code, 10);
  await setDoc('clubCodes', clubId, { hash: hash, rotatedAt: Date.now() });
  res.json({ ok:true, clubId: clubId, code: code });
}));

// Bulk rotate (admin)
app.post('/api/admin/manager-codes/rotate-all', requireAdmin, wrap(async function(req,res){
  var clubs = Array.isArray(req.body && req.body.clubs) ? req.body.clubs.map(String) : [];
  if (!clubs.length) return res.status(400).json({ error:'body.clubs array required' });
  var items = [];
  for (var i=0;i<clubs.length;i++){
    var clubId = clubs[i];
    var code = genCode(8);
    var hash = await bcrypt.hash(code, 10);
    await setDoc('clubCodes', clubId, { hash: hash, rotatedAt: Date.now() });
    items.push({ clubId: clubId, code: code });
  }
  var csv = 'clubId,code\n' + items.map(function(x){ return x.clubId+','+x.code; }).join('\n');
  res.json({ ok:true, count: items.length, items: items, csv: csv });
}));

// Export status (no plaintext codes)
app.get('/api/admin/manager-codes/export', requireAdmin, wrap(async function(_req,res){
  var snap = await COL.clubCodes().get();
  var rows = snap.docs.map(function(d){
    var x = d.data();
    return { clubId:d.id, hasCode: !!(x && x.hash), rotatedAt: (x && x.rotatedAt) || 0, lastUsedAt: (x && x.lastUsedAt) || 0 };
  });
  var csv = 'clubId,hasCode,rotatedAt,lastUsedAt\n' + rows.map(function(r){ return [r.clubId,r.hasCode,r.rotatedAt,r.lastUsedAt].join(','); }).join('\n');
  res.json({ ok:true, count: rows.length, csv: csv, rows: rows });
}));

// Session-based manager login (use every visit)
app.post('/api/clubs/:clubId/claim-manager', wrap(async function(req,res){
  var clubId = req.params.clubId;
  var body = req.body || {};
  var name = body.name, code = body.code;
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });

  var rec = await getDoc('clubCodes', clubId);
  if (!rec || !rec.hash) return res.status(400).json({ error: 'No manager code set. Ask admin.' });

  var ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error: 'Invalid code' });

  req.session.user = {
    id: uuidv4(), // ephemeral id per session
    name: String(name).trim(),
    role: 'Manager',
    teamId: String(clubId),
  };
  req.session.managerExpiresAt = Date.now() + MANAGER_SESSION_HOURS * 60 * 60 * 1000;
  await updateDoc('clubCodes', clubId, { lastUsedAt: Date.now() });

  res.json({ ok:true, user: userForClient(req), expiresAt: req.session.managerExpiresAt });
}));

/* =========================
   PLAYER ROLE + FREE AGENTS
========================= */
app.post('/api/players/claim', wrap(async function(req, res){
  var body = req.body || {};
  var name = body.name;
  var teamId = String(body.teamId || '');
  if (!name) return res.status(400).json({ error: 'name required' });
  var id = uuidv4();
  var user = { id: id, name: String(name).trim(), role: 'Player', teamId: teamId };
  await setDoc('users', id, user);
  req.session.user = user;
  res.json({ ok: true, user: user });
}));

app.get('/api/free-agents', wrap(async function(_req, res){
  var snap = await COL.freeAgents().orderBy('listedAt', 'desc').get();
  res.json({ agents: snap.docs.map(function(d){ return d.data(); }) });
}));
app.post('/api/free-agents/me', requirePlayerOrActiveManager, wrap(async function(req, res){
  var u = me(req);
  var b = req.body || {};
  var positions = Array.isArray(b.positions) ? b.positions : String(b.positions || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var doc = {
    id: u.id,
    name: u.name,
    role: u.role,
    teamId: u.teamId || '',
    positions: positions,
    foot: String(b.foot || ''),
    region: String(b.region || ''),
    bio: String(b.bio || ''),
    availability: String(b.availability || ''),
    discord: String(b.discord || ''),
    lookingFor: String(b.lookingFor || ''),
    listedAt: Date.now()
  };
  await COL.freeAgents().doc(u.id).set(doc);
  res.json({ ok: true, agent: doc });
}));
app.delete('/api/free-agents/me', requirePlayerOrActiveManager, wrap(async function(req, res){
  var u = me(req);
  await COL.freeAgents().doc(u.id).delete();
  res.json({ ok: true });
}));

/* =========================
   RANKINGS / PAYOUTS / WALLETS
========================= */
app.get('/api/rankings', wrap(async function(_req,res){
  var all = await listAll('rankings');
  var map = {};
  for (var i=0;i<all.length;i++){
    var r = all[i];
    var data = r.data || r; // be tolerant if listAll shape changes
    var id = r.id || data.id;
    map[id] = { leaguePos:(data.leaguePos||''), cup:(data.cup||'none'), points:(data.points||0), tier:(data.tier||'mid') };
  }
  res.json({ rankings: map, payouts: PAYOUTS, cupPoints: CUP_POINTS });
}));

app.post('/api/rankings/bulk', requireAdmin, wrap(async function(req,res){
  var payload = (req.body && req.body.rankings) || {};
  var ops = [];
  var clubIds = Object.keys(payload);
  for (var i=0;i<clubIds.length;i++){
    var clubId = clubIds[i];
    var src = payload[clubId] || {};
    var leaguePos = Number(src.leaguePos || 0);
    var cup = String(src.cup || 'none');
    var tier = src.tier || 'mid';
    var points = leaguePoints(leaguePos) + (CUP_POINTS[cup] || 0);
    if (!src.tier) tier = tierFromPoints(points);
    ops.push(setDoc('rankings', clubId, { leaguePos: leaguePos, cup: cup, points: points, tier: tier }));
  }
  await Promise.all(ops);
  res.json({ ok:true });
}));

app.post('/api/rankings/recalc', requireAdmin, wrap(async function(_req,res){
  var all = await listAll('rankings');
  await Promise.all(all.map(function(rRow){
    var r = rRow.data || rRow;
    var id = rRow.id || r.id;
    var points = leaguePoints(r.leaguePos||0) + (CUP_POINTS[r.cup||'none']||0);
    var tier = tierFromPoints(points);
    return setDoc('rankings', id, { leaguePos:r.leaguePos||0, cup:r.cup||'none', points:points, tier:tier });
  }));
  res.json({ ok:true });
}));

// Wallet helpers
async function ensureWallet(clubId){
  var ref = COL.wallets().doc(clubId);
  var snap = await ref.get();
  if (!snap.exists) {
    var doc = { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86400000 };
    await ref.set(doc);
    return doc;
  }
  return snap.data();
}
async function getRanking(clubId){
  var r = await getDoc('rankings', clubId);
  return r || { leaguePos:'', cup:'none', points:0, tier:'mid' };
}
async function collectPreview(clubId){
  var w = await ensureWallet(clubId);
  var r = await getRanking(clubId);
  var perDay = getDailyPayoutLocal(r);
  var days = Math.floor((Date.now() - (w.lastCollectedAt || 0)) / 86400000);
  return { days: days, perDay: perDay, amount: Math.max(0, days * perDay) };
}

// Wallet endpoints
app.get('/api/wallets/:clubId', wrap(async function(req,res){
  var clubId = req.params.clubId;
  var w = await ensureWallet(clubId);
  var preview = await collectPreview(clubId);
  var r = await getRanking(clubId);
  res.json({ wallet: w, preview: preview, perDay: getDailyPayoutLocal(r) });
}));

// Transactional collect to avoid race/double payout
app.post('/api/wallets/:clubId/collect', requireManagerOfClubParam('clubId'), wrap(async function(req,res){
  var clubId = req.params.clubId;
  var result = await db.runTransaction(async function(tx){
    var wRef = COL.wallets().doc(clubId);
    var rRef = COL.rankings().doc(clubId);
    var wSnap = await tx.get(wRef);
    var rSnap = await tx.get(rRef);
    var w = wSnap.exists ? wSnap.data() : { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86400000 };
    var r = rSnap.exists ? rSnap.data() : { tier:'mid' };
    var perDay = getDailyPayoutLocal(r);
    var now = Date.now();
    var days = Math.floor((now - (w.lastCollectedAt || 0)) / 86400000);
    var amount = Math.max(0, days * perDay);
    if (amount <= 0) return { ok:false, message:'No payout available yet' };
    tx.set(wRef, {
      balance: Number(w.balance||0) + amount,
      lastCollectedAt: (w.lastCollectedAt || 0) + days * 86400000
    }, { merge:false });
    return { ok:true, collected: amount };
  });
  var preview = await collectPreview(clubId); // post-tx preview
  res.json({ ok: result.ok, collected: result.collected, message: result.message, preview: preview });
}));

/* =========================
   CUP BONUSES (Admin)
========================= */
app.post('/api/bonuses/cup', requireAdmin, wrap(async function(req,res){
  var dryRun = !!(req.body && req.body.dryRun);
  var season = (((req.body && req.body.season) || '').trim()) || seasonKey();

  var awardsDocRef = COL.awards().doc(season);
  var awardsDoc = await awardsDocRef.get();
  var already = awardsDoc.exists ? (awardsDoc.data().paid || {}) : {};

  var allRankings = await listAll('rankings');
  var willAward = 0, actually = 0;
  var results = [];

  for (var i=0;i<allRankings.length;i++){
    var rRow = allRankings[i];
    var r = rRow.data || rRow;
    var id = rRow.id || r.id;
    var cup = r.cup || 'none';
    var bonus = Number(CUP_BONUSES[cup] || 0);
    var paid = !!already[id];
    results.push({ clubId: id, cup: cup, bonus: bonus, alreadyPaid: paid });
    willAward += bonus;
    if (!dryRun && bonus>0 && !paid){
      await COL.wallets().doc(id).set({
        balance: FieldValue.increment(bonus),
        lastCollectedAt: FieldValue.serverTimestamp()
      }, { merge:true });
      already[id] = bonus;
      actually += bonus;
    }
  }

  if (!dryRun){
    await awardsDocRef.set({ paid: already }, { merge:false });
  }
  res.json({ ok:true, season: season, dryRun: dryRun, totalAwarded: dryRun ? willAward : actually, results: results });
}));
app.get('/api/bonuses/cup', requireAdmin, wrap(async function(req,res){
  var season = (((req.query && req.query.season) || '').trim()) || seasonKey();
  var doc = await COL.awards().doc(season).get();
  res.json({ ok:true, season: season, paid: doc.exists ? (doc.data().paid || {}) : {} });
}));

/* =========================
   SQUAD SLOTS (with batched hydration)
========================= */
// Bootstrap S01..S15 (admin)
app.post('/api/clubs/:clubId/squad/bootstrap', requireAdmin, wrap(async function(req, res){
  var clubId = req.params.clubId;
  var size = Math.max(1, Math.min(30, Number((req.body && req.body.size) || 15)));
  var batch = db.batch();
  for (var i=1;i<=size;i++){
    var slotId = 'S' + String(i).padStart(2,'0');
    batch.set(COL.clubSquadSlots(clubId).doc(slotId), {
      slotId: slotId, clubId: clubId, label: 'Slot ' + i, playerId: '', createdAt: Date.now()
    }, { merge: false });
  }
  await batch.commit();
  res.json({ ok:true, created:size });
}));

// List squad (hydrated with batched player fetches)
app.get('/api/clubs/:clubId/squad', wrap(async function(req, res){
  var clubId = req.params.clubId;
  var snap = await COL.clubSquadSlots(clubId).orderBy('slotId').get();
  var slots = snap.docs.map(function(d){ return d.data(); });
  var ids = Array.from(new Set(slots.map(function(s){ return s.playerId; }).filter(Boolean)));
  var chunks = [];
  for (var i=0;i<ids.length;i+=10) chunks.push(ids.slice(i, i+10));

  var playersMap = new Map();
  for (var c=0;c<chunks.length;c++) {
    var ch = chunks[c];
    var q = await COL.players().where(FieldPath.documentId(), 'in', ch).get();
    q.docs.forEach(function(p){ playersMap.set(p.id, p.data()); });
  }
  var hydrated = slots.map(function(s){
    return Object.assign({}, s, { player: s.playerId ? (playersMap.get(s.playerId) || null) : null });
  });
  res.json({ clubId: clubId, slots: hydrated });
}));

// Assign a username to a slot (create player if needed)
app.post('/api/clubs/:clubId/squad/slots/:slotId/assign', requireManagerOfClubParam('clubId'), wrap(async function(req,res){
  var clubId = req.params.clubId;
  var slotId = req.params.slotId;
  var b = req.body || {};
  var playerId = b.playerId;
  var eaName = b.eaName || '';
  var platform = b.platform || 'ps';
  var aliases = b.aliases || [];
  if (!playerId && !eaName) return res.status(400).json({ error:'playerId or eaName required' });

  if (!playerId){
    var id = uuidv4();
    var aliasArr = Array.isArray(aliases) ? aliases : String(aliases).split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var search = [eaName].concat(aliasArr).map(norm);
    await COL.players().doc(id).set({ id: id, eaName: String(eaName).trim(), platform: platform, aliases: aliasArr, search: search, createdAt: Date.now() });
    playerId = id;
  }
  await COL.clubSquadSlots(clubId).doc(slotId).set({ playerId: playerId }, { merge:true });
  var slot = (await COL.clubSquadSlots(clubId).doc(slotId).get()).data();
  res.json({ ok:true, slot: slot });
}));

// Unassign / Rename slot
app.post('/api/clubs/:clubId/squad/slots/:slotId/unassign', requireManagerOfClubParam('clubId'), wrap(async function(req,res){
  var clubId = req.params.clubId;
  var slotId = req.params.slotId;
  await COL.clubSquadSlots(clubId).doc(slotId).set({ playerId:'' }, { merge:true });
  res.json({ ok:true });
}));
app.patch('/api/clubs/:clubId/squad/slots/:slotId', requireManagerOfClubParam('clubId'), wrap(async function(req,res){
  var clubId = req.params.clubId;
  var slotId = req.params.slotId;
  var patch = {};
  if (req.body && req.body.label) patch.label = String(req.body.label);
  await COL.clubSquadSlots(clubId).doc(slotId).set(patch, { merge:true });
  res.json({ ok:true });
}));

/* =========================
   PLAYER REGISTRY
========================= */
app.post('/api/players/register', wrap(async function(req, res){
  var b = req.body || {};
  var eaName = b.eaName;
  var platform = b.platform || 'ps';
  var aliases = b.aliases || [];
  if (!eaName) return res.status(400).json({ error:'eaName required' });
  var id = uuidv4();
  var aliasArr = Array.isArray(aliases) ? aliases : String(aliases).split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var search = [eaName].concat(aliasArr).map(norm);
  var doc = { id: id, eaName:String(eaName).trim(), platform: platform, aliases: aliasArr, search: search, createdAt: Date.now() };
  await COL.players().doc(id).set(doc);
  res.json({ ok:true, player: doc });
}));
app.post('/api/players/:playerId/update', requireAdmin, wrap(async function(req, res){
  var playerId = req.params.playerId;
  var patch = req.body || {};
  if ((patch && patch.eaName) || (patch && patch.aliases)){
    var aliasArr = Array.isArray(patch.aliases) ? patch.aliases : String(patch.aliases||'').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var base = patch.eaName ? String(patch.eaName).trim() : null;
    var searchArr = [];
    if (base) searchArr.push(base);
    searchArr = searchArr.concat(aliasArr).map(norm);
    patch.search = searchArr;
    patch.aliases = aliasArr;
    if (base) patch.eaName = base;
  }
  await COL.players().doc(playerId).set(patch, { merge:true });
  var doc = await COL.players().doc(playerId).get();
  res.json({ ok:true, player: doc.data() });
}));

/* =========================
   NAME → ID RESOLUTION
========================= */
async function resolvePlayerIdByName(name, clubId){
  var n = norm(name);
  if (!n) return null;

  // Prefer the club's assigned slots
  var snap = await COL.clubSquadSlots(clubId).get();
  for (var i=0;i<snap.docs.length;i++){
    var d = snap.docs[i];
    var slot = d.data();
    if (!slot.playerId) continue;
    var p = await COL.players().doc(slot.playerId).get();
    if (p.exists) {
      var pr = p.data();
      var search = pr.search || [];
      if (search.indexOf(n) !== -1) return pr.id;
    }
  }
  // Fallback global alias match
  var q = await COL.players().where('search','array-contains', n).limit(1).get();
  if (!q.empty) return q.docs[0].data().id;

  return null;
}

/* =========================
   PLAYER STATS (per season)
========================= */
async function bumpPlayerStatsFromFixture(f){
  var season = seasonKey();
  var sides = ['home','away'];
  for (var s=0;s<sides.length;s++){
    var side = sides[s];
    var detSide = (f.details && f.details[side]) ? f.details[side] : [];
    for (var rIdx=0;rIdx<detSide.length;rIdx++){
      var r = detSide[rIdx];
      if (!r.playerId) continue;
      var id = season + '_' + r.playerId;
      var ref = COL.playerStats().doc(id);
      await ref.set({
        season: season, playerId: r.playerId,
        goals: FieldValue.increment(Number(r.goals||0)),
        assists: FieldValue.increment(Number(r.assists||0)),
        ratingsSum: FieldValue.increment(Number(r.rating||0)),
        ratingsCount: FieldValue.increment(r.rating ? 1 : 0),
        lastUpdatedAt: Date.now()
      }, { merge:true });
    }
  }
}

/* =========================
   FIXTURES
========================= */
// Create fixture (Admin). Use cup ids: "UPCL" (league cup) or "UPCL_CC_YYYY_MM" (Champions)
app.post('/api/cup/fixtures', requireAdmin, wrap(async function(req, res){
  var b = req.body || {};
  var home = b.home, away = b.away, round = b.round, cup = (b.cup || 'UPCL'), group = b.group || null, when = b.when || null;
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });
  if (home === away)   return res.status(400).json({ error: 'home and away cannot match' });

  var id = uuidv4();
  var fixture = {
    id: id, cup: String(cup),
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
  res.json({ ok:true, fixture: fixture });
}));

// Public sanitized feed (optionally include lineups with ?includeLineups=1)
app.get('/api/cup/fixtures/public', wrap(async function(req, res){
  var cup = ((req.query && req.query.cup) || 'UPCL').trim();
  var includeLineups = String((req.query && req.query.includeLineups) || '0') === '1';
  var snap = await COL.fixtures().where('cup','==',cup).get();
  var list = snap.docs.map(function(d){
    var f = d.data();
    var base = {
      id: f.id, cup: f.cup, round: f.round, group: f.group || null,
      home: f.home, away: f.away,
      when: f.when || null, status: f.status,
      score: f.score || { hs: 0, as: 0 },
      details: f.details || { home: [], away: [] },
      createdAt: f.createdAt || 0
    };
    if (includeLineups) base.lineups = f.lineups || {};
    return base;
  });
  res.json({ fixtures: list });
}));

// Scheduling feed (Managers/Admins)
app.get('/api/cup/fixtures/scheduling', requireManagerOrAdmin, wrap(async function(req, res){
  var cup = ((req.query && req.query.cup) || 'UPCL').trim();
  var snap = await COL.fixtures().where('cup', '==', cup).get();
  res.json({ fixtures: snap.docs.map(function(d){ return d.data(); }) });
}));

// List (compat) + optional filter by club
app.get('/api/cup/fixtures', wrap(async function(req, res){
  var cup = ((req.query && req.query.cup) || 'UPCL').trim();
  var clubId = ((req.query && req.query.clubId) || '').trim();
  var snap = await COL.fixtures().where('cup','==',cup).get();
  var fixtures = snap.docs.map(function(d){ return d.data(); });
  if (clubId) fixtures = fixtures.filter(function(f){ return f.home===clubId || f.away===clubId; });
  res.json({ fixtures: fixtures });
}));

// Get single fixture
app.get('/api/cup/fixtures/:id', wrap(async function(req,res){
  var f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  res.json({ fixture: f });
}));

// Propose time
app.post('/api/cup/fixtures/:id/propose', requireManagerOrAdmin, wrap(async function(req, res){
  var f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  var at = Number((req.body && req.body.at) || 0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });
  var isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  f.proposals = f.proposals || [];
  f.votes = f.votes || {};
  if (!f.proposals.some(function(p){ return Number(p.at)===at; })) f.proposals.push({ at: at, by: isAdmin ? 'admin' : me(req).teamId });
  f.votes[String(at)] = f.votes[String(at)] || {};
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// Vote time
app.post('/api/cup/fixtures/:id/vote', requireManagerOrAdmin, wrap(async function(req, res){
  var f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  var at = String((req.body && req.body.at) || '');
  var agree = !!(req.body && req.body.agree);
  if (!at) return res.status(400).json({ error:'invalid slot' });

  var isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  var teamId = isAdmin ? 'admin' : me(req).teamId;
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

// Set lineup
app.put('/api/cup/fixtures/:id/lineup', requireManagerOrAdmin, wrap(async function(req, res){
  var f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  var isAdmin = isAdminSession(req);
  if (!isAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  var formation = (req.body && req.body.formation) || '';
  var lineup = (req.body && req.body.lineup) || undefined;
  f.lineups = f.lineups || {};
  var owner = isAdmin ? 'admin' : me(req).teamId;
  f.lineups[owner] = { formation: String(formation||''), lineup: (lineup && typeof lineup==='object') ? lineup : {}, at: Date.now() };
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

/* ====== News helpers (dynamic posts) ====== */
async function addNews(item){
  var id = uuidv4();
  var doc = Object.assign({ id: id, ts: Date.now() }, item || {});
  await COL.news().doc(id).set(doc);
  return doc;
}
function playerLabel(r){
  if (r.player) return r.player;
  if (r.playerId) return '#'+String(r.playerId).slice(0,6);
  return 'Unknown';
}
function scoredInFixture(fx, side, pred) {
  var arr = (fx.details && fx.details[side]) ? fx.details[side] : [];
  for (var i=0;i<arr.length;i++){
    if (pred(arr[i])) return true;
  }
  return false;
}
async function previousFinalForClub(cupId, clubId, beforeTs){
  var snap = await COL.fixtures()
    .where('cup','==', cupId)
    .where('status','==','final')
    .where('teams','array-contains', String(clubId))
    .where('when','<', beforeTs)
    .orderBy('when','desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}
async function generateNewsForFixture(f){
  var hs = Number((f.score && f.score.hs) || 0), as = Number((f.score && f.score.as) || 0);
  var title = 'FT ' + hs + '-' + as;
  await addNews({
    type: 'final_score',
    title: title,
    text: 'Full time: ' + f.home + ' vs ' + f.away + ' — ' + hs + '-' + as,
    cup: f.cup,
    clubId: (hs>as ? f.home : (as>hs ? f.away : null)),
    fixtureId: f.id,
    meta: { score: { hs: hs, as: as }, home: f.home, away: f.away }
  });

  var sides = ['home','away'];
  for (var s=0;s<sides.length;s++){
    var side = sides[s];
    var detSide = (f.details && f.details[side]) ? f.details[side] : [];
    for (var i=0;i<detSide.length;i++){
      var r = detSide[i];
      if (Number(r.goals||0) >= 3){
        await addNews({
          type: 'hattrick',
          title: 'Hattrick: ' + playerLabel(r),
          text: playerLabel(r) + ' scored ' + r.goals + ' for ' + (side==='home'?f.home:f.away),
          cup: f.cup,
          clubId: side==='home'?f.home:f.away,
          fixtureId: f.id,
          meta: { playerId: r.playerId||'', player: r.player||'', goals: Number(r.goals||0), score: { hs: hs, as: as } }
        });
      }
    }
  }

  // Consecutive scoring posts
  for (var s2=0;s2<sides.length;s2++){
    var side2 = sides[s2];
    var clubId = side2==='home'?f.home:f.away;
    var prev = await previousFinalForClub(f.cup, clubId, f.when || Date.now());
    if (!prev) continue;
    var currRows = (f.details && f.details[side2]) ? f.details[side2] : [];
    for (var j=0;j<currRows.length;j++){
      var rr = currRows[j];
      if (Number(rr.goals||0) > 0){
        var pid = rr.playerId || '';
        var nkey = nameKey(rr.player || '');
        var scoredPrev = scoredInFixture(prev, side2, function(x){
          return ((pid && x.playerId && x.playerId===pid && Number(x.goals||0)>0) ||
                  (nkey && nameKey(x.player||'')===nkey && Number(x.goals||0)>0));
        });
        if (scoredPrev){
          await addNews({
            type: 'consecutive_goals',
            title: 'On a streak: ' + playerLabel(rr),
            text: playerLabel(rr) + ' scored in back-to-back matches for ' + clubId,
            cup: f.cup,
            clubId: clubId,
            fixtureId: f.id,
            meta: { playerId: pid, prevFixtureId: prev.id }
          });
        }
      }
    }
  }
}

/* ====== End News helpers ====== */

// Report final (accepts playerId OR player name)
app.post('/api/cup/fixtures/:id/report', requireManagerOrAdmin, wrap(async function(req, res){
  var f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });

  if (!isAdminSession(req) && !managerOwnsFixture(req, f)) {
    return res.status(403).json({ error: 'Managers of these clubs only (or admin)' });
  }

  var rb = req.body || {};
  var hs = rb.hs, as = rb.as, text = rb.text, mvpHome = rb.mvpHome, mvpAway = rb.mvpAway, discordMsgUrl = rb.discordMsgUrl, details = rb.details;

  f.score  = { hs: Number(hs||0), as: Number(as||0) };
  f.report = { text: String(text||''), mvpHome: String(mvpHome||''), mvpAway: String(mvpAway||''), discordMsgUrl: String(discordMsgUrl||'') };
  if (details && typeof details === 'object') {
    f.details = { home: [], away: [] };
    f.unresolved = [];
    var sides = ['home','away'];
    for (var s=0;s<sides.length;s++){
      var side = sides[s];
      var rows = (details[side] || []);
      for (var i=0;i<rows.length;i++){
        var row = rows[i] || {};
        var playerId = row.playerId || null;
        var player = row.player || '';
        var goals = Number(row.goals || 0);
        var assists = Number(row.assists || 0);
        var rating = Number(row.rating || 0);
        var pos = String(row.pos || '');
        if (!playerId && player){
          playerId = await resolvePlayerIdByName(player, side==='home' ? f.home : f.away);
        }
        var item = { playerId: playerId||'', player: player||'', goals: goals, assists: assists, rating: rating, pos: pos };
        f.details[side].push(item);
        if (!playerId && player) f.unresolved.push({ side: side, name: player });
      }
    }
  }
  f.status = 'final';
  if (!f.when) f.when = Date.now();

  await setDoc('fixtures', f.id, f);
  await bumpPlayerStatsFromFixture(f);

  // Dynamic news from this fixture
  try { await generateNewsForFixture(f); } catch (e) { console.warn('news generation failed:', e.message); }

  res.json({ ok: true, fixture: f });
}));

// Admin quick paste
app.post('/api/cup/fixtures/:id/ingest-text', requireAdmin, wrap(async function(req, res){
  var f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  var text = (req.body && req.body.text) || '';
  if (!text) return res.status(400).json({ error: 'text required' });

  var parsed = parseLooseResultText(text);
  if (!parsed) return res.status(400).json({ error: 'could not parse input' });

  // resolve names to ids
  var out = { home: [], away: [] }, unresolved = [];
  var sides = ['home','away'];
  for (var s=0;s<sides.length;s++){
    var side = sides[s];
    var rows = parsed.details[side] || [];
    for (var i=0;i<rows.length;i++){
      var r = rows[i];
      var pid = r.playerId || null;
      if (!pid && r.player) pid = await resolvePlayerIdByName(r.player, side==='home' ? f.home : f.away);
      var item = { playerId: pid||'', player: r.player||'', goals:Number(r.goals||0), assists:Number(r.assists||0), rating:Number(r.rating||0), pos: String(r.pos||'') };
      out[side].push(item);
      if (!pid && r.player) unresolved.push({ side: side, name:r.player });
    }
  }

  f.score = parsed.score;
  f.details = out;
  f.unresolved = unresolved;
  f.status = 'final';
  if (!f.when) f.when = Date.now();

  await setDoc('fixtures', f.id, f);
  await bumpPlayerStatsFromFixture(f);

  // Dynamic news from this fixture
  try { await generateNewsForFixture(f); } catch (e) { console.warn('news generation failed:', e.message); }

  res.json({ ok: true, fixture: f });
}));

// Loose text parser (very forgiving)
function parseLooseResultText(str) {
  var toks = String(str).replace(/\n/g, ',').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var side = 'home';
  var details = { home: [], away: [] };
  var score = { hs: 0, as: 0 };
  var cur = null;
  function commit(){
    if (cur && cur.player) {
      cur.goals = Number(cur.goals || 0);
      cur.assists = Number(cur.assists || 0);
      cur.rating = Number(cur.rating || 0);
      details[side].push(cur);
    }
    cur = null;
  }
  for (var i=0;i<toks.length;i++) {
    var t = toks[i];
    var low = t.toLowerCase();

    if (low.indexOf('home') !== -1) { commit(); side='home'; continue; }
    if (low.indexOf('away') !== -1) { commit(); side='away'; continue; }

    var m = t.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m) { score.hs = Number(m[1]); score.as = Number(m[2]); continue; }

    m = t.match(/score\s*:\s*(\d+)/i);
    if (m) { if (side==='home') score.hs = Number(m[1]); else score.as = Number(m[1]); continue; }

    m = t.match(/player\s*\d*\s*:\s*(.+)/i);
    if (m) { commit(); cur = { player: m[1].trim() }; continue; }

    m = t.match(/(\d+)\s*goal/i); if (m) { cur = cur || {}; cur.goals = Number(m[1]); continue; }
    m = t.match(/(\d+)\s*assist/i); if (m) { cur = cur || {}; cur.assists = Number(m[1]); continue; }
    m = t.match(/rating\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (m) { cur = cur || {}; cur.rating = Number(m[1]); continue; }
    m = t.match(/pos\s*:\s*([A-Z0-9-]+)/i);
    if (m) { cur = cur || {}; cur.pos = m[1].toUpperCase(); continue; }

    if (!cur || !cur.player) {
      if (t && !/^\d+(\.\d+)?$/.test(t) && !/^(score|rating|goal|assist|pos)/i.test(t)) {
        cur = cur || {};
        cur.player = (cur.player || t);
      }
    }
  }
  commit();
  return { score: score, details: details };
}

/* =========================
   CHAMPIONS CUP (Groups A–D + Leaders)
========================= */
app.post('/api/champions/:cupId/groups', requireAdmin, wrap(async function(req,res){
  var cupId = req.params.cupId;
  var groups = (req.body && req.body.groups) || {};
  var doc = { cupId: cupId, groups:{ A:groups.A||[], B:groups.B||[], C:groups.C||[], D:groups.D||[] }, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

app.post('/api/champions/:cupId/randomize', requireAdmin, wrap(async function(req,res){
  var cupId = req.params.cupId;
  var clubs = Array.isArray(req.body && req.body.clubs) ? req.body.clubs.slice() : [];
  if (clubs.length!==16) return res.status(400).json({ error:'Provide exactly 16 clubIds in body.clubs' });
  shuffle(clubs);
  var groups = { A:[], B:[], C:[], D:[] };
  for (var i=0;i<clubs.length;i++){
    var id = String(clubs[i]);
    var bucket = ['A','B','C','D'][i%4];
    groups[bucket].push(id);
  }
  var doc = { cupId: cupId, groups: groups, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

async function computeGroupTables(cupId, groups){
  var snap = await COL.fixtures().where('cup','==',cupId).where('status','==','final').get();
  var fx = snap.docs.map(function(d){ return d.data(); });
  var table = { A:{}, B:{}, C:{}, D:{} };
  function touch(g,id){ table[g][id] = table[g][id] || { clubId:id, P:0, W:0, D:0, L:0, GF:0, GA:0, GD:0, Pts:0 }; }

  var gs = ['A','B','C','D'];
  for (var gi=0;gi<gs.length;gi++){
    var g = gs[gi];
    var arr = (groups[g]||[]);
    for (var ai=0;ai<arr.length;ai++) touch(g, arr[ai]);
  }
  for (var i=0;i<fx.length;i++){
    var f = fx[i];
    var g = f.group || null; if(!g || !table[g]) continue;
    touch(g, f.home); touch(g, f.away);
    var H = table[g][f.home], A = table[g][f.away];
    var hs = Number((f.score && f.score.hs)||0), as = Number((f.score && f.score.as)||0);
    H.P++; A.P++;
    H.GF+=hs; H.GA+=as; H.GD=H.GF-H.GA;
    A.GF+=as; A.GA+=hs; A.GD=A.GF-A.GA;
    if(hs>as){ H.W++; H.Pts+=3; A.L++; }
    else if(hs<as){ A.W++; A.Pts+=3; H.L++; }
    else { H.D++; A.D++; H.Pts++; A.Pts++; }
  }
  var sorted = {};
  for (var gi2=0;gi2<gs.length;gi2++){
    var g2 = gs[gi2];
    sorted[g2] = Object.values(table[g2]).sort(function(x,y){
      return (y.Pts-x.Pts) || (y.GD-x.GD) || (y.GF - x.GF);
    });
  }
  return sorted;
}

app.get('/api/champions/:cupId', wrap(async function(req,res){
  var cupId = req.params.cupId;
  var snap = await COL.champions().doc(cupId).get();
  var cup = snap.exists ? snap.data() : { cupId: cupId, groups:{A:[],B:[],C:[],D:[]}, createdAt: Date.now() };
  var tables = await computeGroupTables(cupId, cup.groups);
  res.json({ ok:true, cup: cup, tables: tables });
}));

// Leaders (Top scorers / assisters) — limit via ?limit=5
app.get('/api/champions/:cupId/leaders', wrap(async function(req,res){
  var cupId = req.params.cupId;
  var limit = Math.max(1, Math.min(20, Number((req.query && req.query.limit) || 5)));

  var snap = await COL.fixtures().where('cup','==',cupId).where('status','==','final').get();
  var fx = snap.docs.map(function(d){ return d.data(); });

  var goals = new Map(), assists = new Map(), meta = new Map();
  function bump(m,k,n){ m.set(k,(m.get(k)||0)+n); }

  for(var i=0;i<fx.length;i++){
    var f = fx[i];
    var sides = ['home','away'];
    for (var s=0;s<sides.length;s++){
      var side = sides[s];
      var clubId = side==='home'?f.home:f.away;
      var rows = (f.details && f.details[side]) ? f.details[side] : [];
      for (var rIdx=0;rIdx<rows.length;rIdx++){
        var r = rows[rIdx];
        if(!r.playerId) continue;
        meta.set(r.playerId,{ name: r.player || '#'+String(r.playerId).slice(0,6), clubId: clubId });
        if(r.goals)   bump(goals,   r.playerId, Number(r.goals||0));
        if(r.assists) bump(assists, r.playerId, Number(r.assists||0));
      }
    }
  }
  function toRows(m){
    return Array.from(m.entries())
      .map(function(entry){ return { playerId: entry[0], count: entry[1], name: (meta.get(entry[0])||{}).name, clubId: (meta.get(entry[0])||{}).clubId }; })
      .sort(function(a,b){ return (b.count-a.count) || String(a.name||'').localeCompare(String(b.name||'')); })
      .slice(0,limit);
  }

  res.json({ ok:true, scorers: toRows(goals), assisters: toRows(assists) });
}));

/* =========================
   NEWS API
========================= */
app.get('/api/news', wrap(async function(req,res){
  var limit = Math.max(1, Math.min(100, Number((req.query && req.query.limit) || 50)));
  var snap = await COL.news().orderBy('ts','desc').limit(limit).get();
  res.json({ ok:true, news: snap.docs.map(function(d){ return d.data(); }) });
}));

app.post('/api/news/generate-leaders', requireAdmin, wrap(async function(req,res){
  var cup = ((req.body && req.body.cup) || 'UPCL').trim();
  var lim = Math.max(3, Math.min(20, Number((req.body && req.body.limit) || 5)));
  var snap = await COL.fixtures().where('cup','==',cup).where('status','==','final').get();
  var fx = snap.docs.map(function(d){ return d.data(); });

  var goals = new Map(), assists = new Map();
  function bump(m,k,n){ m.set(k,(m.get(k)||0)+n); }

  for (var i=0;i<fx.length;i++){
    var f = fx[i];
    var sides = ['home','away'];
    for (var s=0;s<sides.length;s++){
      var side = sides[s];
      var rows = (f.details && f.details[side]) ? f.details[side] : [];
      for (var rIdx=0;rIdx<rows.length;rIdx++){
        var r = rows[rIdx];
        var key = r.playerId || ('name:'+nameKey(r.player||''));
        if(r.goals)   bump(goals,   key, Number(r.goals||0));
        if(r.assists) bump(assists, key, Number(r.assists||0));
      }
    }
  }
  function toRows(m){
    return Array.from(m.entries())
      .map(function(entry){ return { playerId: entry[0], count: entry[1] }; })
      .sort(function(a,b){ return b.count-a.count; })
      .slice(0,lim);
  }

  var doc = await addNews({
    type: 'leaders_daily',
    title: 'Leaders update ('+cup+')',
    text: 'Top scorers and assisters in '+cup+'.',
    cup: cup,
    meta: { topScorers: toRows(goals), topAssisters: toRows(assists) }
  });
  res.json({ ok:true, news: doc });
}));

/* =========================
   EA PASS-THROUGH (disabled; returns empty)
========================= */
app.get('/api/teams/:clubId/players', wrap(async function(req, res){
  // EA is down / disabled — always return empty to avoid 404s or interference
  res.json({ members: [] });
}));

/* =========================
   MISC / HEALTH & ERRORS
========================= */
app.get('/healthz', function(_req,res){ res.json({ ok:true, ts: Date.now() }); });

app.use(function(err, _req, res, _next){
  var code = err.status || 500;
  if (NODE_ENV !== 'test') console.error(err);
  res.status(code).json({ error: err.message || 'Server error' });
});

/* =========================
   START
========================= */
app.listen(PORT, function(){
  console.log('Server running on http://localhost:'+PORT+' (env: '+NODE_ENV+')');
  console.log('Firestore project: '+(admin.app().options.projectId || '(loaded)'));
});
