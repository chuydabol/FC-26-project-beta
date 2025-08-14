// server.js — Pro Clubs League backend (Firestore)
// Clean build: no EA API dependency; supports squads, fixtures (incl. Champions Cup),
// admin JSON/quick-paste results, dynamic News generation, and Discord webhook posts
// for Champions Cup fixtures (created/scheduled/final) + consolidated upcoming/TBD posts.

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Optional middlewares (used if installed)
let helmet = null, compression = null, cors = null, morgan = null, cron = null;
try { helmet = require('helmet'); } catch {}
try { compression = require('compression'); } catch {}
try { cors = require('cors'); } catch {}
try { morgan = require('morgan'); } catch {}
try { cron = require('node-cron'); } catch {}

// Node 18+ has global fetch; fallback if needed
const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

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

const PAYOUTS = {
  elite : Number(process.env.PAYOUT_ELITE  || 1_100_000),
  mid   : Number(process.env.PAYOUT_MID    ||   900_000),
  bottom: Number(process.env.PAYOUT_BOTTOM ||   700_000),
};
const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || 10_000_000);

// Manager session lifetime (hours); must re-enter manager code when expired
const MANAGER_SESSION_HOURS = Number(process.env.MANAGER_SESSION_HOURS || 12);

// Cups & points
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

// Champions Cup ID (keep in sync with frontend CC_ID) and helpers
const CC_CURRENT_ID = process.env.CC_CURRENT_ID || 'UPCL_CC_2025_08';
const CC_PREFIX = 'UPCL_CC';

// Discord webhook config (optional)
const DISCORD_WEBHOOK_CC = process.env.DISCORD_WEBHOOK_CC || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (isProd ? '' : `http://localhost:${PORT}`);

/* =========================
   EXPRESS APP
========================= */
const app = express();
app.set('trust proxy', 1);

if (helmet) app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
if (cors) app.use(cors({ origin: true, credentials: true }));
if (compression) app.use(compression());
app.use(express.json({ limit: '2mb' }));
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

/* =========================
   HELPERS / COLLECTIONS
========================= */
const COL = {
  rankings    : () => db.collection('rankings'),    // docId = clubId
  wallets     : () => db.collection('wallets'),     // docId = clubId
  awards      : () => db.collection('cupAwards'),   // docId = season
  users       : () => db.collection('users'),       // docId = userId
  clubCodes   : () => db.collection('clubCodes'),   // docId = clubId { hash, rotatedAt, lastUsedAt? }
  fixtures    : () => db.collection('fixtures'),    // docId = fixtureId
  freeAgents  : () => db.collection('freeAgents'),  // docId = userId
  players     : () => db.collection('players'),     // docId = playerId
  clubSquadSlots: (clubId) => db.collection('clubSquads').doc(clubId).collection('slots'),
  playerStats : () => db.collection('playerStats'), // docId = `${season}_${playerId}`
  champions   : () => db.collection('champions'),   // docId = cupId { groups:{A:[ids],...} }
  news        : () => db.collection('news'),        // docId = newsId
};

const wrap = fn => (req,res,next)=> Promise.resolve(fn(req,res,next)).catch(next);
async function getDoc(col, id){ const s = await COL[col]().doc(id).get(); return s.exists ? s.data() : null; }
async function setDoc(col, id, obj){ await COL[col]().doc(id).set(obj, { merge:false }); return obj; }
async function updateDoc(col, id, patch){ await COL[col]().doc(id).set(patch, { merge:true }); }
async function listAll(col){ const snap = await COL[col]().get(); return snap.docs.map(d=>({ id:d.id, ...d.data() })); }

function isAdminSession(req) { return req.session?.admin === true; }
function me(req){ return req.session.user || null; }

// Manager session validity
function isManagerActive(req){
  const u = me(req);
  if (!u || u.role !== 'Manager') return false;
  return (req.session.managerExpiresAt || 0) > Date.now();
}

