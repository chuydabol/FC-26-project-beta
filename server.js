// server.js (Firestore edition)
// Pro Clubs league backend with Firebase persistence.
// Endpoints: admin login, manager codes, rankings/payouts/wallets, cup bonuses, EA pass-through, UPCL fixtures.

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// fetch for Node 18+ or polyfill
const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

/* =========================
   FIREBASE (admin SDK)
========================= */
const admin = require('firebase-admin');

let svc = null;
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required (paste the JSON key)');
}
svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (svc.private_key && svc.private_key.includes('\\n')) {
  svc.private_key = svc.private_key.replace(/\\n/g, '\n');
}
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}
const db = admin.firestore();

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // e.g., "Chuyacc"

// Economy (month-long season suggested)
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
   EXPRESS APP
========================= */
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*30 }
}));

// Static site
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teams.html')));

/* =========================
   HELPERS
========================= */
function isAdminSession(req) { return req.session?.admin === true; }
function me(req){ return req.session.user || null; }
function requireAdmin(req, res, next) {
  if (isAdminSession(req)) return next();
  return res.status(403).json({ error: 'Admin only' });
}
function requireManagerOfFixture(req, res, fixture) {
  const u = me(req);
  if (!u || u.role !== 'Manager' || ![fixture.home, fixture.away].includes(u.teamId)) {
    return false;
  }
  return true;
}
function requireManagerOfClubParam(param = 'clubId') {
  return (req, res, next) => {
    const u = me(req);
    if (!u || u.role !== 'Manager' || u.teamId !== req.params[param]) {
      return res.status(403).json({ error: 'Manager of this club only' });
    }
    next();
  };
}
function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayoutLocal(ranking){ const tier=(ranking?.tier)||'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }
function genCode(len=8){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:len}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

/* =========================
   FIRESTORE WRAPPERS
========================= */
const COL = {
  rankings : () => db.collection('rankings'),          // docId = clubId
  wallets  : () => db.collection('wallets'),           // docId = clubId
  awards   : () => db.collection('cupAwards'),         // docId = season, data: { paid: { clubId: amount } }
  users    : () => db.collection('users'),             // docId = userId
  clubCodes: () => db.collection('clubCodes'),         // docId = clubId { hash, rotatedAt, claimedBy }
  fixtures : () => db.collection('fixtures'),          // docId = fixture id
};

async function getDoc(col, id){ const d = await COL[col]().doc(id).get(); return d.exists ? d.data() : null; }
async function setDoc(col, id, obj){ await COL[col]().doc(id).set(obj, { merge:false }); return obj; }
async function updateDoc(col, id, patch){ await COL[col]().doc(id).set(patch, { merge:true }); }
async function deleteDoc(col, id){ await COL[col]().doc(id).delete(); }
async function listAll(col){ const snap = await COL[col]().get(); return snap.docs.map(d=>({ id:d.id, ...d.data() })); }

/* =========================
   AUTH (Admin + Session User)
========================= */
if (!ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD not set — admin login will fail until you set it.');
}
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Bad password' });
  req.session.admin = true;
  res.json({ ok:true });
});
app.post('/api/admin/logout', (req, res) => { req.session.admin = false; res.json({ ok:true }); });
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdminSession(req) }));

app.get('/api/auth/me', (req, res) => res.json({ user: me(req) }));
app.post('/api/auth/logout', (req,res)=> req.session.destroy(()=> res.json({ ok:true })));

/* =========================
   MANAGER CODES
========================= */
// Rotate (admin): returns plain code for you to DM to the manager
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, async (req, res) => {
  const { clubId } = req.params;
  const code = genCode(8);
  const hash = await bcrypt.hash(code, 10);
  const rec = await getDoc('clubCodes', clubId) || {};
  await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now(), claimedBy: rec.claimedBy || null });
  res.json({ ok:true, clubId, code });
});

