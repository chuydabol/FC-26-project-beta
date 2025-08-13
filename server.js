// server.js — Pro Clubs League backend (Firestore)
// Includes:
// - Admin login (env ADMIN_PASSWORD), sessions
// - Manager codes: rotate/reset/claim + BULK ROTATE (CSV)
// - Player claim + Free agents
// - Rankings / wallets (daily payouts) / cup bonuses
// - EA pass-through (numeric clubIds)
// - Fixtures: create/list/get/propose/vote/lineup/report/ingest-text (records proposer club)
// - Rosters: 15 slots per club; managers assign EA usernames -> playerId registry
// - Champions Cup: groups randomize/save/get + computed tables
// - Admin exports: manager-codes CSV
//
// ENV required:
//   FIREBASE_SERVICE_ACCOUNT (JSON string; \n normalized below)
//   ADMIN_PASSWORD           (e.g. "Chuyacc")
//   SESSION_SECRET
// Optional:
//   PAYOUT_ELITE, PAYOUT_MID, PAYOUT_BOTTOM, STARTING_BALANCE

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const fetchFn = global.fetch || ((...a) => import('node-fetch').then(m => m.default(...a)));

const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required');

const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (svc.private_key && svc.private_key.includes('\\n')) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

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
   APP
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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teams.html')));

/* =========================
   HELPERS / DB
========================= */
const COL = {
  rankings : () => db.collection('rankings'),   // docId = clubId
  wallets  : () => db.collection('wallets'),    // docId = clubId
  awards   : () => db.collection('cupAwards'),  // docId = season
  users    : () => db.collection('users'),      // docId = userId
  clubCodes: () => db.collection('clubCodes'),  // docId = clubId
  fixtures : () => db.collection('fixtures'),   // docId = fixtureId
  agents   : () => db.collection('freeAgents'), // docId = userId
  champions: () => db.collection('champions'),  // docId = cupId
  rosters  : () => db.collection('rosters'),    // docId = clubId
  players  : () => db.collection('players'),    // docId = playerId
};

async function getDoc(col, id){ const d = await COL[col]().doc(id).get(); return d.exists ? d.data() : null; }
async function setDoc(col, id, obj){ await COL[col]().doc(id).set(obj, { merge:false }); return obj; }
async function updateDoc(col, id, patch){ await COL[col]().doc(id).set(patch, { merge:true }); }
async function deleteDoc(col, id){ await COL[col]().doc(id).delete(); }
async function listAll(col){ const snap = await COL[col]().get(); return snap.docs.map(d=>({ id:d.id, ...d.data() })); }

function isAdminSession(req){ return req.session?.admin === true; }
function me(req){ return req.session.user || null; }
function requireAdmin(req,res,next){ if(isAdminSession(req)) return next(); return res.status(403).json({ error: 'Admin only' }); }
function requireManagerOfFixture(req,res,fixture){
  const u = me(req);
  return !!(u && u.role==='Manager' && [fixture.home, fixture.away].includes(u.teamId));
}
function requireManagerOfClubParam(param='clubId'){
  return (req,res,next)=>{
    const u = me(req);
    if (!u || u.role!=='Manager' || String(u.teamId)!==String(req.params[param])) {
      return res.status(403).json({ error: 'Manager of this club only' });
    }
    next();
  };
}
function seasonKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function leaguePoints(pos){ pos=Number(pos||0); if(!pos) return 0; if(pos===1) return 100; if(pos===2) return 80; if(pos<=4) return 60; if(pos<=8) return 40; return 20; }
function tierFromPoints(points){ if(points>=120) return 'elite'; if(points>=60) return 'mid'; return 'bottom'; }
function getDailyPayoutLocal(r){ const tier=(r?.tier)||'mid'; return PAYOUTS[tier]||PAYOUTS.mid; }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function normUser(name){ return String(name||'').trim().toLowerCase(); }

/* =========================
   AUTH
========================= */
if (!ADMIN_PASSWORD) console.warn('[WARN] ADMIN_PASSWORD not set — admin login will fail until set.');
app.post('/api/admin/login', (req,res)=>{
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error:'ADMIN_PASSWORD not set' });
  if (!password || password!==ADMIN_PASSWORD) return res.status(403).json({ error:'Bad password' });
  req.session.admin = true;
  res.json({ ok:true });
});
app.post('/api/admin/logout', (req,res)=>{ req.session.admin=false; res.json({ ok:true }) });
app.get('/api/admin/me', (req,res)=> res.json({ admin:isAdminSession(req) }));

