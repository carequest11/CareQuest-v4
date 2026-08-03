// POST /api/cal-webhook?secret=CAL_WEBHOOK_SECRET
//
// Configure this exact URL (with the secret query param) as the webhook
// URL in Cal.com (Settings -> Developer -> Webhooks), subscribed to
// BOOKING_CREATED, BOOKING_RESCHEDULED, and BOOKING_CANCELLED.
//
// The Cal.com embed on the dashboards passes { metadata: { matchId } }
// when creating a booking, so this handler knows which match row to
// update. Uses the service-role key — never exposed to the browser.
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  if (!process.env.CAL_WEBHOOK_SECRET || req.query.secret !== process.env.CAL_WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  const { triggerEvent, payload } = req.body || {};
  const matchId = payload?.metadata?.matchId;

  if (!matchId) {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  if (triggerEvent === 'BOOKING_CREATED' || triggerEvent === 'BOOKING_RESCHEDULED') {
    await supabaseAdmin
      .from('matches')
      .update({ cal_booking_uid: payload.uid, scheduled_at: payload.startTime })
      .eq('id', matchId);
  } else if (triggerEvent === 'BOOKING_CANCELLED') {
    await supabaseAdmin
      .from('matches')
      .update({ cal_booking_uid: null, scheduled_at: null })
      .eq('id', matchId);
  }

  res.status(200).json({ ok: true });
};