// Only expose active sessions to client
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
function requireManagerOfClubParam(param = 'clubId') {
  return (req, res, next) => {
    const u = me(req);
    if (!(u && u.role==='Manager' && isManagerActive(req) && String(u.teamId)===String(req.params[param]))) {
      return res.status(403).json({ error: 'Manager of this club only' });
    }
    next();
  };
}
function requireManagerOrAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  const u = me(req);
  if (u && u.role === 'Manager' && isManagerActive(req)) return next();
  return res.status(403).json({ error: 'Managers or Admins only' });
}
function managerOwnsFixture(req, f) {
  const u = me(req);
  return !!(u && u.role==='Manager' && isManagerActive(req) && [f.home, f.away].includes(u.teamId));
}

// Misc helpers
function seasonKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function genCode(len=8){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:len},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }

/* =========================
   DISCORD WEBHOOK (Champions Cup)
========================= */
function absUrl(u) {
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : (PUBLIC_BASE_URL ? PUBLIC_BASE_URL.replace(/\/$/,'') : '') + u;
}
function isChampionsCup(cup) {
  return String(cup||'').startsWith(CC_PREFIX);
}
async function postDiscord(payload) {
  try {
    if (!DISCORD_WEBHOOK_CC) return;
    await fetchFn(DISCORD_WEBHOOK_CC, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('[discord] webhook send failed:', e.message);
  }
}
// Minimal server-side team map for embeds (add as needed)
const TEAMS_SERVER = new Map([
  ['2491998', { name:'Royal Republic',   logo:'/assets/logos/royal-republic-logo.png' }],
  ['1527486', { name:'Gungan FC',        logo:'/assets/logos/gungan-fc.png' }],
  ['1969494', { name:'Club Frijol',      logo:'/assets/logos/club-frijol.png' }],
  ['2086022', { name:'Brehemen',         logo:'/assets/logos/brehemen.png' }],
  ['2462194', { name:'Costa Chica FC',   logo:'/assets/logos/costa-chica-fc.png' }],
  ['5098824', { name:'Sporting de la ma',logo:'/assets/logos/sporting-de-la-ma.png' }],
  ['4869810', { name:'Afc Tekki',        logo:'/assets/logos/afc-tekki.png' }],
  ['576007',  { name:'Ethabella FC',     logo:'/assets/logos/ethabella-fc.png' }],
  ['4933507', { name:'Loss Toyz',        logo:'/assets/logos/loss-toyz.png' }],
  ['4824736', { name:'GoldenGoals FC',   logo:'/assets/logos/goldengoals-fc.png' }],
  ['481847',  { name:'Rooney tunes',     logo:'/assets/logos/rooney-tunes.png' }],
  ['3050467', { name:'invincible afc',   logo:'/assets/logos/invincible-afc.png' }],
  ['4154835', { name:'khalch Fc',        logo:'/assets/logos/khalch-fc.png' }],
  ['3638105', { name:'Real mvc',         logo:'/assets/logos/real-mvc.png' }],
  ['55408',   { name:'Elite VT',         logo:'/assets/logos/elite-vt.png' }],
  ['4819681', { name:'EVERYTHING DEAD',  logo:'/assets/logos/everything-dead.png' }],
  ['35642',   { name:'EBK FC',           logo:'/assets/logos/ebk-fc.png' }],
  // Manual clubs
  ['afc-warriors',  { name:'AFC Warriors',  logo:'/assets/logos/afc-warriors.png' }],
  ['jids-trivela',  { name:'Jids Trivela',  logo:'/assets/logos/jids-trivela.png' }],
  ['razorblack-fc', { name:'Razorblack FC', logo:'/assets/logos/razorblack-fc.png' }],
  ['fc-dhizz',      { name:'FC Dhizz',      logo:'/assets/logos/fc-dhizz.png' }],
]);
function teamMeta(id) {
  const m = TEAMS_SERVER.get(String(id));
  return m ? { name: m.name, logo: absUrl(m.logo) } : { name:String(id), logo: 'https://via.placeholder.com/128?text=Club' };
}
function discordFixtureEmbed(fixture, state='created') {
  const H = teamMeta(fixture.home);
  const A = teamMeta(fixture.away);
  const whenUnix = fixture.when ? Math.floor(fixture.when / 1000) : null;

  const title =
    state === 'final'
      ? `FT ${fixture.score?.hs ?? 0}-${fixture.score?.as ?? 0}: ${H.name} vs ${A.name}`
      : state === 'scheduled'
        ? `Scheduled: ${H.name} vs ${A.name}`
        : `New fixture: ${H.name} vs ${A.name}`;

  const descParts = [];
  if (fixture.round) descParts.push(`**${fixture.round}**`);
  if (fixture.group) descParts.push(`Group ${fixture.group}`);
  descParts.push(whenUnix ? `<t:${whenUnix}:F>` : 'TBD');
  const description = descParts.join(' • ');

  const toLines = arr => (arr||[])
    .map(p => `• ${p.player || ('#' + String(p.playerId||'').slice(0,6))}${p.goals?` (${p.goals})`:''}${p.rating?` — ${Number(p.rating).toFixed(1)}`:''}`)
    .join('\n') || '—';

  return {
    username: 'UPCL',
    embeds: [{
      title,
      description,
      color: state === 'final' ? 0x2ecc71 : state === 'scheduled' ? 0xf1c40f : 0xe74c3c,
      author: { name: H.name, icon_url: H.logo },
      thumbnail: { url: A.logo },
      image: { url: absUrl('/assets/ui/fixture-banner.png') },
      fields: state === 'final' ? [
        { name: H.name, value: toLines(fixture.details?.home), inline: true },
        { name: A.name, value: toLines(fixture.details?.away), inline: true }
      ] : [],
      footer: { text: fixture.cup || '' }
    }]
  };
}

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

app.get('/api/auth/me', (req, res) => res.json({ user: userForClient(req) }));
app.post('/api/auth/logout', (req,res)=> req.session.destroy(()=> res.json({ ok:true })));

/* =========================
   MANAGER CODES (Session login; no "claimedBy")
========================= */
// Rotate one code (admin)
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, wrap(async (req, res) => {
  const { clubId } = req.params;
  const code = genCode(8);
  const hash = await bcrypt.hash(code, 10);
  await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now() });
  res.json({ ok:true, clubId, code });
}));