app.get('/api/auth/me', (req,res)=> res.json({ user: me(req) }));
app.post('/api/auth/logout', (req,res)=> req.session.destroy(()=> res.json({ ok:true })));

/* =========================
   MANAGER CODES (Single + BULK)
========================= */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(len=8){ return Array.from({length:len},()=> CODE_ALPHABET[Math.floor(Math.random()*CODE_ALPHABET.length)]).join(''); }

app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, async (req,res)=>{
  const { clubId } = req.params;
  const code = genCode(8);
  const hash = await bcrypt.hash(code, 10);
  const rec = await getDoc('clubCodes', clubId) || {};
  await setDoc('clubCodes', clubId, { hash, rotatedAt: Date.now(), claimedBy: rec.claimedBy || null });
  res.json({ ok:true, clubId, code });
});
app.post('/api/clubs/:clubId/manager-code/reset', requireAdmin, async (req,res)=>{
  const { clubId } = req.params;
  const rec = await getDoc('clubCodes', clubId);
  if (!rec) return res.status(400).json({ error:'No code set for this club' });
  await updateDoc('clubCodes', clubId, { claimedBy: null, rotatedAt: Date.now() });
  res.json({ ok:true });
});
app.post('/api/clubs/:clubId/claim-manager', async (req,res)=>{
  const { clubId } = req.params;
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error:'name and code required' });
  const rec = await getDoc('clubCodes', clubId);
  if (!rec) return res.status(400).json({ error:'No manager code set. Ask admin.' });
  const ok = await bcrypt.compare(String(code).trim(), rec.hash || '');
  if (!ok) return res.status(403).json({ error:'Invalid code' });
  if (rec.claimedBy) return res.status(409).json({ error:'Club already has a manager' });
  const id = uuidv4();
  const user = { id, name:String(name).trim(), role:'Manager', teamId:String(clubId) };
  await setDoc('users', id, user);
  await updateDoc('clubCodes', clubId, { claimedBy:id });
  req.session.user = user;
  res.json({ ok:true, user });
});

// BULK rotate manager codes (returns JSON + CSV)
// Body: { clubs: ["2491998","afc-warriors", ...] }
app.post('/api/admin/manager-codes/rotate-all', requireAdmin, async (req,res)=>{
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
});

// Export manager-code status (no plaintext codes)
// GET /api/admin/manager-codes/export
app.get('/api/admin/manager-codes/export', requireAdmin, async (req,res)=>{
  const snap = await COL.clubCodes().get();
  const rows = snap.docs.map(d=>{
    const x = d.data();
    return { clubId:d.id, hasCode: !!x.hash, claimedBy: x.claimedBy || '', rotatedAt: x.rotatedAt || 0 };
  });
  const csv = 'clubId,hasCode,claimedBy,rotatedAt\n' + rows.map(r=>`${r.clubId},${r.hasCode},${r.claimedBy},${r.rotatedAt}`).join('\n');
  res.json({ ok:true, count: rows.length, csv, rows });
});

/* =========================
   PLAYER CLAIM + FREE AGENTS
========================= */
app.post('/api/players/claim', async (req,res)=>{
  const { name, teamId='' } = req.body || {};
  if (!name) return res.status(400).json({ error:'name required' });
  const id = uuidv4();
  const user = { id, name:String(name).trim(), role:'Player', teamId: String(teamId||'') };
  await setDoc('users', id, user);
  req.session.user = user;
  res.json({ ok:true, user });
});

app.get('/api/free-agents', async (req,res)=>{
  const snap = await COL.agents().get();
  const agents = snap.docs.map(d=> d.data());
  res.json({ agents });
});
app.post('/api/free-agents/me', async (req,res)=>{
  let u = me(req);
  if (!u || u.role!=='Player') return res.status(403).json({ error:'Set Player role first' });
  const { name, positions='', region='', foot='', availability='', discord='', bio='' } = req.body || {};
  const agent = {
    id: u.id,
    name: name||u.name,
    positions: String(positions).split(',').map(s=>s.trim()).filter(Boolean),
    region: String(region||''),
    foot: String(foot||''),
    availability: String(availability||''),
    discord: String(discord||''),
    bio: String(bio||''),
    updatedAt: Date.now()
  };
  await setDoc('freeAgents', u.id, agent);
  res.json({ ok:true, agent });
});
app.delete('/api/free-agents/me', async (req,res)=>{
  let u = me(req);
  if (!u || u.role!=='Player') return res.status(403).json({ error:'Set Player role first' });
  await deleteDoc('freeAgents', u.id);
  res.json({ ok:true });
});

