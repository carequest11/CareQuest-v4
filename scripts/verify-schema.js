// One-off check: confirm youth_profiles, senior_profiles, and matches
// exist in the connected Supabase project. Run with:
//   node scripts/verify-schema.js
//
// Uses the public URL + publishable key (same as the browser) — RLS
// means an anonymous request to an existing table returns an empty
// result (0 rows), not an error. A missing table returns a schema-cache
// error instead, which is how this script tells the two cases apart.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://flvwmvnfdwndettogakv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jXv2tmgIkk5T5_xxTKYwxg_lWWEgmvP';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const TABLES = ['youth_profiles', 'senior_profiles', 'matches'];

async function checkTable(table) {
  const { error, count } = await supabase
    .from(table)
    .select('*', { head: true, count: 'exact' });

  if (error) {
    return { table, ok: false, detail: `${error.code || ''} ${error.message}`.trim() };
  }
  return { table, ok: true, detail: `reachable (${count ?? 0} row(s) visible under RLS as anon)` };
}

(async () => {
  const results = await Promise.all(TABLES.map(checkTable));

  console.log('Supabase schema check —', SUPABASE_URL);
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.table}: ${r.detail}`);
  }

  const allOk = results.every(r => r.ok);
  console.log('');
  console.log(allOk ? 'All expected tables exist.' : 'One or more tables are missing or unreachable.');
  process.exit(allOk ? 0 : 1);
})();
