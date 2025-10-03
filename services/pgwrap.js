const { pool } = require('../db');

function toBigIntParam(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const str = String(value).trim();
  if (!str) {
    return null;
  }
  if (!/^[-+]?\d+$/.test(str)) {
    throw new TypeError(`Invalid bigint value: ${value}`);
  }
  const num = Number(str);
  if (!Number.isFinite(num)) {
    // Fallback to BigInt to avoid NaN for very large ids
    return Number(BigInt(str));
  }
  return Math.trunc(num);
}

function toBigIntArray(values) {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : [values];
  const result = [];
  for (const val of arr) {
    const converted = toBigIntParam(val);
    if (converted !== null) {
      result.push(converted);
    }
  }
  return result;
}

async function q(text, params) {
  try { return await pool.query(text, params); }
  catch (err) {
    console.error('[PG ERROR]', {
      code: err.code, position: err.position, text, params
    });
    throw err;
  }
}
module.exports = { q, toBigIntParam, toBigIntArray };
