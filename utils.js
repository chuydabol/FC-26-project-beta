function normalizeId(id){
  return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function uniqueStrings(arr){
  return Array.from(new Set((arr || []).map(normalizeId)));
}

function hasDuplicates(arr){
  const ids = (arr || []).map(normalizeId);
  return new Set(ids).size !== ids.length;
}

module.exports = { uniqueStrings, hasDuplicates, normalizeId };
