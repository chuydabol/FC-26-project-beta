// server.js
// Express + Firestore league backend (admin+manager scheduling + results upload)

const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// lazy node-fetch import (works on Render)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const { db } = require('./firebase'); // your firebase.js exports { admin, db }

const app = express();
const PORT = process.env.PORT || 3001;

// ---------- config ----------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD not set. Admin login will fail until you set it.');
}

app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: 'lax' },
  })
);

// Static
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ---------- collections helpers ----------
const COL = {
  users: () => db.collection('users'),
  clubs: () => db.collection('clubs'),
  fixtures: () => db.collection('fixtures'),
  wallets: () => db.collection('wallets'),
  rankings: () => db.collection('rankings'), // doc per clubId
  freeAgents: () => db.collection('freeAgents'),
  meta: () => db.collection('meta'), // for payouts config, etc.
};

async function getDoc(col, id) {
  const snap = await db.collection(col).doc(id).get();
  return snap.exists ? snap.data() : null;
}
async function setDoc(col, id, data) {
  await db.collection(col).doc(id).set(data, { merge: false });
  return data;
}
async function mergeDoc(col, id, data) {
  await db.collection(col).doc(id).set(data, { merge: true });
  const snap = await db.collection(col).doc(id).get();
  return snap.data();
}

// ---------- auth middlewares ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(403).json({ error: 'Admin only' });
}
function requireManagerAny(req, res, next) {
  const u = req.session && req.session.user;
  if (u && u.role === 'Manager') return next();
  return res.status(403).json({ error: 'Managers only' });
}
function requireManagerOrAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  const u = req.session && req.session.user;
  if (u && u.role === 'Manager') return next();
  return res.status(403).json({ error: 'Managers or Admins only' });
}
function isManagerOfFixture(req, f) {
  const u = req.session && req.session.user;
  return !!(u && u.role === 'Manager' && [f.home, f.away].includes(u.teamId));
}

// ---------- admin auth ----------
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured on server' });
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Bad password' });
  req.session.admin = true;
  return res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.admin = false;
  return res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: !!(req.session && req.session.admin) });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- clubs: manager codes & claim ----------
function genManagerCode() {
  // 8-char alphanumeric
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// rotate a new code (admin)
app.post('/api/clubs/:clubId/manager-code/rotate', requireAdmin, async (req, res) => {
  const clubId = String(req.params.clubId);
  const code = genManagerCode();
  const hash = bcrypt.hashSync(code, 10);
  await mergeDoc('clubs', clubId, {
    id: clubId,
    managerCodeHash: hash,
    // keep current seat
  });
  res.json({ ok: true, clubId, code });
});

// reset seat (admin) — frees the seat, code stays the same
app.post('/api/clubs/:clubId/manager-code/reset', requireAdmin, async (req, res) => {
  const clubId = String(req.params.clubId);
  await mergeDoc('clubs', clubId, { id: clubId, managerUserId: '' });
  res.json({ ok: true, clubId });
});

// claim manager (with code)
app.post('/api/clubs/:clubId/claim-manager', async (req, res) => {
  const clubId = String(req.params.clubId);
  const { name, code } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });

  const club = (await getDoc('clubs', clubId)) || {};
  if (!club.managerCodeHash) return res.status(400).json({ error: 'No manager code has been set for this club' });
  if (club.managerUserId) return res.status(409).json({ error: 'Manager seat already taken. Ask admin to reset.' });

  const ok = bcrypt.compareSync(code, club.managerCodeHash);
  if (!ok) return res.status(401).json({ error: 'Invalid code' });

  const id = uuidv4();
  const user = { id, name: String(name).trim(), role: 'Manager', teamId: clubId };
  await setDoc('users', id, user);
  await mergeDoc('clubs', clubId, { id: clubId, managerUserId: id });

  req.session.user = user;
  res.json({ ok: true, user });
});