/* =========================
   RANKINGS / WALLETS / BONUSES
========================= */
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
  return (await getDoc('rankings', clubId)) || { leaguePos:'', cup:'none', points:0, tier:'mid' };
}
async function collectPreview(clubId){
  const w = await ensureWallet(clubId);
  const r = await getRanking(clubId);
  const perDay = getDailyPayoutLocal(r);
  const days = Math.floor((Date.now() - (w.lastCollectedAt || 0)) / 86_400_000);
  return { days, perDay, amount: Math.max(0, days * perDay) };
}

app.get('/api/rankings', async (req,res)=>{
  const all = await listAll('rankings');
  const map = {};
  for(const r of all) map[r.id] = { leaguePos:r.leaguePos||'', cup:r.cup||'none', points:r.points||0, tier:r.tier||'mid' };
  res.json({ rankings:map, payouts:PAYOUTS, cupPoints:CUP_POINTS });
});
app.post('/api/rankings/bulk', requireAdmin, async (req,res)=>{
  const payload = req.body?.rankings || {};
  const ops = [];
  for (const clubId of Object.keys(payload)) {
    const src = payload[clubId] || {};
    const leaguePos = Number(src.leaguePos || 0);
    const cup = String(src.cup || 'none');
    let tier = src.tier || 'mid';
    const points = leaguePoints(leaguePos) + (CUP_POINTS[cup]||0);
    if (!src.tier) tier = tierFromPoints(points);
    ops.push(setDoc('rankings', clubId, { leaguePos, cup, points, tier }));
  }
  await Promise.all(ops);
  res.json({ ok:true });
});
app.post('/api/rankings/recalc', requireAdmin, async (req,res)=>{
  const all = await listAll('rankings');
  await Promise.all(all.map(r=>{
    const points = leaguePoints(r.leaguePos||0) + (CUP_POINTS[r.cup||'none']||0);
    const tier = tierFromPoints(points);
    return setDoc('rankings', r.id, { leaguePos:r.leaguePos||0, cup:r.cup||'none', points, tier });
  }));
  res.json({ ok:true });
});

app.get('/api/wallets/:clubId', async (req,res)=>{
  const { clubId } = req.params;
  const w = await ensureWallet(clubId);
  const preview = await collectPreview(clubId);
  const r = await getRanking(clubId);
  res.json({ wallet:w, preview, perDay:getDailyPayoutLocal(r) });
});
app.post('/api/wallets/:clubId/collect', requireManagerOfClubParam('clubId'), async (req,res)=>{
  const { clubId } = req.params;
  const w = await ensureWallet(clubId);
  const preview = await collectPreview(clubId);
  if (preview.days <= 0) return res.json({ ok:false, message:'No payout available yet', preview });
  const newBal = (w.balance||0) + preview.amount;
  const newLast = (w.lastCollectedAt || 0) + preview.days * 86_400_000;
  await setDoc('wallets', clubId, { balance:newBal, lastCollectedAt:newLast });
  const updated = await ensureWallet(clubId);
  const rnk = await getRanking(clubId);
  res.json({ ok:true, wallet:updated, preview:await collectPreview(clubId), perDay:getDailyPayoutLocal(rnk) });
});

// Cup bonuses
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
    results.push({ clubId:r.id, cup, bonus, alreadyPaid:paid });
    willAward += bonus;
    if (!dryRun && bonus>0 && !paid){
      const w = await ensureWallet(r.id);
      await setDoc('wallets', r.id, { balance:(w.balance||0) + bonus, lastCollectedAt:w.lastCollectedAt||Date.now() });
      already[r.id] = bonus;
      actually += bonus;
    }
  }

  if (!dryRun) await awardsDocRef.set({ paid: already }, { merge:false });
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
  if (!/^\d+$/.test(clubId)) return res.json({ members: [] });
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
   ROSTERS (15 slots / club)
========================= */
function defaultSlots(){
  return Array.from({length:15}, (_,i)=> ({
    slotId: 'S'+(i+1), playerId:'', username:'', active:false, updatedAt: Date.now()
  }));
}
async function ensureRoster(clubId){
  const r = await getDoc('rosters', clubId);
  if (!r){
    const doc = { clubId, slots: defaultSlots(), updatedAt: Date.now() };
    await setDoc('rosters', clubId, doc);
    return doc;
  }
  if (!Array.isArray(r.slots) || r.slots.length<15){
    const have = r.slots || [];
    const need = defaultSlots();
    for (let i=0;i<15;i++){ if (!have[i]) have[i]=need[i]; }
    r.slots = have; r.updatedAt = Date.now();
    await setDoc('rosters', clubId, r);
  }
  return r;
}
async function getOrCreatePlayerByUsername(username){
  const uname = String(username||'').trim();
  if (!uname) return null;
  const unameLower = normUser(uname);
  const q = await COL.players().where('usernameLower','==', unameLower).limit(1).get();
  if (!q.empty){ const d = q.docs[0]; return { id:d.id, ...d.data() }; }
  const id = uuidv4();
  const doc = { id, username: uname, usernameLower: unameLower, currentTeamId:'', createdAt: Date.now() };
  await setDoc('players', id, doc);
  return doc;
}

