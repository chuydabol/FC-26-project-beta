async function loadHome(){
  const motdEl = document.getElementById('homeMotd');
  const newsEl = document.getElementById('homeNews');
  const clubsEl = document.getElementById('homeClubs');
  const standingsEl = document.getElementById('homeStandings');
  const scorersEl = document.getElementById('homeScorers');
  try {
    const [leagueRes, leadersRes, matchesRes, newsRes] = await Promise.all([
      apiGet('/api/league').catch(()=>({ standings: [] })),
      apiGet('/api/league/leaders').catch(()=>({ scorers: [] })),
      apiGet('/api/matches').catch(()=>({ matches: [] })),
      apiGet('/api/news').catch(()=>({ items: [] }))
    ]);
    renderHomeStandings(leagueRes.standings || []);
    renderHomeScorers(leadersRes.scorers || []);
    const match = (matchesRes.matches || [])[0];
    renderHomeMatch(match);
    renderHomeNews(newsRes.items || []);
    renderFeaturedClubs(leagueRes.standings || []);
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
  wrap.innerHTML = items.slice(0,3).map(renderNewsItem).join('') || '<div class="muted">No news yet.</div>';
}

function renderFeaturedClubs(standings){
  const el = document.getElementById('homeClubs');
  if(!el) return;
  const top = standings.slice(0,3);
  el.innerHTML = top.map(r=>{
    const club = byId(r.club_id);
    return `<div class="team-card" data-club-id="${club?.id || r.club_id}"><img class="team-logo" src="${teamLogoUrl(club)}" alt="${escapeHtml(club?.name || r.club_id)} logo"><div class="team-meta"><div class="name">${escapeHtml(club?.name || r.club_id)}</div></div></div>`;
  }).join('') || '<div class="muted">No clubs.</div>';
}

function renderHomeStandings(rows){
  const el = document.getElementById('homeStandings');
  if(!el) return;
  if(!rows.length){ el.innerHTML = '<div class="muted">No standings.</div>'; return; }
  const sorted = [...rows].sort((a,b)=>{
    if(b.points !== a.points) return b.points - a.points;
    if(b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
    return a.goals_against - b.goals_against;
  }).slice(0,5);
  const body = sorted.map((r,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(byId(r.club_id)?.name || r.club_id)}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td>${r.points}</td></tr>`).join('');
  el.innerHTML = `<table class="league-table"><thead><tr><th>#</th><th>Club</th><th>W</th><th>D</th><th>L</th><th>Pts</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderHomeScorers(rows){
  const el = document.getElementById('homeScorers');
  if(!el) return;
  if(!rows.length){ el.innerHTML = '<div class="muted">No data.</div>'; return; }
  const top = rows.slice(0,5);
  const clubIds = new Set();
  el.innerHTML = top.map(r=>{
    clubIds.add(r.club_id);
    const clubName = byId(r.club_id)?.name || r.club_id;
    return `<div class="stats-row" data-club-id="${r.club_id}"><img class="player-kit" src="/assets/silhouette.png" alt=""><div class="info"><div>${escapeHtml(r.name)}</div><div class="muted">${escapeHtml(clubName)}</div></div><div class="value">${r.count}</div></div>`;
  }).join('');
  clubIds.forEach(cid => renderClubKits(cid, el));
}
