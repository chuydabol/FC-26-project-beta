function uniqueStrings(arr){
  return Array.from(new Set((arr||[]).map(id => String(id))));
}

function hasDuplicates(arr){
  const ids = (arr||[]).map(id => String(id));
  return new Set(ids).size !== ids.length;
}

module.exports = { uniqueStrings, hasDuplicates };