app.get('/api/clubs/:clubId/roster', async (req,res)=>{
  const { clubId } = req.params;
  const r = await ensureRoster(clubId);
  res.json({ ok:true, roster: r });
});
app.put('/api/clubs/:clubId/roster', requireManagerOfClubParam('clubId'), async (req,res)=>{
  const { clubId } = req.params;
  const slotsPatch = Array.isArray(req.body?.slots) ? req.body.slots : [];
  if (!slotsPatch.length) return res.status(400).json({ error:'slots array required' });

  const roster = await ensureRoster(clubId);
  const map = new Map(roster.slots.map(s=>[s.slotId, s]));

  for (const p of slotsPatch){
    const slotId = String(p.slotId||'').trim();
    if (!map.has(slotId)) continue;
    const entry = map.get(slotId);
    const uname = (p.username||'').trim();

    if (!uname){
      entry.playerId = '';
      entry.username = '';
      entry.active = false;
      entry.updatedAt = Date.now();
    } else {
      const player = await getOrCreatePlayerByUsername(uname);
      if (!player) continue;
      entry.playerId = player.id;
      entry.username = player.username;
      entry.active = true;
      entry.updatedAt = Date.now();
      await updateDoc('players', player.id, { currentTeamId: clubId, lastSeenAt: Date.now() });
    }
  }

  roster.slots = Array.from(map.values());
  roster.updatedAt = Date.now();
  await setDoc('rosters', clubId, roster);
  res.json({ ok:true, roster });
});

/* =========================
   FIXTURES (League/Cup/Champions)
========================= */
app.post('/api/cup/fixtures', requireAdmin, async (req, res) => {
  const { home, away, round, cup='UPCL', group=null, when=null } = req.body || {};
  if (!home || !away) return res.status(400).json({ error:'home and away required' });
  if (home===away) return res.status(400).json({ error:'home and away cannot match' });

  const id = uuidv4();
  const fixture = {
    id,
    cup: String(cup),
    group: group ? String(group) : null,
    round: String(round || 'Round'),
    home: String(home), away: String(away),
    teams:[String(home), String(away)],
    status: when ? 'scheduled' : 'pending',
    when: when ? Number(when) : null,
    timeLockedAt: when ? Date.now() : null,
    proposals: [],         // [{ at:number, by: clubId }]
    votes: {},             // { "<timestamp>": { [clubId]: true|false } }
    lineups: { [home]:{ formation:'', lineup:{} }, [away]:{ formation:'', lineup:{} } },
    score: { hs:0, as:0 },
    report: { text:'', mvpHome:'', mvpAway:'', discordMsgUrl:'' },
    createdAt: Date.now()
  };
  await setDoc('fixtures', id, fixture);
  res.json({ ok:true, fixture });
});

async function listFixtures(req, res){
  const cup = (req.query.cup || 'UPCL').trim();
  const clubId = (req.query.clubId || '').trim();
  const snap = await COL.fixtures().where('cup','==',cup).get();
  let fixtures = snap.docs.map(d=> d.data());
  if (clubId) fixtures = fixtures.filter(f => f.home===clubId || f.away===clubId);
  res.json({ fixtures });
}
app.get('/api/cup/fixtures', listFixtures);
app.get('/api/cup/fixtures/public', listFixtures);
app.get('/api/cup/fixtures/scheduling', listFixtures);

app.get('/api/cup/fixtures/:id', async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  res.json({ fixture: f });
});

app.post('/api/cup/fixtures/:id/propose', async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req,res,f)) return res.status(403).json({ error:'Managers of these clubs only' });
  const at = Number(req.body?.at || 0);
  if (!at) return res.status(400).json({ error:'timestamp (ms) required' });
  f.proposals = f.proposals || [];
  f.votes = f.votes || {};
  const proposer = me(req).teamId;
  f.proposals.push({ at, by: proposer });
  f.votes[String(at)] = f.votes[String(at)] || {};
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture: f });
});

