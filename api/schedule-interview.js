// POST /api/schedule-interview  { scheduledAt }
// Header: Authorization: Bearer <supabase access token>
//
// Lets a youth volunteer book (or rebook) their interview slot from
// youth-interview.html. Runs with the service-role key because
// youth_profiles.interview_status can only be moved to 'approved' or
// 'rejected' by staff — see the enforce_interview_status_change
// trigger in supabase-schema.sql — but this endpoint is the sanctioned
// way to move it from 'pending' to 'scheduled', after verifying the
// caller via their access token rather than trusting a client-supplied
// user id.
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
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

    const { scheduledAt } = req.body || {};
    if (!scheduledAt || isNaN(Date.parse(scheduledAt))) {
      res.status(400).json({ error: 'Missing or invalid scheduledAt' });
      return;
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('youth_profiles')
      .select('interview_status')
      .eq('id', uid)
      .maybeSingle();

    if (profileErr || !profile) {
      res.status(404).json({ error: 'No youth profile found for this account' });
      return;
    }

    if (profile.interview_status === 'approved' || profile.interview_status === 'rejected') {
      res.status(409).json({ error: 'Your interview has already been reviewed.' });
      return;
    }

    const { error: updateErr } = await supabaseAdmin
      .from('youth_profiles')
      .update({ interview_status: 'scheduled', interview_scheduled_at: scheduledAt })
      .eq('id', uid);

    if (updateErr) {
      res.status(400).json({ error: updateErr.message });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error' });
  }
};
