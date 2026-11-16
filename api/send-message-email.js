// POST /api/send-message-email
//
// Called by the pg_net trigger on public.messages (see the "Message
// email notifications" section of supabase-schema.sql) when someone
// should be told they have a new message. The trigger has already
// decided that — match active, preference on, recipient not on the
// site, not emailed in the last 30 minutes — so this only looks up
// where to send it and sends it through Resend.
//
// The email deliberately says nothing about what the message says:
// email isn't a secure channel and these are conversations between a
// minor and a senior. The trigger doesn't even send the text here.
//
// Setup, in order:
//   1. Set RESEND_API_KEY, MESSAGE_EMAIL_WEBHOOK_SECRET and
//      UNSUBSCRIBE_SECRET (and MESSAGE_EMAIL_FROM if the default
//      sender isn't right) in Vercel env vars — see .env.example.
//   2. Store MESSAGE_EMAIL_WEBHOOK_SECRET's value in Supabase Vault as
//      "message_email_webhook_secret" (snippet in the section header).
//   3. Run the "Message email notifications" section of
//      supabase-schema.sql, then deploy.
const { createClient } = require('@supabase/supabase-js');
const { SITE_URL, unsubscribeUrl } = require('../lib/unsubscribeToken');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Unlike send-signup-push there's no unsigned validation ping to let
  // through, so this fails closed when the secret isn't configured.
  const expectedSecret = process.env.MESSAGE_EMAIL_WEBHOOK_SECRET;
  if (!expectedSecret || req.headers['x-webhook-secret'] !== expectedSecret) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  if (!process.env.RESEND_API_KEY || !process.env.UNSUBSCRIBE_SECRET) {
    res.status(500).json({ error: 'Email is not configured' });
    return;
  }

  try {
    const { recipient_id: recipientId } = req.body || {};
    if (!recipientId) {
      res.status(400).json({ error: 'Missing recipient_id' });
      return;
    }

    const [{ data: youth }, { data: senior }] = await Promise.all([
      supabaseAdmin.from('youth_profiles')
        .select('first_name, message_email_notifications').eq('id', recipientId).maybeSingle(),
      supabaseAdmin.from('senior_profiles')
        .select('full_name, message_email_notifications').eq('id', recipientId).maybeSingle()
    ]);
    const profile = youth || senior;
    if (!profile) {
      res.status(404).json({ error: 'No profile for recipient' });
      return;
    }
    // Re-checked here in case it was turned off since the trigger ran.
    if (!profile.message_email_notifications) {
      res.status(200).json({ ok: true, email: 'skipped: opted out' });
      return;
    }

    // Send to the account's sign-in address, and only once it's been
    // confirmed, rather than to whatever was typed into the profile.
    const { data: { user } = {}, error: userErr } = await supabaseAdmin.auth.admin.getUserById(recipientId);
    if (userErr || !user?.email) {
      res.status(404).json({ error: 'No email for recipient' });
      return;
    }
    if (!user.email_confirmed_at) {
      res.status(200).json({ ok: true, email: 'skipped: email not confirmed' });
      return;
    }

    const firstName = youth ? youth.first_name : (senior.full_name || '').split(' ')[0];
    const unsubscribe = unsubscribeUrl(recipientId);

    const text = [
      firstName ? `Hi ${firstName},` : 'Hi,',
      '',
      'You have a new message from your CareQuest match.',
      '',
      `Read it here: ${SITE_URL}/messages`,
      '',
      "We won't email you about new messages more than once every 30 minutes, or while you're on the CareQuest site.",
      '',
      `To stop these emails: ${unsubscribe}`
    ].join('\n');

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.MESSAGE_EMAIL_FROM || 'CareQuest <notifications@carequest.info>',
        to: [user.email],
        subject: 'You have a new message on CareQuest',
        text,
        // One-click unsubscribe from the mail client's own button
        // (RFC 8058) — /api/unsubscribe handles the POST it sends.
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
    });

    if (!resendRes.ok) {
      const detail = (await resendRes.text()).slice(0, 300);
      console.error('Resend send failed', resendRes.status, detail);
      res.status(502).json({ error: 'Resend send failed', status: resendRes.status, detail });
      return;
    }

    res.status(200).json({ ok: true, email: 'sent' });
  } catch (err) {
    console.error('send-message-email failed', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
};