// Optional: reset claimed manager (keeps code)
app.post('/api/clubs/:clubId/manager-code/reset', requireAdmin, async (req,res)=>{
  const { clubId } = req.params;
  const rec = await getDoc('clubCodes', clubId);
  if (!rec) return res.status(400).json({ error: 'No code set for this club' });
  await updateDoc('clubCodes', clubId, { claimedBy: null, rotatedAt: Date.now() });
  res.json({ ok:true });
});

// Claim manager seat
app.post('/api/clubs/:clubId/claim-manager', async (req,res)=>{
  const { clubId } = req.params;
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const rec = await getDoc('clubCodes', clubId);
  if (!rec) return res.status(400).json({ error: 'No manager code set. Ask admin.' });
  const ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error: 'Invalid code' });
  if (rec.claimedBy) return res.status(409).json({ error: 'Club already has a manager' });

  const id = uuidv4();
  const user = { id, name: String(name).trim(), role: 'Manager', teamId: clubId };
  await setDoc('users', id, user);
  await updateDoc('clubCodes', clubId, { claimedBy: id });
  req.session.user = user;
  res.json({ ok:true, user });
});

/* =========================
   RANKINGS / PAYOUTS / WALLETS
========================= */
function seasonKey(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// Public: GET rankings map
app.get('/api/rankings', async (req,res)=>{
  const all = await listAll('rankings');
  const map = {};
  for (const r of all) map[r.id] = { leaguePos:r.leaguePos||'', cup:r.cup||'none', points:r.points||0, tier:r.tier||'mid' };
  res.json({ rankings: map, payouts: PAYOUTS, cupPoints: CUP_POINTS });
});

// Bulk save (admin)
app.post('/api/rankings/bulk', requireAdmin, async (req,res)=>{
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
});

// Recalc tiers (admin)
app.post('/api/rankings/recalc', requireAdmin, async (req,res)=>{
  const all = await listAll('rankings');
  await Promise.all(all.map(r=>{
    const points = leaguePoints(r.leaguePos||0) + (CUP_POINTS[r.cup||'none']||0);
    const tier = tierFromPoints(points);
    return setDoc('rankings', r.id, { leaguePos:r.leaguePos||0, cup:r.cup||'none', points, tier });
  }));
  res.json({ ok:true });
});

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
  const w = await ensureWallet(clubId);
  const r = await getRanking(clubId);
  const perDay = getDailyPayoutLocal(r);
  const days = Math.floor((Date.now() - (w.lastCollectedAt || 0)) / 86_400_000);
  return { days, perDay, amount: Math.max(0, days * perDay) };
}

// Wallet endpoints
app.get('/api/wallets/:clubId', async (req,res)=>{
  const { clubId } = req.params;
  const w = await ensureWallet(clubId);
  const preview = await collectPreview(clubId);
  const r = await getRanking(clubId);
  res.json({ wallet: w, preview, perDay: getDailyPayoutLocal(r) });
});
app.post('/api/wallets/:clubId/collect', requireManagerOfClubParam('clubId'), async (req,res)=>{
  const { clubId } = req.params;
  const w = await ensureWallet(clubId);
  const preview = await collectPreview(clubId);
  if (preview.days <= 0) return res.json({ ok:false, message:'No payout available yet', preview });
  const newBal = (w.balance||0) + preview.amount;
  const newLast = (w.lastCollectedAt || 0) + preview.days * 86_400_000;
  await setDoc('wallets', clubId, { balance: newBal, lastCollectedAt: newLast });
  const updated = await ensureWallet(clubId);
  const r = await getRanking(clubId);
  res.json({ ok:true, wallet: updated, preview: await collectPreview(clubId), perDay: getDailyPayoutLocal(r) });
});

