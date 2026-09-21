// POST /api/recording-access  { recordingId }
// Header: Authorization: Bearer <supabase access token>
//
// The only way anyone ever plays back a call recording. Staff accounts
// only — the two people who were on the call have no route to their own
// recording, here or through RLS. Every successful authorisation writes
// a public.recording_access_log row first, so "who viewed which
// recording, when" is answerable even after the recording is purged.
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LINK_VALID_SECONDS = 60 * 15;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) {
      res.status(401).json({ error: 'Missing access token' });
      return;
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }
    const uid = userData.user.id;

    const { data: staffRow } = await supabaseAdmin
      .from('staff_users')
      .select('user_id')
      .eq('user_id', uid)
      .maybeSingle();

    if (!staffRow) {
      console.warn('recording-access: non-staff account attempted playback', { uid });
      res.status(403).json({ error: 'Not authorised to view recordings' });
      return;
    }

    const { recordingId } = req.body || {};
    if (!recordingId) {
      res.status(400).json({ error: 'Missing recordingId' });
      return;
    }

    const { data: recording } = await supabaseAdmin
      .from('call_recordings')
      .select('id, match_id, daily_recording_id')
      .eq('id', recordingId)
      .maybeSingle();

    if (!recording) {
      res.status(404).json({ error: 'Recording not found' });
      return;
    }

    // Logged before the link is minted, not after: an access that fails
    // downstream at Daily is still an access attempt that was
    // authorised, and a log you can skip by making the next call fail
    // isn't an audit trail.
    const { error: logErr } = await supabaseAdmin.from('recording_access_log').insert({
      recording_id: recording.id,
      daily_recording_id: recording.daily_recording_id,
      match_id: recording.match_id,
      staff_user_id: uid
    });

    if (logErr) {
      console.error('recording-access: could not write audit log, refusing access', logErr);
      res.status(500).json({ error: 'Could not record this access, so the recording was not opened.' });
      return;
    }

    const linkRes = await fetch(
      `https://api.daily.co/v1/recordings/${recording.daily_recording_id}/access-link?valid_for_secs=${LINK_VALID_SECONDS}`,
      { headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` } }
    );

    if (!linkRes.ok) {
      const detail = await linkRes.text();
      console.error('recording-access: access-link request failed', linkRes.status, detail);
      res.status(502).json({ error: 'Could not open this recording', detail });
      return;
    }

    const link = await linkRes.json();
    res.status(200).json({ url: link.download_link, expires: link.expires });
  } catch (err) {
    console.error('recording-access: unexpected error', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
};