// ---------- player role + free agents ----------
app.post('/api/players/claim', async (req, res) => {
  const { name, teamId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const user = { id, name: String(name).trim(), role: 'Player', teamId: teamId ? String(teamId) : '' };
  await setDoc('users', id, user);
  req.session.user = user;
  res.json({ ok: true, user });
});

// Free agents
app.get('/api/free-agents', async (req, res) => {
  const snap = await COL.freeAgents().orderBy('listedAt', 'desc').get();
  res.json({ agents: snap.docs.map(d => d.data()) });
});

function requirePlayerOrManager(req, res, next) {
  const u = req.session && req.session.user;
  if (u && (u.role === 'Player' || u.role === 'Manager')) return next();
  return res.status(403).json({ error: 'Players or Managers only' });
}

app.post('/api/free-agents/me', requirePlayerOrManager, async (req, res) => {
  const u = req.session.user;
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
});

app.delete('/api/free-agents/me', requirePlayerOrManager, async (req, res) => {
  await COL.freeAgents().doc(req.session.user.id).delete();
  res.json({ ok: true });
});

// ---------- rankings & payouts ----------
const DEFAULT_PAYOUTS = { elite: 20000, mid: 14000, bottom: 9000 }; // per day example
function tierForPos(pos) {
  if (!pos || pos <= 0) return 'mid';
  if (pos <= 4) return 'elite';
  if (pos <= 8) return 'mid';
  return 'bottom';
}

app.get('/api/rankings', async (req, res) => {
  const snap = await COL.rankings().get();
  const obj = {};
  snap.forEach(d => (obj[d.id] = d.data()));
  const payoutsDoc = await COL.meta().doc('payouts').get();
  const payouts = payoutsDoc.exists ? payoutsDoc.data() : DEFAULT_PAYOUTS;
  res.json({ rankings: obj, payouts });
});

app.post('/api/rankings/bulk', requireAdmin, async (req, res) => {
  const { rankings = {} } = req.body || {};
  const batch = db.batch();
  Object.entries(rankings).forEach(([clubId, r]) => {
    const ref = COL.rankings().doc(clubId);
    const leaguePos = Number(r.leaguePos || 0);
    const cup = String(r.cup || 'none');
    const tier = tierForPos(leaguePos);
    batch.set(ref, { id: clubId, leaguePos, cup, tier }, { merge: true });
  });
  await batch.commit();
  res.json({ ok: true });
});

app.post('/api/rankings/recalc', requireAdmin, async (req, res) => {
  const snap = await COL.rankings().get();
  const batch = db.batch();
  snap.forEach(doc => {
    const r = doc.data();
    const leaguePos = Number(r.leaguePos || 0);
    const tier = tierForPos(leaguePos);
    batch.set(doc.ref, { tier }, { merge: true });
  });
  await batch.commit();
  res.json({ ok: true });
});

// Optional: cup bonuses
const CUP_BONUSES = {
  winner: 150000,
  runner_up: 90000,
  semifinal: 50000,
  quarterfinal: 25000,
  round_of_16: 12000,
  none: 0
};
app.post('/api/bonuses/cup', requireAdmin, async (req, res) => {
  const { dryRun = true } = req.body || {};
  const rs = await COL.rankings().get();
  let total = 0;
  const ops = [];
  rs.forEach(d => {
    const r = d.data();
    const bonus = CUP_BONUSES[r.cup || 'none'] || 0;
    if (bonus > 0) {
      total += bonus;
      ops.push({ clubId: r.id, bonus });
    }
  });
  if (dryRun) return res.json({ ok: true, totalAwarded: total, ops });

  // pay into wallets
  const batch = db.batch();
  for (const { clubId, bonus } of ops) {
    const ref = COL.wallets().doc(clubId);
    batch.set(ref, { id: clubId, balance: (await ref.get()).exists ? (await ref.get()).data().balance + bonus : bonus, lastCollected: (await ref.get()).exists ? (await ref.get()).data().lastCollected || 0 : 0 }, { merge: true });
  }
  await batch.commit();
  res.json({ ok: true, totalAwarded: total, ops });
});

// ---------- wallets ----------
async function getPayouts() {
  const doc = await COL.meta().doc('payouts').get();
  return doc.exists ? doc.data() : DEFAULT_PAYOUTS;
}
app.get('/api/wallets/:clubId', async (req, res) => {
  const clubId = String(req.params.clubId);
  const wdoc = await COL.wallets().doc(clubId).get();
  const wallet = wdoc.exists ? wdoc.data() : { id: clubId, balance: 0, lastCollected: 0 };
  const r = await getDoc('rankings', clubId);
  const payouts = await getPayouts();
  const tier = (r && r.tier) || 'mid';
  const perDay = payouts[tier] || 0;

  const now = Date.now();
  const last = Number(wallet.lastCollected || 0) || 0;
  const days = Math.max(0, Math.floor((now - last) / (24 * 3600 * 1000)));
  const amount = days * perDay;

  res.json({ wallet, perDay, preview: { days, amount } });
});

app.post('/api/wallets/:clubId/collect', async (req, res) => {
  const clubId = String(req.params.clubId);
  const isAdmin = !!(req.session && req.session.admin);
  const user = req.session.user;
  if (!isAdmin) {
    if (!(user && user.role === 'Manager' && String(user.teamId) === clubId)) {
      return res.status(403).json({ error: 'Only this club manager (or admin) can collect' });
    }
  }
  const wref = COL.wallets().doc(clubId);
  const wdoc = await wref.get();
  const wallet = wdoc.exists ? wdoc.data() : { id: clubId, balance: 0, lastCollected: 0 };

  const r = await getDoc('rankings', clubId);
  const payouts = await getPayouts();
  const tier = (r && r.tier) || 'mid';
  const perDay = payouts[tier] || 0;

  const now = Date.now();
  const last = Number(wallet.lastCollected || 0) || 0;
  const days = Math.max(0, Math.floor((now - last) / (24 * 3600 * 1000)));
  const amount = days * perDay;

  if (amount <= 0) return res.json({ ok: false, message: 'Nothing to collect yet' });

  await wref.set({ id: clubId, balance: (wallet.balance || 0) + amount, lastCollected: now }, { merge: true });
  res.json({ ok: true, collected: amount, balance: (wallet.balance || 0) + amount });
});

// ---------- fixtures ----------
app.post('/api/cup/fixtures', requireAdmin, async (req, res) => {
  const { home, away, round = '', cup = 'UPCL' } = req.body || {};
  if (!home || !away) return res.status(400).json({ error: 'home and away required' });
  const id = uuidv4();
  const f = {
    id, cup, round,
    home: String(home), away: String(away),
    status: 'pending',
    proposals: [], // {at}
    votes: {},     // {teamId: {at, agree}}
    lineups: {},   // {teamId: { formation, lineup }}
    score: { hs: 0, as: 0 },
    details: { home: [], away: [] },
    createdAt: Date.now(),
    when: null
  };
  await setDoc('fixtures', id, f);
  res.json({ ok: true, fixture: f });
});

// SCHEDULING (Managers or Admins can read)
app.get('/api/cup/fixtures/scheduling', requireManagerOrAdmin, async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const snap = await COL.fixtures().where('cup', '==', cup).get();
  res.json({ fixtures: snap.docs.map(d => d.data()) });
});