app.post('/api/cup/fixtures/:id/vote', async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req,res,f)) return res.status(403).json({ error:'Managers of these clubs only' });
  const at = String(req.body?.at || '');
  const agree = !!req.body?.agree;
  if (!at || !f.votes || !f.votes[at]) return res.status(400).json({ error:'invalid slot' });

  f.votes[at][me(req).teamId] = agree;

  if (f.votes[at][f.home] === true && f.votes[at][f.away] === true) {
    f.when = Number(at);
    f.status = 'scheduled';
    f.timeLockedAt = Date.now();
  }
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture:f });
});

app.put('/api/cup/fixtures/:id/lineup', async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req,res,f)) return res.status(403).json({ error:'Managers of these clubs only' });
  const { formation, lineup } = req.body || {};
  f.lineups = f.lineups || {};
  f.lineups[me(req).teamId] = { formation:String(formation||''), lineup: lineup && typeof lineup==='object' ? lineup : {} };
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture:f });
});

// Attach playerIds to details (home/away arrays)
async function attachPlayerIds(details){
  if (!details || typeof details!=='object') return details;
  for (const side of ['home','away']){
    const arr = Array.isArray(details[side]) ? details[side] : [];
    for (const item of arr){
      if (!item || !item.player) continue;
      const p = await getOrCreatePlayerByUsername(item.player);
      if (p) item.playerId = p.id;
    }
  }
  return details;
}

app.post('/api/cup/fixtures/:id/report', async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  if (!requireManagerOfFixture(req,res,f)) return res.status(403).json({ error:'Managers of these clubs only' });

  const { hs, as, text, mvpHome, mvpAway, discordMsgUrl, details } = req.body || {};
  f.score  = { hs: Number(hs||0), as: Number(as||0) };
  f.report = { text:String(text||''), mvpHome:String(mvpHome||''), mvpAway:String(mvpAway||''), discordMsgUrl:String(discordMsgUrl||'') };
  if (details && typeof details==='object') f.details = await attachPlayerIds(details);
  f.status = 'final';
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture:f });
});

// Admin quick-ingest from pasted text (stores text + score if "N-N" present)
app.post('/api/cup/fixtures/:id/ingest-text', requireAdmin, async (req,res)=>{
  const f = await getDoc('fixtures', req.params.id);
  if (!f) return res.status(404).json({ error:'not found' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error:'text required' });

  let hs = 0, as = 0;
  const m = text.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) { hs = Number(m[1]); as = Number(m[2]); }

  f.score = { hs, as };
  f.report = { ...(f.report||{}), text };
  f.status = 'final';
  await setDoc('fixtures', f.id, f);
  res.json({ ok:true, fixture:f });
});

/* =========================
   CHAMPIONS CUP (Groups)
========================= */
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
      (y.Pts-x.Pts) || (y.GD-x.GD) || (y.GF-x.GF));
  }
  return sorted;
}

// Save groups
app.post('/api/champions/:cupId/groups', requireAdmin, async (req,res)=>{
  const { cupId } = req.params;
  const groups = req.body?.groups || {};
  const doc = { cupId, groups:{
    A: groups.A||[], B: groups.B||[], C: groups.C||[], D: groups.D||[]
  }, createdAt: Date.now() };
  await setDoc('champions', cupId, doc);
  res.json({ ok:true, cup:doc });
});

// Randomize groups from 16 clubs
app.post('/api/champions/:cupId/randomize', requireAdmin, async (req,res)=>{
  const { cupId } = req.params;
  let clubs = Array.isArray(req.body?.clubs) ? req.body.clubs.slice() : [];
  if (clubs.length!==16) return res.status(400).json({ error:'Provide exactly 16 clubIds in body.clubs' });
  shuffle(clubs);
  const groups = { A:[], B:[], C:[], D:[] };
  clubs.forEach((id,i)=> groups[['A','B','C','D'][i%4]].push(String(id)));
  const doc = { cupId, groups, createdAt: Date.now() };
  await setDoc('champions', cupId, doc);
  res.json({ ok:true, cup:doc });
});

// Read state + live tables
app.get('/api/champions/:cupId', async (req,res)=>{
  const { cupId } = req.params;
  const d = await COL.champions().doc(cupId).get();
  const cup = d.exists ? d.data() : { cupId, groups:{A:[],B:[],C:[],D:[]}, createdAt: Date.now() };
  const tables = await computeGroupTables(cupId, cup.groups);
  res.json({ ok:true, cup, tables });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (env: ${NODE_ENV})`);
  console.log(`Firestore project: ${admin.app().options.projectId || '(loaded)'}`);
});