/* =========================
   CUP BONUSES (Admin)
========================= */
app.post('/api/bonuses/cup', requireAdmin, async (req,res)=>{
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
      const w = await ensureWallet(r.id);
      await setDoc('wallets', r.id, { balance: (w.balance||0) + bonus, lastCollectedAt: w.lastCollectedAt||Date.now() });
      already[r.id] = bonus;
      actually += bonus;
    }
  }

  if (!dryRun){
    await awardsDocRef.set({ paid: already }, { merge:false });
  }
  res.json({ ok:true, season, dryRun, totalAwarded: dryRun ? willAward : actually, results });
});
app.get('/api/bonuses/cup', requireAdmin, async (req,res)=>{
  const season = (req.query.season || '').trim() || seasonKey();
  const doc = await COL.awards().doc(season).get();
  res.json({ ok:true, season, paid: doc.exists ? (doc.data().paid || {}) : {} });
});

/* =========================
   EA PASS-THROUGH (optional)
========================= */
app.get('/api/teams/:clubId/players', async (req, res) => {
  const { clubId } = req.params;
  if (!/^\d+$/.test(clubId)) return res.json({ members: [] }); // manual clubs are strings
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchFn(url, { headers:{'User-Agent':'Mozilla/5.0'}, signal: controller.signal });
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
app.post('/api/cup/fixtures', requireAdmin, async (req, res) => {
  const { home, away, round, cup = 'UPCL' } = req.body || {};
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });
  if (home === away)   return res.status(400).json({ error: 'home and away cannot match' });

  const id = uuidv4();
  const fixture = {
    id, cup,
    round: String(round || 'Round'),
    home: String(home), away: String(away),
    teams: [String(home), String(away)], // for potential array-contains query later
    status: 'pending',          // pending | scheduled | live (unused) | final
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
  await setDoc('fixtures', id, fixture);
  res.json({ ok:true, fixture });
});

// List fixtures (filter by cup; optional in-memory filter by clubId)
app.get('/api/cup/fixtures', async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const clubId = (req.query.clubId || '').trim();

  // Query by cup (no composite index needed). Filter clubId in memory.
  const snap = await COL.fixtures().where('cup','==',cup).get();
  let fixtures = snap.docs.map(d => d.data());
  if (clubId) fixtures = fixtures.filter(f => f.home === clubId || f.away === clubId);
  res.json({ fixtures });
});

// Get one fixture
app.get('/api/cup/fixtures/:id', async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  res.json({ fixture: f });
});

// Propose time (Manager of home/away)
app.post('/api/cup/fixtures/:id/propose', async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req, res, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const at = Number(req.body?.at || 0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });

  f.proposals = f.proposals || [];
  f.votes = f.votes || {};
  f.proposals.push({ at, by: me(req).teamId });
  f.votes[String(at)] = f.votes[String(at)] || {};
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
});

// Vote (Manager)
app.post('/api/cup/fixtures/:id/vote', async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req, res, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const at = String(req.body?.at || '');
  const agree = !!req.body?.agree;
  if (!at || !f.votes || !f.votes[at]) return res.status(400).json({ error:'invalid slot' });

  f.votes[at][me(req).teamId] = agree;

  // lock time if both agree
  if (f.votes[at][f.home] === true && f.votes[at][f.away] === true) {
    f.when = Number(at);
    f.status = 'scheduled';
    f.timeLockedAt = Date.now();
  }
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
});

// Set lineup (Manager)
app.put('/api/cup/fixtures/:id/lineup', async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req, res, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const { formation, lineup } = req.body || {};
  f.lineups = f.lineups || {};
  f.lineups[me(req).teamId] = { formation: String(formation||''), lineup: lineup && typeof lineup==='object' ? lineup : {} };
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
});

// Report result (Manager)
app.post('/api/cup/fixtures/:id/report', async (req, res) => {
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req, res, f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const { hs, as, text, mvpHome, mvpAway, discordMsgUrl } = req.body || {};
  f.score  = { hs: Number(hs||0), as: Number(as||0) };
  f.report = { text: String(text||''), mvpHome: String(mvpHome||''), mvpAway: String(mvpAway||''), discordMsgUrl: String(discordMsgUrl||'') };
  f.status = 'final';
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (env: ${NODE_ENV})`);
  console.log(`Firestore project: ${admin.app().options.projectId || '(loaded)'}`);
});
