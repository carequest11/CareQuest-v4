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
//   6. Staff email through Resend (the main email alert): needs only
//      RESEND_API_KEY (shared with send-message-email.js). Goes to
//      care1quest@gmail.com with the person's details and a direct link
//      to their row in the Supabase table editor (the trigger sends the
//      table's OID as table_id). Skipped, not an error, while
//      RESEND_API_KEY is unset.
//
// Also emails staff when a youth books an interview slot: a second
// trigger on youth_profiles (the "Interview booking email" section of
// supabase-schema.sql) calls this same endpoint with type
// 'INTERVIEW_BOOKED' when interview_slot_at changes. That request gets
// only the interview email — no push, no sign-up email.
//
// This used to be a separate /api/send-signup-email (later
// /api/signup-notify) route with its own trigger; Vercel failed every
// request to it with "Invalid JSON" while this route parsed the
// identical pg_net request, so the email was folded in here instead.
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

  // Fails closed: with no secret configured, nobody can call this (it
  // used to fail open for the dashboard webhook's unsigned setup ping,
  // but that webhook was replaced by the pg_net triggers). The 500
  // (not 401) makes a missing Vercel env var distinguishable from a
  // wrong secret in net._http_response.
  const expectedSecret = process.env.SIGNUP_PUSH_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('send-signup-push: SIGNUP_PUSH_WEBHOOK_SECRET is not set; refusing request');
    res.status(500).json({ error: 'Webhook secret is not configured' });
    return;
  }
  if (req.headers['x-webhook-secret'] !== expectedSecret) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  try {
    const { type, table, table_id: tableId, record } = req.body || {};
    if (table !== 'youth_profiles' && table !== 'senior_profiles') {
      res.status(400).json({ error: 'Unexpected table' });
      return;
    }

    if (type === 'INTERVIEW_BOOKED') {
      if (table !== 'youth_profiles') {
        res.status(400).json({ error: 'Interview bookings are youth only' });
        return;
      }
      const interviewEmail = await sendInterviewEmail(tableId, record);
      res.status(200).json({ ok: true, interview_email: interviewEmail });
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

    // Every channel runs side by side and reports separately, so a
    // problem with one never stops the others from going out.
    const [push, email, resendEmail] = await Promise.all([
      sendPushes(payload),
      sendEmail(role, name, record),
      sendResendEmail(table, tableId, role, name, record)
    ]);

    res.status(200).json({ ok: true, ...push, email, resend_email: resendEmail });
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

// Emails the staff inbox through Resend — the main sign-up email (the
// Gmail sendEmail above is older and dormant unless its env vars are
// set). Plain text only, so nothing a user typed into their profile
// can render as HTML in the inbox. Carries a new youth's contact
// details and age, so it goes only to the staff inbox below. Returns
// its outcome rather than throwing, like the other channels.
const STAFF_INBOX = 'care1quest@gmail.com';

async function sendResendEmail(table, tableId, role, name, record) {
  if (!process.env.RESEND_API_KEY) return 'skipped';

  const isYouth = table === 'youth_profiles';
  const signedUpAt = record?.created_at
    ? new Date(record.created_at).toLocaleString('en-CA', { timeZone: 'America/Vancouver' })
    : null;
  const rowLink = supabaseRowLink(tableId, record?.id);

  const text = [
    `A new ${role.toLowerCase()} just signed up for CareQuest and is waiting to be matched and verified.`,
    '',
    `Name: ${name || '(not given)'}`,
    `Role: ${role}`,
    `Email: ${record?.email || '(not given)'}`,
    `Phone: ${record?.phone || '(not given)'}`,
    isYouth ? `Age: ${record?.age ?? '(not given)'}` : null,
    `Interests: ${record?.interests || '(not given)'}`,
    `Signed up: ${signedUpAt ? `${signedUpAt} (Vancouver time)` : '(unknown)'}`,
    '',
    rowLink ? `Open their row in Supabase: ${rowLink}` : `Supabase row: ${table}, id ${record?.id || '(unknown)'}`
  ].filter((line) => line !== null).join('\n');

  return resendToStaff(`New ${role} sign-up: ${name || 'unnamed'}`, text, 'sign-up');
}

// Emails the staff inbox when a youth picks an interview slot on
// youth-interview.html: their name and the time they picked (stored in
// UTC as interview_slot_at, shown here in Vancouver time).
async function sendInterviewEmail(tableId, record) {
  if (!process.env.RESEND_API_KEY) return 'skipped';

  const name = [record?.first_name, record?.last_name].filter(Boolean).join(' ');
  const slot = record?.interview_slot_at
    ? new Date(record.interview_slot_at).toLocaleString('en-CA', {
        timeZone: 'America/Vancouver',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      })
    : null;
  const rowLink = supabaseRowLink(tableId, record?.id);

  const text = [
    `${name || 'A youth volunteer'} just picked an interview slot.`,
    '',
    `Name: ${name || '(not given)'}`,
    `Interview time: ${slot ? `${slot} (Vancouver time)` : '(unknown)'}`,
    '',
    'They were told the CareQuest team will follow up directly to confirm.',
    '',
    rowLink ? `Open their row in Supabase: ${rowLink}` : `Supabase row: youth_profiles, id ${record?.id || '(unknown)'}`
  ].join('\n');

  return resendToStaff(`Interview booked: ${name || 'unnamed'}${slot ? ` — ${slot}` : ''}`, text, 'interview');
}

// One plain-text Resend email to the staff inbox. Returns its outcome
// rather than throwing, so it can sit alongside the other channels.
async function resendToStaff(subject, text, label) {
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.MESSAGE_EMAIL_FROM || 'CareQuest <notifications@carequest.info>',
        to: [STAFF_INBOX],
        subject,
        text
      })
    });
    if (!resendRes.ok) {
      const detail = (await resendRes.text()).slice(0, 300);
      console.error(`${label} Resend email failed`, resendRes.status, detail);
      return `failed: ${resendRes.status} ${detail}`;
    }
    return 'sent';
  } catch (err) {
    console.error(`${label} Resend email failed`, err);
    return `failed: ${String(err.message || err).slice(0, 300)}`;
  }
}

// Table-editor link filtered to this one row. The project ref comes
// from SUPABASE_URL (https://<ref>.supabase.co); the table id is the
// table's OID, which the trigger sends as table_id (TG_RELID).
function supabaseRowLink(tableId, rowId) {
  let ref;
  try {
    ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  } catch (err) {
    return null;
  }
  if (!ref || !tableId || !rowId) return null;
  const filter = encodeURIComponent(`id:eq:${rowId}`);
  return `https://supabase.com/dashboard/project/${ref}/editor/${tableId}?schema=public&filter=${filter}`;
}
