const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizePlayerMatchStats } = require('../db');

test('normalizePlayerMatchStats extracts EA player stats from a match payload', () => {
  const stats = normalizePlayerMatchStats({
    id: 'match-1',
    raw: {
      clubs: {
        57985: { details: { name: 'Bota FC' } },
        123: { details: { name: 'Rivals FC' } },
      },
      players: {
        57985: {
          111: {
            playername: 'Striker One',
            pos: 'forward',
            goals: '2',
            assists: '1',
            passattempts: '20',
            passesmade: '18',
            tackleattempts: '4',
            tacklesmade: '3',
            mom: '1',
          },
        },
        123: {
          222: {
            playername: 'Keeper Two',
            goals: '0',
            assists: '0',
          },
        },
      },
    },
  }, { id: '57985', name: 'Bota FC' });

  assert.equal(stats.length, 2);
  const striker = stats.find(stat => stat.ea_player_id === '111');
  const keeper = stats.find(stat => stat.ea_player_id === '222');
  assert.deepEqual(striker, {
    match_id: 'match-1',
    ea_player_id: '111',
    player_name: 'Striker One',
    club_id: '57985',
    club_name: 'Bota FC',
    position: 'forward',
    goals: 2,
    assists: 1,
    passes_attempted: 20,
    passes_made: 18,
    tackles_attempted: 4,
    tackles_made: 3,
    man_of_the_match: true,
    raw_json: {
      playername: 'Striker One',
      pos: 'forward',
      goals: '2',
      assists: '1',
      passattempts: '20',
      passesmade: '18',
      tackleattempts: '4',
      tacklesmade: '3',
      mom: '1',
    },
  });
  assert.equal(keeper.player_name, 'Keeper Two');
  assert.equal(keeper.club_name, 'Rivals FC');
});

test('normalizePlayerMatchStats returns no rows when EA player data is absent', () => {
  assert.deepEqual(normalizePlayerMatchStats({ id: 'match-without-players', raw: {} }), []);
});


test('normalizePlayerMatchStats uses EA nested player and club keys instead of missing player fields', () => {
  const stats = normalizePlayerMatchStats({
    match_id: 'row-match-1',
    raw_json: {
      clubs: {
        57985: { details: { name: 'Bota FC' } },
      },
      players: {
        57985: {
          111: {
            ea_player_id: 'wrong-player-field',
            club_id: 'wrong-club-field',
            club_name: 'Wrong Club Name',
            playername: 'Nested Key Player',
            pos: 'midfielder',
            goals: '1',
            assists: '2',
            passattempts: '9',
            passesmade: '7',
            tackleattempts: '3',
            tacklesmade: '2',
            mom: '0',
          },
        },
      },
    },
  });

  assert.equal(stats.length, 1);
  assert.equal(stats[0].match_id, 'row-match-1');
  assert.equal(stats[0].ea_player_id, '111');
  assert.equal(stats[0].club_id, '57985');
  assert.equal(stats[0].club_name, 'Bota FC');
  assert.equal(stats[0].player_name, 'Nested Key Player');
  assert.equal(stats[0].position, 'midfielder');
  assert.equal(stats[0].passes_attempted, 9);
  assert.equal(stats[0].passes_made, 7);
  assert.equal(stats[0].tackles_attempted, 3);
  assert.equal(stats[0].tackles_made, 2);
  assert.equal(stats[0].man_of_the_match, false);
});

test('league club aliases include only registered UPCL teams for player stat filtering', () => {
  const { getLeagueClubAliasRows, normalizeLeagueClubName } = require('../db');
  const aliases = getLeagueClubAliasRows();
  const normalizedAliases = aliases.map(row => row.alias);

  assert.deepEqual(new Set(aliases.map(row => row.club_name)), new Set([
    'Bota FC',
    'Inferign United',
    'True Egoistas',
    'Versus One',
    'FC Wisconsin',
    'FC Sutton St',
  ]));
  assert.ok(normalizedAliases.includes(normalizeLeagueClubName('Bota')));
  assert.ok(normalizedAliases.includes(normalizeLeagueClubName('Inferign Utd')));
  assert.ok(normalizedAliases.includes(normalizeLeagueClubName('FC Sutton')));
  assert.equal(normalizedAliases.includes(normalizeLeagueClubName('Unreal Madrid3')), false);
  assert.equal(normalizedAliases.includes(normalizeLeagueClubName('CLT EA')), false);
  assert.equal(normalizedAliases.includes(normalizeLeagueClubName('Da Bears FC')), false);
  assert.equal(normalizedAliases.includes(normalizeLeagueClubName('Dont Mata FC')), false);
});