// Bulk rotate (admin)
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

// Export status (no plaintext codes)
app.get('/api/admin/manager-codes/export', requireAdmin, wrap(async (_req,res)=>{
  const snap = await COL.clubCodes().get();
  const rows = snap.docs.map(d=>{
    const x = d.data();
    return { clubId:d.id, hasCode: !!x.hash, rotatedAt: x.rotatedAt || 0, lastUsedAt: x.lastUsedAt || 0 };
  });
  const csv = 'clubId,hasCode,rotatedAt,lastUsedAt\n' + rows.map(r=>`${r.clubId},${r.hasCode},${r.rotatedAt},${r.lastUsedAt}`).join('\n');
  res.json({ ok:true, count: rows.length, csv, rows });
}));

// Session-based manager login (use every visit)
app.post('/api/clubs/:clubId/claim-manager', wrap(async (req,res)=>{
  const { clubId } = req.params;
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });

  const rec = await getDoc('clubCodes', clubId);
  if (!rec || !rec.hash) return res.status(400).json({ error: 'No manager code set. Ask admin.' });

  const ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error: 'Invalid code' });

  req.session.user = {
    id: uuidv4(),
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
   RANKINGS / PAYOUTS / WALLETS (light)
========================= */
function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayoutLocal(ranking){ const tier=(ranking?.tier)||'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }

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

// Wallet helpers
async function ensureWallet(clubId){
  const ref = COL.wallets().doc(clubId);
  const snap = await ref.get();
  if (!snap.exists) {
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

// Transactional collect
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
        lastCollectedAt: FieldValue.serverTimestamp(),
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
   SQUAD SLOTS (with hydration)
========================= */
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

app.get('/api/clubs/:clubId/squad', wrap(async (req, res) => {
  const { clubId } = req.params;
  const snap = await COL.clubSquadSlots(clubId).orderBy('slotId').get();
  const slots = snap.docs.map(d => d.data());
  const ids = Array.from(new Set(slots.map(s=>s.playerId).filter(Boolean)));
  const chunks = [];
  for (let i=0;i<ids.length;i+=10) chunks.push(ids.slice(i, i+10));

  const playersMap = new Map();
  for (const ch of chunks) {
    const q = await COL.players().where(FieldPath.documentId(), 'in', ch).get();
    q.docs.forEach(p => playersMap.set(p.id, p.data()));
  }

  const hydrated = slots.map(s => ({ ...s, player: s.playerId ? (playersMap.get(s.playerId) || null) : null }));
  res.json({ clubId, slots: hydrated });
}));

app.post('/api/clubs/:clubId/squad/slots/:slotId/assign', requireManagerOfClubParam('clubId'), wrap(async (req,res)=>{
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
   PLAYER REGISTRY
========================= */
app.post('/api/players/register', wrap(async (req, res) => {
  const { eaName, platform='manual', aliases=[] } = req.body || {};
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

  // Prefer the club's assigned slots
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
  // Fallback global alias match
  const q = await COL.players().where('search','array-contains', n).limit(1).get();
  if (!q.empty) return q.docs[0].data().id;

  return null;
}

/* =========================
   PLAYER STATS (per season) + news streak helpers
========================= */
async function bumpPlayerStatsFromFixture(f){
  const season = seasonKey();
  for (const side of ['home','away']){
    for (const r of (f.details?.[side]||[])){
      if (!r.playerId) continue;
      const id = `${season}_${r.playerId}`;
      const ref = COL.playerStats().doc(id);
      const inc = {
        season, playerId:r.playerId,
        goals: FieldValue.increment(Number(r.goals||0)),
        assists: FieldValue.increment(Number(r.assists||0)),
        ratingsSum: FieldValue.increment(Number(r.rating||0)),
        ratingsCount: FieldValue.increment(r.rating ? 1 : 0),
        matches: FieldValue.increment(1),
      };
      if (Number(r.goals||0) > 0) {
        await ref.set({ ...inc, scoringStreak: FieldValue.increment(1), lastScoredAt: Date.now() }, { merge:true });
      } else {
        await ref.set({ ...inc, scoringStreak: 0 }, { merge:true });
      }
    }
  }
}

/* =========================
   FIXTURES
========================= */
// Create fixture (Admin). Use cup ids: "UPCL" (league cup) or "UPCL_CC_YYYY_MM" (Champions)
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

  if (isChampionsCup(fixture.cup)) postDiscord(discordFixtureEmbed(fixture, 'created'));

  res.json({ ok:true, fixture });
}));

// Public sanitized feed (optionally include lineups with ?includeLineups=1)
app.get('/api/cup/fixtures/public', wrap(async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const includeLineups = String(req.query.includeLineups||'0')==='1';
  const snap = await COL.fixtures().where('cup','==',cup).get();
  const list = snap.docs.map(d => {
    const f = d.data();
    const base = {
      id: f.id, cup: f.cup, round: f.round, group: f.group||null,
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
app.get('/api/cup/fixtures/scheduling', requireManagerOrAdmin, wrap(async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const snap = await COL.fixtures().where('cup', '==', cup).get();
  res.json({ fixtures: snap.docs.map(d => d.data()) });
}));

// List (compat) + optional filter by club
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

// Propose time
app.post('/api/cup/fixtures/:id/propose', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  const at = Number(req.body?.at || 0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });
  const asAdmin = isAdminSession(req);
  if (!asAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  f.proposals = f.proposals || [];
  f.votes = f.votes || {};
  if (!f.proposals.some(p=>Number(p.at)===at)) f.proposals.push({ at, by: asAdmin ? 'admin' : me(req).teamId });
  f.votes[String(at)] = f.votes[String(at)] || {};
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// Vote time
app.post('/api/cup/fixtures/:id/vote', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  const at = String(req.body?.at || '');
  const agree = !!req.body?.agree;
  if (!at) return res.status(400).json({ error:'invalid slot' });

  const asAdmin = isAdminSession(req);
  if (!asAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const teamId = asAdmin ? 'admin' : me(req).teamId;
  f.votes = f.votes || {};
  f.votes[at] = f.votes[at] || {};
  f.votes[at][teamId] = agree;

  if (f.votes[at][f.home] === true && f.votes[at][f.away] === true) {
    f.when = Number(at);
    f.status = 'scheduled';
    f.timeLockedAt = Date.now();

    if (isChampionsCup(f.cup)) postDiscord(discordFixtureEmbed(f, 'scheduled'));
  }
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

// Set lineup
app.put('/api/cup/fixtures/:id/lineup', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });

  const asAdmin = isAdminSession(req);
  if (!asAdmin && !managerOwnsFixture(req, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const { formation, lineup } = req.body || {};
  f.lineups = f.lineups || {};
  const owner = asAdmin ? 'admin' : me(req).teamId;
  f.lineups[owner] = { formation: String(formation||''), lineup: lineup && typeof lineup==='object' ? lineup : {} , at: Date.now() };
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
}));

/* ===== Results ingest & News ===== */

// Admin quick paste (loose text)
app.post('/api/cup/fixtures/:id/ingest-text', requireAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  const parsed = parseLooseResultText(text);
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
  await maybeCreateNewsFromFixture(f);

  if (isChampionsCup(f.cup)) postDiscord(discordFixtureEmbed(f, 'final'));

  res.json({ ok: true, fixture: f });
}));

// Report final (accepts playerId OR player name)
app.post('/api/cup/fixtures/:id/report', requireManagerOrAdmin, wrap(async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });

  if (!isAdminSession(req) && !managerOwnsFixture(req, f)) {
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
  await maybeCreateNewsFromFixture(f);

  if (isChampionsCup(f.cup)) postDiscord(discordFixtureEmbed(f, 'final'));

  res.json({ ok: true, fixture: f });
}));

// Loose text parser
function parseLooseResultText(str) {
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
   NEWS (auto from fixtures)
========================= */
async function maybeCreateNewsFromFixture(f) {
  try {
    // Hattricks
    for (const side of ['home','away']) {
      for (const r of (f.details?.[side] || [])) {
        if (Number(r.goals||0) >= 3) {
          const id = `news_ht_${f.id}_${side}_${r.playerId||norm(r.player)}`;
          const exists = await COL.news().doc(id).get();
          if (!exists.exists) {
            await COL.news().doc(id).set({
              id, type:'hattrick', cup:f.cup, fixtureId:f.id,
              player: r.player || '', playerId: r.playerId || '',
              teamId: side==='home'?f.home:f.away,
              goals: Number(r.goals||0), createdAt: Date.now(),
              text: `${r.player || 'Unknown'} scored a hat-trick for ${side==='home'?teamMeta(f.home).name:teamMeta(f.away).name}!`
            });
          }
        }
      }
    }
    // Finals headline
    {
      const id = `news_ft_${f.id}`;
      const exists = await COL.news().doc(id).get();
      if (!exists.exists) {
        await COL.news().doc(id).set({
          id, type:'final', cup:f.cup, fixtureId:f.id,
          score: f.score, home:f.home, away:f.away, when:f.when||Date.now(),
          createdAt: Date.now(),
          text: `FT ${teamMeta(f.home).name} ${f.score.hs}-${f.score.as} ${teamMeta(f.away).name}`
        });
      }
    }
    // Scoring streaks (3+)
    for (const side of ['home','away']) {
      for (const r of (f.details?.[side] || [])) {
        if (!r.playerId || Number(r.goals||0) <= 0) continue;
        const psDoc = await COL.playerStats().doc(`${seasonKey()}_${r.playerId}`).get();
        const st = psDoc.exists ? (psDoc.data().scoringStreak || 0) : 0;
        if (st >= 3) {
          const id = `news_streak_${f.id}_${r.playerId}`;
          const exists = await COL.news().doc(id).get();
          if (!exists.exists) {
            await COL.news().doc(id).set({
              id, type:'streak', cup:f.cup, fixtureId:f.id,
              player: r.player || '', playerId: r.playerId,
              teamId: side==='home'?f.home:f.away,
              streak: st, createdAt: Date.now(),
              text: `${r.player || 'Player'} has scored in ${st} consecutive matches.`
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[news] generation failed:', e.message);
  }
}

// News feed (public)
app.get('/api/news', wrap(async (req,res)=>{
  const cup = (req.query.cup || '').trim();
  let q = COL.news().orderBy('createdAt', 'desc').limit(50);
  if (cup) {
    const snap = await q.get();
    const items = snap.docs.map(d=>d.data()).filter(x=>x.cup===cup);
    return res.json({ items });
  }
  const snap = await q.get();
  res.json({ items: snap.docs.map(d=>d.data()) });
}));

/* =========================
   CHAMPIONS CUP (Groups + Tables + Leaders)
========================= */
app.post('/api/champions/:cupId/groups', requireAdmin, wrap(async (req,res)=>{
  const { cupId } = req.params;
  const groups = req.body?.groups || {}; // e.g., { A:[ids], B:[ids], ... } — any count is fine
  const doc = { cupId, groups, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

app.post('/api/champions/:cupId/randomize', requireAdmin, wrap(async (req,res)=>{
  const { cupId } = req.params;
  let clubs = Array.isArray(req.body?.clubs) ? req.body.clubs.slice() : [];
  if (!clubs.length) return res.status(400).json({ error:'Provide clubs[] with 1+ clubIds' });
  const letters = String(req.body?.groupsAlpha || 'ABCD').split('').filter(Boolean);
  if (!letters.length) return res.status(400).json({ error:'groupsAlpha required (e.g., "ABC" or "ABCD")' });

  // shuffle
  for (let i=clubs.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [clubs[i],clubs[j]]=[clubs[j],clubs[i]]; }

  const groups = {};
  letters.forEach(l=>groups[l]=[]);
  clubs.forEach((id,i)=> groups[letters[i % letters.length]].push(String(id)));

  const doc = { cupId, groups, createdAt: Date.now() };
  await COL.champions().doc(cupId).set(doc);
  res.json({ ok:true, cup:doc });
}));

async function computeGroupTables(cupId, groups){
  const snap = await COL.fixtures().where('cup','==',cupId).get();
  const fx = snap.docs.map(d=>d.data()).filter(f=>f.status==='final');
  const letters = Object.keys(groups||{});
  const table = {};
  const touch = (g,id)=> { table[g] = table[g] || {}; table[g][id] = table[g][id] || { clubId:id, P:0, W:0, D:0, L:0, GF:0, GA:0, GD:0, Pts:0 }; };

  for (const g of letters){
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
  for (const g of letters){
    sorted[g] = Object.values(table[g]||{}).sort((x,y)=>
      (y.Pts-x.Pts) || (y.GD-x.GD) || (y.GF - x.GF));
  }
  return sorted;
}

app.get('/api/champions/:cupId', wrap(async (req,res)=>{
  const { cupId } = req.params;
  const snap = await COL.champions().doc(cupId).get();
  const cup = snap.exists ? snap.data() : { cupId, groups:{}, createdAt: Date.now() };
  const tables = await computeGroupTables(cupId, cup.groups);
  res.json({ ok:true, cup, tables });
}));

// Leaders (Top scorers / assisters) — limit via ?limit=5
app.get('/api/champions/:cupId/leaders', wrap(async (req,res)=>{
  const { cupId } = req.params;
  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 5)));

  const snap = await COL.fixtures().where('cup','==',cupId).get();
  const fx = snap.docs.map(d=>d.data()).filter(f=>f.status==='final');

  const goals = new Map(), assists = new Map(), meta = new Map();
  const bump = (m,k,n)=>m.set(k,(m.get(k)||0)+n);

  for(const f of fx){
    for(const side of ['home','away']){
      const clubId = side==='home'?f.home:f.away;
      for(const r of (f.details?.[side]||[])){
        if(!r.playerId) continue;
        meta.set(r.playerId,{ name: r.player || `#${String(r.playerId).slice(0,6)}`, clubId });
        if(r.goals)   bump(goals,   r.playerId, Number(r.goals||0));
        if(r.assists) bump(assists, r.playerId, Number(r.assists||0));
      }
    }
  }
  const toRows = (m)=>Array.from(m.entries())
    .map(([playerId,count])=>({ playerId, count, ...meta.get(playerId) }))
    .sort((a,b)=>(b.count-a.count)||String(a.name).localeCompare(String(b.name)))
    .slice(0,limit);

  res.json({ ok:true, scorers: toRows(goals), assisters: toRows(assists) });
}));

/* =========================
   DISCORD: Current & Upcoming (Scheduled + TBD)
========================= */
async function getCCFixtures(cupId) {
  const snap = await COL.fixtures().where('cup','==', cupId).get();
  return snap.docs.map(d=>d.data());
}
function formatFixtureLine(f) {
  const H = teamMeta(f.home), A = teamMeta(f.away);
  const bits = [];
  if (f.round) bits.push(`**${f.round}**`);
  if (f.group) bits.push(`Group ${f.group}`);
  if (f.when) {
    const unix = Math.floor(f.when/1000);
    bits.push(`<t:${unix}:F>`);
  } else {
    bits.push('TBD');
  }
  return `${H.name} vs ${A.name}\n${bits.join(' • ')}`;
}
async function buildUpcomingPayload(cupId) {
  const now = Date.now();
  const all = await getCCFixtures(cupId);

  const scheduled = all
    .filter(f => f.status !== 'final' && !!f.when && f.when >= now)
    .sort((a,b) => (a.when||0) - (b.when||0))
    .slice(0, 15);

  const tbd = all
    .filter(f => f.status !== 'final' && !f.when)
    .sort((a,b) => (b.createdAt||0) - (a.createdAt||0))
    .slice(0, 15);

  const fields = [];

  if (scheduled.length) {
    fields.push({ name: '— Scheduled —', value: ' ', inline: false });
    scheduled.forEach(f => fields.push({
      name: '\u200b',
      value: formatFixtureLine(f),
      inline: false
    }));
  }

  if (tbd.length) {
    fields.push({ name: '— TBD / Negotiating —', value: ' ', inline: false });
    tbd.forEach(f => fields.push({
      name: '\u200b',
      value: formatFixtureLine(f),
      inline: false
    }));
  }

  return {
    payload: {
      username: 'UPCL',
      embeds: [{
        title: 'Champions Cup — Current & Upcoming Fixtures',
        color: 0x7289da,
        fields: fields.length ? fields : [{ name: '—', value: 'No current/upcoming fixtures.', inline: false }],
        footer: { text: cupId }
      }]
    },
    counts: { scheduled: scheduled.length, tbd: tbd.length }
  };
}

// Manual consolidated post
app.post('/api/discord/cc/upcoming', requireAdmin, wrap(async (req, res) => {
  const cupId = (req.query.cup || CC_CURRENT_ID);
  const { payload, counts } = await buildUpcomingPayload(cupId);
  await postDiscord(payload);
  res.json({ ok:true, cup: cupId, ...counts });
}));

// Optional CRON for daily consolidated post
if (cron && process.env.CRON_DISCORD_CC) {
  cron.schedule(process.env.CRON_DISCORD_CC, async () => {
    try {
      const cupId = CC_CURRENT_ID;
      const { payload } = await buildUpcomingPayload(cupId);
      await postDiscord(payload);
    } catch (e) {
      console.error('[discord] daily post error:', e.message);
    }
  });
}

/* =========================
   MISC / HEALTH & ERRORS
========================= */
app.get('/healthz', (_req,res)=> res.json({ ok:true, ts: Date.now() }));

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