// PUBLIC feed (sanitized)
app.get('/api/cup/fixtures/public', async (req, res) => {
  const cup = (req.query.cup || 'UPCL').trim();
  const snap = await COL.fixtures().where('cup', '==', cup).get();
  const list = snap.docs.map(d => {
    const f = d.data();
    return {
      id: f.id, cup: f.cup, round: f.round,
      home: f.home, away: f.away,
      when: f.when || null, status: f.status,
      score: f.score || { hs: 0, as: 0 },
      details: f.details || { home: [], away: [] },
      createdAt: f.createdAt || 0
    };
  });
  res.json({ fixtures: list });
});

// propose time (managers of these clubs only)
app.post('/api/cup/fixtures/:id/propose', requireManagerOrAdmin, async (req, res) => {
  const id = String(req.params.id);
  const { at } = req.body || {};
  if (!at) return res.status(400).json({ error: 'at required' });
  const f = await getDoc('fixtures', id);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!isManagerOfFixture(req, f) && !(req.session && req.session.admin)) {
    return res.status(403).json({ error: 'Managers of these clubs only' });
  }
  const exists = (f.proposals || []).some(p => Number(p.at) === Number(at));
  if (!exists) f.proposals = [...(f.proposals || []), { at: Number(at) }];
  await setDoc('fixtures', id, f);
  res.json({ ok: true, fixture: f });
});

