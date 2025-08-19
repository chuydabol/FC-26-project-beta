const admin = require('firebase-admin');
const pool = require('../db');

async function main(){
  const cupId = process.argv[2];
  if (!cupId){
    console.error('Usage: node scripts/exportCupFixtures.js <cupId>');
    process.exit(1);
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT){
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required');
  }
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (svc.private_key && svc.private_key.includes('\\n')){
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }
  if (!admin.apps.length){
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  const db = admin.firestore();

  const snap = await db.collection('fixtures').where('cup','==',cupId).get();
  console.log(`Found ${snap.size} fixtures for cup ${cupId}`);
  for (const doc of snap.docs){
    const f = { id:doc.id, ...doc.data() };
    await pool.query(
      `INSERT INTO fixtures (id, home, away, score, status, league_id, played_at, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [f.id, f.home, f.away, f.score || null, f.status || null, f.cup || f.league_id || null, f.played_at || null, f]
    );
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
