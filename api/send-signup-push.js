// POST /api/send-signup-push
//
// Called by the pg_net triggers on youth_profiles and senior_profiles
// (see the "Sign-up push triggers" section of supabase-schema.sql) the
// moment a new sign-up row is written. Sends a Web Push notification
// to every staff device that has subscribed, and an email with the new
// person's details to the staff inbox, so staff can match & verify new
// sign-ups quickly.
//
// Setup, in order:
//   1. Run the "Staff push notifications for new sign-ups" section of
//      supabase-schema.sql.
//   2. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT and
//      SIGNUP_PUSH_WEBHOOK_SECRET in Vercel env vars, then deploy —
//      see .env.example for how to generate these.
//   3. Run the "Sign-up push triggers" section of supabase-schema.sql
//      (pg_net triggers on youth_profiles/senior_profiles), after
//      storing SIGNUP_PUSH_WEBHOOK_SECRET's value in Supabase Vault as
//      described in that section's header. The dashboard's Database
//      Webhooks form fails on this project, so it isn't used.
//   4. In member.html, a signed-in staff account (is_staff() = true)
//      can click "Enable sign-up alerts" to subscribe that browser.
//   5. Optional email alerts: set SIGNUP_EMAIL_USER (a Gmail address),
//      SIGNUP_EMAIL_APP_PASSWORD (a Google app password for it) and,
//      if it should go somewhere else, SIGNUP_EMAIL_TO — see
//      .env.example.
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const nodemailer = require('nodemailer');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Supabase's own validation ping when the webhook is first created
  // isn't signed with a header we control, so (like daily-webhook.js)
  // we only enforce the secret once one has actually been configured.
  const expectedSecret = process.env.SIGNUP_PUSH_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-webhook-secret'] !== expectedSecret) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  try {
    const { table, record } = req.body || {};
    if (table !== 'youth_profiles' && table !== 'senior_profiles') {
      res.status(400).json({ error: 'Unexpected table' });
      return;
    }

    const role = table === 'youth_profiles' ? 'Youth' : 'Senior';
    const name = table === 'youth_profiles'
      ? [record?.first_name, record?.last_name].filter(Boolean).join(' ')
      : record?.full_name;

    const payload = JSON.stringify({
      title: `New ${role} sign-up`,
      body: name || 'A new sign-up is waiting to be matched and verified.',
      url: '/member'
    });

    // Push and email run side by side and report separately, so a
    // problem with one channel never stops the other from going out.
    const [push, email] = await Promise.all([
      sendPushes(payload),
      sendEmail(role, name, record)
    ]);

    res.status(200).json({ ok: true, ...push, email });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error' });
  }
};

async function sendPushes(payload) {
  const { data: subscriptions, error: subsErr } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth_key');

  if (subsErr) {
    return { sent: 0, failed: [{ error: subsErr.message }] };
  }

  // Per-subscription outcome, returned in the response so a failed
  // delivery is visible from Supabase (net._http_response.content)
  // rather than only in Vercel's function logs.
  const results = await Promise.all((subscriptions || []).map(async (sub) => {
    try {
      const sent = await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_key }
        },
        payload
      );
      return { id: sub.id, status: sent.statusCode };
    } catch (err) {
      // 404/410 means the browser unsubscribed or the subscription
      // expired — delete it so future sign-ups don't keep retrying
      // a dead endpoint. Any other error (e.g. a transient network
      // blip) is logged and otherwise ignored: one staff device
      // failing to get a push must never fail this request.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('web-push send failed for subscription', sub.id, err);
      }
      return {
        id: sub.id,
        status: err.statusCode || null,
        error: String(err.body || err.message || err).slice(0, 300)
      };
    }
  }));

  return {
    sent: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error)
  };
}

// Emails the staff inbox through Gmail SMTP with an app password —
// skipped (not an error) until SIGNUP_EMAIL_USER and
// SIGNUP_EMAIL_APP_PASSWORD are set. Plain text only, so nothing a
// user typed into their profile can render as HTML in the inbox.
async function sendEmail(role, name, record) {
  const user = process.env.SIGNUP_EMAIL_USER;
  const pass = process.env.SIGNUP_EMAIL_APP_PASSWORD;
  if (!user || !pass) return 'skipped';

  const signedUpAt = record?.created_at
    ? new Date(record.created_at).toLocaleString('en-CA', { timeZone: 'America/Vancouver' })
    : null;

  const lines = [
    `A new ${role.toLowerCase()} just signed up for CareQuest and is waiting to be matched and verified.`,
    '',
    `Name: ${name || '(not given)'}`,
    `Email: ${record?.email || '(not given)'}`,
    `Phone: ${record?.phone || '(not given)'}`,
    role === 'Youth' && record?.age ? `Age: ${record.age}` : null,
    record?.interests ? `Interests: ${record.interests}` : null,
    record?.languages ? `Languages: ${record.languages}` : null,
    role === 'Senior' && record?.past_career ? `Past career: ${record.past_career}` : null,
    signedUpAt ? `Signed up: ${signedUpAt} (Vancouver time)` : null,
    '',
    'Open CareQuest: https://carequest.info/member'
  ].filter((line) => line !== null);

  try {
    await nodemailer.createTransport({ service: 'gmail', auth: { user, pass } }).sendMail({
      from: `CareQuest <${user}>`,
      to: process.env.SIGNUP_EMAIL_TO || user,
      subject: `New ${role} sign-up: ${name || 'unnamed'}`,
      text: lines.join('\n')
    });
    return 'sent';
  } catch (err) {
    console.error('sign-up email failed', err);
    return `failed: ${String(err.message || err).slice(0, 300)}`;
  }
}
