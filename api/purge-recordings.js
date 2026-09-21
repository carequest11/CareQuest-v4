// GET|POST /api/purge-recordings
// Header: Authorization: Bearer <CRON_SECRET>
//
// Deletes every recording whose expires_at has passed — from Daily
// first, then from public.call_recordings. Runs on the Vercel cron
// schedule in vercel.json, and can be triggered by hand:
//
//   curl -X POST https://<your-domain>/api/purge-recordings \
//     -H "Authorization: Bearer $CRON_SECRET"
//
// The retention period itself lives in public.recording_settings and is
// applied when a recording is first written, so changing it only
// affects recordings made after the change. To re-apply a new period to
// existing recordings, run this in the Supabase SQL editor:
//
//   update public.call_recordings
//      set expires_at = started_at
//          + ((select retention_days from public.recording_settings) || ' days')::interval;
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 100;

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!secret || provided !== secret) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }

  try {
    const { data: due, error: selectErr } = await supabaseAdmin
      .from('call_recordings')
      .select('id, daily_recording_id, match_id, expires_at')
      .lt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (selectErr) {
      console.error('purge-recordings: could not list expired recordings', selectErr);
      res.status(500).json({ error: 'Could not list expired recordings' });
      return;
    }

    let deleted = 0;
    const failed = [];

    for (const rec of due || []) {
      const delRes = await fetch(`https://api.daily.co/v1/recordings/${rec.daily_recording_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` }
      });

      // 404 means Daily no longer has it — already gone is the outcome
      // we wanted, so the row should go too. Any other failure leaves
      // the row in place so the next run retries rather than losing
      // track of a file that still exists.
      if (!delRes.ok && delRes.status !== 404) {
        const detail = await delRes.text();
        console.error('purge-recordings: Daily delete failed', rec.daily_recording_id, delRes.status, detail);
        failed.push(rec.daily_recording_id);
        continue;
      }

      const { error: rowErr } = await supabaseAdmin
        .from('call_recordings')
        .delete()
        .eq('id', rec.id);

      if (rowErr) {
        console.error('purge-recordings: row delete failed', rec.id, rowErr);
        failed.push(rec.daily_recording_id);
        continue;
      }

      deleted += 1;
    }

    console.log('purge-recordings: done', { considered: (due || []).length, deleted, failed: failed.length });
    res.status(200).json({ ok: true, considered: (due || []).length, deleted, failed });
  } catch (err) {
    console.error('purge-recordings: unexpected error', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
};
