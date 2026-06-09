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
