const express = require('express');
const path = require('path');
const fs = require('fs');
// If you use a .env file, uncomment the next line and `npm i dotenv`
// require('dotenv').config();

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;

/* ========= CONFIG ========= */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // if set, write endpoints require X-Admin-Token header
const STARTING_BALANCE = Number(process.env.DAILY_STARTING_BALANCE || 5000);
const PAYOUTS = {
  elite: Number(process.env.PAYOUT_ELITE || 1100000),
  mid: Number(process.env.PAYOUT_MID || 900000),
  bottom: Number(process.env.PAYOUT_BOTTOM || 700000),
};

/* ========= STORAGE (JSON files) ========= */
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const rankingsFile = path.join(dataDir, 'rankings.json');
const walletsFile = path.join(dataDir, 'wallets.json');

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

let rankings = readJson(rankingsFile, {}); // { [clubId]: { leaguePos, cup, points, tier } }
let wallets  = readJson(walletsFile,  {}); // { [clubId]: { balance, lastCollectedAt } }

/* ========= POINTS / TIERS / PAYOUTS ========= */
const CUP_POINTS = { winner:60, runner_up:40, semifinal:25, quarterfinal:15, round_of_16:10, none:0 };

function leaguePoints(pos) {
  pos = Number(pos || 0);
  if (!pos) return 0;
  if (pos === 1) return 100;
  if (pos === 2) return 80;
  if (pos <= 4) return 60;
  if (pos <= 8) return 40;
  return 20;
}
function tierFromPoints(points){
  if (points >= 120) return 'elite';
  if (points >= 60)  return 'mid';
  return 'bottom';
}
function getDailyPayout(clubId) {
  const tier = (rankings[clubId]?.tier) || 'mid';
  return PAYOUTS[tier] || PAYOUTS.mid;
}
function ensureWallet(clubId) {
  if (!wallets[clubId]) {
    wallets[clubId] = { balance: STARTING_BALANCE, lastCollectedAt: Date.now() - 86_400_000 }; // seed 1-day pending
  }
}
function collectPreview(clubId) {
  ensureWallet(clubId);
  const w = wallets[clubId];
  const days = Math.floor((Date.now() - (w.lastCollectedAt || 0)) / 86_400_000);
  const perDay = getDailyPayout(clubId);
  return { days, perDay, amount: Math.max(0, days * perDay) };
}

/* ========= MIDDLEWARE ========= */
app.use(express.json());

// Static site (your HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));
// Explicit assets mount
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// Simple admin guard for write endpoints
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // open if no token configured
  if (req.get('x-admin-token') === ADMIN_TOKEN) return next();
  return res.status(403).json({ error: 'Forbidden: missing or invalid X-Admin-Token' });
}

/* ========= PAGES ========= */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teams.html'));
});

/* ========= EA PRO CLUBS PASS-THROUGH ========= */
app.get('/api/teams/:clubId/players', async (req, res) => {
  const { clubId } = req.params;
  const url = `https://proclubs.ea.com/api/fc/members/stats?platform=common-gen5&clubId=${clubId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch from EA API: ${response.statusText}` });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'EA API timed out' });
    }
    console.error('Error fetching players from EA API:', err);
    return res.status(500).json({ error: 'Failed to fetch players from EA API' });
  }
});

/* ========= RANKINGS API ========= */
// Read rankings + current payout settings
app.get('/api/rankings', (req, res) => {
  res.json({ rankings, payouts: PAYOUTS, cupPoints: CUP_POINTS });
});

// Upsert one club
app.put('/api/rankings/:clubId', requireAdmin, (req, res) => {
  const { clubId } = req.params;
  const { leaguePos, cup, tier } = req.body || {};
  const r = rankings[clubId] || { leaguePos: '', cup: 'none', points: 0, tier: 'mid' };

  if (leaguePos !== undefined) r.leaguePos = Number(leaguePos || 0);
  if (cup !== undefined)       r.cup = String(cup || 'none');
  r.points = leaguePoints(r.leaguePos) + (CUP_POINTS[r.cup] || 0);
  if (tier) r.tier = tier;

  rankings[clubId] = r;
  writeJson(rankingsFile, rankings);
  res.json({ ok: true, ranking: r, perDay: getDailyPayout(clubId) });
});

// Bulk upsert { rankings: { clubId: { leaguePos, cup, tier? }, ... } }
app.post('/api/rankings/bulk', requireAdmin, (req, res) => {
  const payload = req.body?.rankings || {};
  Object.keys(payload).forEach(clubId => {
    const src = payload[clubId] || {};
    const r = rankings[clubId] || { leaguePos: '', cup: 'none', points: 0, tier: 'mid' };
    if ('leaguePos' in src) r.leaguePos = Number(src.leaguePos || 0);
    if ('cup' in src)       r.cup       = String(src.cup || 'none');
    if ('tier' in src && src.tier) r.tier = src.tier;
    r.points = leaguePoints(r.leaguePos) + (CUP_POINTS[r.cup] || 0);
    rankings[clubId] = r;
  });
  writeJson(rankingsFile, rankings);
  res.json({ ok: true, rankings });
});

// Recalculate tiers from points
app.post('/api/rankings/recalc', requireAdmin, (req, res) => {
  Object.keys(rankings).forEach(clubId => {
    const r = rankings[clubId];
    r.points = leaguePoints(r.leaguePos) + (CUP_POINTS[r.cup] || 0);
    r.tier = tierFromPoints(r.points);
  });
  writeJson(rankingsFile, rankings);
  res.json({ ok: true, rankings });
});

/* ========= WALLETS API ========= */
app.get('/api/wallets/:clubId', (req, res) => {
  const { clubId } = req.params;
  ensureWallet(clubId);
  const w = wallets[clubId];
  const preview = collectPreview(clubId);
  res.json({ wallet: w, preview, perDay: getDailyPayout(clubId) });
});

app.post('/api/wallets/:clubId/collect', (req, res) => {
  const { clubId } = req.params;
  ensureWallet(clubId);
  const preview = collectPreview(clubId);
  if (preview.days <= 0) return res.json({ ok: false, message: 'No payout available yet', preview });

  wallets[clubId].balance += preview.amount;
  wallets[clubId].lastCollectedAt = wallets[clubId].lastCollectedAt + preview.days * 86_400_000;
  writeJson(walletsFile, wallets);

  const updated = { wallet: wallets[clubId], preview: collectPreview(clubId), perDay: getDailyPayout(clubId) };
  res.json({ ok: true, ...updated });
});
// after your other routes, before app.listen
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

/* ========= START ========= */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