// vote on proposal (agree/decline)
app.post('/api/cup/fixtures/:id/vote', requireManagerOrAdmin, async (req, res) => {
  const id = String(req.params.id);
  const { at, agree } = req.body || {};
  const f = await getDoc('fixtures', id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const isAdmin = !!(req.session && req.session.admin);
  if (!isManagerOfFixture(req, f) && !isAdmin) {
    return res.status(403).json({ error: 'Managers of these clubs only' });
  }
  const u = req.session.user;
  const teamId = isAdmin ? 'admin' : u.teamId;
  f.votes = f.votes || {};
  f.votes[teamId] = { at: Number(at), agree: !!agree };
  // If both teams agreed on the same time, set it
  const vHome = f.votes[f.home];
  const vAway = f.votes[f.away];
  if (vHome && vAway && vHome.agree && vAway.agree && Number(vHome.at) === Number(vAway.at)) {
    f.when = Number(vHome.at);
    f.status = 'scheduled';
  }
  await setDoc('fixtures', id, f);
  res.json({ ok: true, fixture: f });
});

// set lineup (per team)
app.put('/api/cup/fixtures/:id/lineup', requireManagerOrAdmin, async (req, res) => {
  const id = String(req.params.id);
  const { formation = '', lineup = {} } = req.body || {};
  const f = await getDoc('fixtures', id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const isAdmin = !!(req.session && req.session.admin);
  if (!isManagerOfFixture(req, f) && !isAdmin) {
    return res.status(403).json({ error: 'Managers of these clubs only' });
  }
  const teamId = isAdmin ? 'admin' : req.session.user.teamId;
  f.lineups = f.lineups || {};
  f.lineups[teamId] = { formation, lineup, at: Date.now() };
  await setDoc('fixtures', id, f);
  res.json({ ok: true, fixture: f });
});

// report final (ADMIN OR the two managers)
app.post('/api/cup/fixtures/:id/report', async (req, res) => {
  const id = String(req.params.id);
  const f = await getDoc('fixtures', id);
  if (!f) return res.status(404).json({ error: 'not found' });

  const isAdmin = !!(req.session && req.session.admin);
  if (!isAdmin) {
    if (!isManagerOfFixture(req, f)) {
      return res.status(403).json({ error: 'Managers of these clubs only (or admin)' });
    }
  }

  const { hs, as, text, mvpHome, mvpAway, discordMsgUrl, details } = req.body || {};
  f.score = { hs: Number(hs || 0), as: Number(as || 0) };
  f.report = {
    text: String(text || ''),
    mvpHome: String(mvpHome || ''),
    mvpAway: String(mvpAway || ''),
    discordMsgUrl: String(discordMsgUrl || ''),
  };
  if (details && typeof details === 'object') {
    f.details = { home: details.home || [], away: details.away || [] };
  }
  f.status = 'final';
  if (!f.when) f.when = Date.now();
  await setDoc('fixtures', id, f);
  res.json({ ok: true, fixture: f });
});

// admin text ingest -> scorers & score
app.post('/api/cup/fixtures/:id/ingest-text', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const f = await getDoc('fixtures', id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const parsed = parseLooseResultText(text, f);
  if (!parsed) return res.status(400).json({ error: 'could not parse input' });
  f.score = parsed.score;
  f.details = parsed.details;
  f.status = 'final';
  if (!f.when) f.when = Date.now();
  await setDoc('fixtures', id, f);
  res.json({ ok: true, fixture: f });
});

// simple parser for your quick text format
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

    // crude team switches (customize with your team names as needed)
    const homeKeys = ['home', 'gungan', 'gungan fc', (f.home || '').toLowerCase()];
    const awayKeys = ['away', 'frijol', 'club frijol', (f.away || '').toLowerCase()];
    if (homeKeys.some(k => k && low.includes(k))) { commit(); side = 'home'; continue; }
    if (awayKeys.some(k => k && low.includes(k))) { commit(); side = 'away'; continue; }

    let m = t.match(/score\s*:\s*(\d+)/i);
    if (m) { if (side === 'home') score.hs = Number(m[1]); else score.as = Number(m[1]); continue; }

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

// ---------- EA members passthrough ----------
app.get('/api/teams/:clubId/players', async (req, res) => {
  const { clubId } = req.params;
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return res.status(response.status).json({ error: `EA API error: ${response.statusText}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'EA API timed out' });
    console.error('EA fetch error', err);
    res.status(500).json({ error: 'Failed to fetch EA members' });
  }
});

// ---------- SPA root ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teams.html'));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
