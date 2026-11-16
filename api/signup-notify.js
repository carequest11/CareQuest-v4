// POST /api/signup-notify
//
// Called by the pg_net triggers on youth_profiles and senior_profiles
// (see the "Sign-up email notifications" section of
// supabase-schema.sql) the moment a new sign-up row is written. Emails
// the staff inbox the new person's details through Resend, with a
// direct link to their row in the Supabase table editor, so staff can
// match & verify quickly.
//
// Separate from /api/send-signup-push on purpose: its own trigger, its
// own secret, so a problem with one channel never stops the other.
//
// Plain text only, so nothing a user typed into their profile can
// render as HTML in the inbox. This email does carry a new youth's
// contact details and age — it goes only to the staff inbox below.
//
// Setup, in order:
//   1. Set SIGNUP_EMAIL_WEBHOOK_SECRET in Vercel env vars (RESEND_API_KEY
//      and SUPABASE_URL are already set for other endpoints) — see
//      .env.example.
//   2. Store the same value in Supabase Vault as
//      "signup_email_webhook_secret" (snippet in the section header).
//   3. Run the "Sign-up email notifications" section of
//      supabase-schema.sql, then deploy.

const STAFF_INBOX = 'care1quest@gmail.com';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Fails closed: with no secret configured, nobody can call this. The
  // 500 (not 401) makes a missing Vercel env var distinguishable from a
  // wrong secret in net._http_response.
  const expectedSecret = process.env.SIGNUP_EMAIL_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('signup-notify: SIGNUP_EMAIL_WEBHOOK_SECRET is not set; refusing request');
    res.status(500).json({ error: 'Webhook secret is not configured' });
    return;
  }
  if (req.headers['x-webhook-secret'] !== expectedSecret) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('signup-notify: RESEND_API_KEY is not set');
    res.status(500).json({ error: 'Email is not configured' });
    return;
  }

  const parsed = readJsonBody(req);
  if (parsed.error) {
    // Logged without the body: it holds a new sign-up's contact details
    // (and, for youth, a minor's), which shouldn't land in Vercel logs.
    console.error('signup-notify: could not parse request body', parsed.error);
    res.status(400).json({ error: 'Could not parse request body', ...parsed.error });
    return;
  }

  try {
    const { table, table_id: tableId, record } = parsed.body;
    if (table !== 'youth_profiles' && table !== 'senior_profiles') {
      res.status(400).json({ error: 'Unexpected table' });
      return;
    }
    if (!record || !record.id) {
      res.status(400).json({ error: 'Missing record' });
      return;
    }

    const isYouth = table === 'youth_profiles';
    const role = isYouth ? 'Youth' : 'Senior';
    const name = isYouth
      ? [record.first_name, record.last_name].filter(Boolean).join(' ')
      : record.full_name;

    const signedUpAt = record.created_at
      ? new Date(record.created_at).toLocaleString('en-CA', { timeZone: 'America/Vancouver' })
      : null;

    const rowLink = supabaseRowLink(tableId, record.id);

    const text = [
      `A new ${role.toLowerCase()} just signed up for CareQuest and is waiting to be matched and verified.`,
      '',
      `Name: ${name || '(not given)'}`,
      `Role: ${role}`,
      `Email: ${record.email || '(not given)'}`,
      `Phone: ${record.phone || '(not given)'}`,
      isYouth ? `Age: ${record.age ?? '(not given)'}` : null,
      `Interests: ${record.interests || '(not given)'}`,
      `Signed up: ${signedUpAt ? `${signedUpAt} (Vancouver time)` : '(unknown)'}`,
      '',
      rowLink ? `Open their row in Supabase: ${rowLink}` : `Supabase row: ${table}, id ${record.id}`
    ].filter((line) => line !== null).join('\n');

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.MESSAGE_EMAIL_FROM || 'CareQuest <notifications@carequest.info>',
        to: [STAFF_INBOX],
        subject: `New ${role} sign-up: ${name || 'unnamed'}`,
        text
      })
    });

    if (!resendRes.ok) {
      const detail = (await resendRes.text()).slice(0, 300);
      console.error('signup-notify: Resend send failed', resendRes.status, detail);
      res.status(502).json({ error: 'Resend send failed', status: resendRes.status, detail });
      return;
    }

    res.status(200).json({ ok: true, email: 'sent' });
  } catch (err) {
    console.error('signup-notify failed', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
};

// Vercel's req.body is a lazy getter: for Content-Type application/json
// it runs JSON.parse on the buffered body the first time it's read and
// throws its own ApiError(400, 'Invalid JSON') on failure, discarding
// the parse error. The raw bytes aren't exposed and the request stream
// is already drained (see daily-webhook.js), so this reports what is
// available: Vercel's status/message plus the request headers that
// describe the body. A text/plain body arrives as a raw string, which
// is parsed here with the real JSON.parse error kept.
function readJsonBody(req) {
  const headers = {
    content_type: req.headers['content-type'] || null,
    content_length: req.headers['content-length'] || null,
    content_encoding: req.headers['content-encoding'] || null,
    user_agent: req.headers['user-agent'] || null
  };

  let body;
  try {
    body = req.body;
  } catch (err) {
    return { error: { status: err.statusCode || null, message: err.message, ...headers } };
  }

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return { error: { status: 400, message: `JSON.parse: ${err.message}`, body_length: body.length, ...headers } };
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: { status: 400, message: `Expected a JSON object, got ${Array.isArray(body) ? 'array' : typeof body}`, ...headers } };
  }

  return { body };
}

// Table-editor link filtered to this one row. The project ref comes
// from SUPABASE_URL (https://<ref>.supabase.co); the table id is the
// table's OID, which the trigger sends as TG_RELID.
function supabaseRowLink(tableId, rowId) {
  let ref;
  try {
    ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  } catch (err) {
    return null;
  }
  if (!ref || !tableId) return null;
  const filter = encodeURIComponent(`id:eq:${rowId}`);
  return `https://supabase.com/dashboard/project/${ref}/editor/${tableId}?schema=public&filter=${filter}`;
}
