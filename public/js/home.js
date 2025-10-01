async function loadHome(){
  const motdEl = document.getElementById('homeMotd');
  try {
    const [leagueData, newsRes] = await Promise.all([
      fetchLeagueData(),
      apiGet('/api/news').catch(()=>({ items: [] }))
    ]);
    const standingsComputed = renderStandings(
      leagueData.standings || [],
      leagueData.matches || [],
      leagueData.playerStandings || []
    );
    renderTopScorers(leagueData.scorers || []);
    const match = (leagueData.matches || [])[0];
    renderHomeMatch(match);
    renderHomeNews(newsRes.items || []);
    renderFeaturedClubs(standingsComputed);
  } catch (e) {
    if (motdEl) motdEl.textContent = 'Failed to load.';
  }
}

function renderHomeMatch(m){
  const el = document.getElementById('homeMotd');
  if(!el) return;
  if(!m){ el.innerHTML = '<div class="muted">No match data.</div>'; return; }
  const ids = Object.keys(m.clubs || {});
  if(ids.length < 2){ el.innerHTML = '<div class="muted">No match data.</div>'; return; }
  const [a,b] = ids;
  const A = m.clubs[a];
  const B = m.clubs[b];
  const an = byId(a)?.name || A.details?.name || a;
  const bn = byId(b)?.name || B.details?.name || b;
  const score = `${A.goals}–${B.goals}`;
  el.innerHTML = `<div class="fx-vs"><span class="fx-team"><img src="${teamLogoUrl(byId(a))}" alt=""><span>${escapeHtml(an)}</span></span><span class="muted">${score}</span><span class="fx-team"><img src="${teamLogoUrl(byId(b))}" alt=""><span>${escapeHtml(bn)}</span></span></div>`;
}

function renderHomeNews(items){
  const wrap = document.getElementById('homeNews');
  if(!wrap) return;
  const sorted = [...(items || [])]
    .sort((a,b)=> new Date(b.createdAt || b.ts || 0) - new Date(a.createdAt || a.ts || 0))
    .slice(0,3);
  renderNewsCollection(wrap, sorted, '<div class="muted">No news yet.</div>');
}

function renderFeaturedClubs(standings){
  const el = document.getElementById('homeClubs');
  if(!el) return;
  const top = (standings || []).slice(0,3);
  el.innerHTML = top.map(r=>{
    const club = byId(r.clubId) || byId(r.club_id);
    const id = club?.id || r.clubId || r.club_id;
    const name = club?.name || r.name || id;
    return `<div class="team-card" data-club-id="${id}"><img class="team-logo" src="${teamLogoUrl(club)}" alt="${escapeHtml(name)} logo"><div class="team-meta"><div class="name">${escapeHtml(name)}</div></div></div>`;
  }).join('') || '<div class="muted">No clubs.</div>';
}
