const { test, mock } = require('node:test');
const assert = require('assert');

process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

const { pool } = require('../db');
const { saveEaMatch } = require('../server');

test('saveEaMatch upserts player stats cumulatively', async () => {
  const calls = [];
  const queryStub = mock.method(pool, 'query', async (sql, params) => {
    calls.push([sql, params]);
    return { rows: [] };
  });

  const match = {
    matchId: 'm1',
    timestamp: 1000,
    clubs: {
      '10': { details: { name: 'Alpha', isHome: 1 }, goals: 3 },
      '20': { details: { name: 'Beta', isHome: 0 }, goals: 1 }
    },
    players: {
      '10': {
        p1: {
          name: 'Alice',
          position: 'ST',
          goals: 2,
          assists: 1,
          vproattr: '1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27'
        }
      }
    }
  };

  await saveEaMatch(match);

  queryStub.mock.restore();

  const playerCall = calls.find(([sql]) => /INSERT INTO public\.players/i.test(sql));
  assert(playerCall, 'player upsert executed');
  assert(/players.goals \+ EXCLUDED.goals/i.test(playerCall[0]));
  assert(/players.assists \+ EXCLUDED.assists/i.test(playerCall[0]));
  assert(/players.matches \+ 1/i.test(playerCall[0]));
  assert(/COALESCE\(EXCLUDED.vproattr, players.vproattr\)/i.test(playerCall[0]));
});
