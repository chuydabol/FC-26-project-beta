const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../logger');
const newsRepo = require('./newsRepository');
const { runAutoNews, generateAutoNews } = require('./newsGenerator');

const NEWS_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'news');
const MAX_UPLOAD_SIZE = 6 * 1024 * 1024; // 6MB

const ALLOWED_IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const AUTO_HYDRATE_INTERVAL_MS = 10 * 60 * 1000;
let lastAutoHydrate = 0;

function normalizeUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function ensureUploadDir() {
  await fs.promises.mkdir(NEWS_UPLOAD_DIR, { recursive: true });
}

function randomFileName(ext = 'png') {
  const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
  return `manual-${Date.now()}-${id}.${ext}`;
}

async function saveBase64Media(dataUrl) {
  if (!dataUrl) return null;
  const trimmed = String(dataUrl).trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  const ext = ALLOWED_IMAGE_TYPES[mime];
  if (!ext) {
    throw new Error('Unsupported image type');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return null;
  if (buffer.length > MAX_UPLOAD_SIZE) {
    throw new Error('Image too large');
  }
  await ensureUploadDir();
  const file = randomFileName(ext);
  await fs.promises.writeFile(path.join(NEWS_UPLOAD_DIR, file), buffer);
  return `/uploads/news/${file}`;
}

function computeBadge(item) {
  if (item.type === 'auto') {
    return item.payload?.badge || 'Auto Update';
  }
  return item.payload?.badge || 'Community Post';
}

function normalizeNewsRecord(row) {
  const item = { ...row };
  item.badge = computeBadge(row);
  item.meta = row.payload?.meta || null;
  if (item.type === 'auto') {
    if (row.payload?.slug) {
      item.id = row.payload.slug;
    }
    if (Array.isArray(row.payload?.stats)) {
      item.stats = row.payload.stats;
    }
  }
  return item;
}

function buildSyntheticAutoRows(items, nowMs) {
  if (!Array.isArray(items) || !items.length) return [];
  const stamp = new Date(nowMs).toISOString();
  return items
    .filter(Boolean)
    .map(item => ({
      id: item.payload?.slug || item.id || null,
      type: 'auto',
      title: item.title,
      body: item.body,
      mediaUrl: item.mediaUrl,
      createdAt: item.createdAt || item.expiresAt || stamp,
      expiresAt: item.expiresAt,
      payload: item.payload || {},
      author: item.author || 'Auto Desk'
    }));
}

async function listNews(limit = 40) {
  let rows = await newsRepo.listRecent(limit);
  let hasAuto = rows.some(item => item.type === 'auto');
  const now = Date.now();
  if (!hasAuto && now - lastAutoHydrate > AUTO_HYDRATE_INTERVAL_MS) {
    lastAutoHydrate = now;
    try {
      const inserted = await runAutoNews();
      if (inserted.length) {
        rows = await newsRepo.listRecent(limit);
      }
      hasAuto = rows.some(item => item.type === 'auto');
      if (!hasAuto) {
        let syntheticRows = buildSyntheticAutoRows(inserted, now);
        if (!syntheticRows.length) {
          const ephemeral = await generateAutoNews(now);
          syntheticRows = buildSyntheticAutoRows(ephemeral, now);
        }
        if (syntheticRows.length) {
          rows = rows.concat(syntheticRows);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'On-demand auto news generation failed');
    }
  }
  return rows.map(normalizeNewsRecord);
}

async function createManualNews({ title, body, mediaData, mediaUrl, author }) {
  if (!title || !String(title).trim()) {
    throw new Error('Title required');
  }
  if (!body || !String(body).trim()) {
    throw new Error('Body required');
  }
  let storedMedia = null;
  if (mediaData) {
    storedMedia = await saveBase64Media(mediaData);
  } else if (mediaUrl) {
    storedMedia = normalizeUrl(mediaUrl);
  }
  const resolvedAuthor = (author && String(author).trim()) || 'Community Reporter';
  const badge = /admin/i.test(resolvedAuthor) ? 'League Bulletin' : 'Community Post';
  const record = await newsRepo.insertNews({
    type: 'manual',
    title: String(title).trim(),
    body: String(body).trim(),
    mediaUrl: storedMedia,
    author: resolvedAuthor,
    payload: {
      badge
    }
  });
  return normalizeNewsRecord(record);
}

async function deleteManualNews(id) {
  if (!id) return false;
  const deleted = await newsRepo.deleteManual(Number(id));
  return deleted;
}

async function pruneExpired() {
  await newsRepo.pruneExpired().catch(err => logger.warn({ err }, 'Failed to prune expired news'));
}

async function generateAutoBatch() {
  return runAutoNews();
}

module.exports = {
  listNews,
  createManualNews,
  deleteManualNews,
  pruneExpired,
  generateAutoBatch
};
