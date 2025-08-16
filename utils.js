function normalizeId(id){
  return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function uniqueStrings(arr){
  const seen = new Set();
  const out = [];
  for (const id of arr || []) {
    const norm = normalizeId(id);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(id);
    }
  }
  return out;
}

function hasDuplicates(arr){
  const ids = (arr || []).map(normalizeId);
  return new Set(ids).size !== ids.length;
}

module.exports = { uniqueStrings, hasDuplicates, normalizeId };