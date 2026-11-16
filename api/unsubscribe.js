// GET/POST /api/unsubscribe?u=<user id>&t=<signature>
//
// The unsubscribe link in every message notification email (see
// /api/send-message-email). Works without logging in — the signature
// from lib/unsubscribeToken.js is what proves the link is genuine.
//
// GET only shows a confirm button and changes nothing, because mail
// scanners and link previews fetch links nobody clicked. The button,
// and mail clients' own one-click unsubscribe (RFC 8058), POST here,
// and that's what turns message_email_notifications off. People can
// turn it back on from the Messages card in member.html.
const { createClient } = require('@supabase/supabase-js');
const { SITE_URL, verify } = require('../lib/unsubscribeToken');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  const { u: userId, t: token } = req.query || {};

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  if (!verify(userId, token)) {
    sendPage(res, 400, 'This link isn’t valid',
      `<p>This unsubscribe link is incomplete or has been changed. You can turn message emails off from the Messages section after <a href="${SITE_URL}/login">logging in</a>.</p>`);
    return;
  }

  if (req.method === 'GET') {
    // userId and token were both checked against strict hex/uuid
    // patterns in verify(), so they're safe to put back into the page.
    sendPage(res, 200, 'Stop message emails?',
      `<p>You won’t get an email when your CareQuest match sends you a message. You’ll still see your messages when you log in.</p>
       <form method="post" action="/api/unsubscribe?u=${userId}&amp;t=${token}">
         <button type="submit">Stop Message Emails</button>
       </form>`);
    return;
  }

  // Exactly one of these has a row for this id; the other updates
  // nothing.
  const [youth, senior] = await Promise.all([
    supabaseAdmin.from('youth_profiles').update({ message_email_notifications: false }).eq('id', userId),
    supabaseAdmin.from('senior_profiles').update({ message_email_notifications: false }).eq('id', userId)
  ]);

  if (youth.error || senior.error) {
    console.error('unsubscribe failed', youth.error || senior.error);
    sendPage(res, 500, 'Something went wrong',
      '<p>We couldn’t update your settings just now. Please try the link again in a few minutes.</p>');
    return;
  }

  sendPage(res, 200, 'You’re unsubscribed',
    `<p>We won’t email you about new messages any more.</p>
     <p>Changed your mind? You can turn these emails back on from the Messages section after <a href="${SITE_URL}/login">logging in</a>.</p>`);
};

function sendPage(res, status, heading, bodyHtml) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} — CareQuest</title>
<link rel="stylesheet" href="/css/fonts.css">
<style>
  body{margin:0; background:#FBF5E9; color:#232B36; font-family:var(--font-sans); font-size:20px; line-height:1.6;}
  main{max-width:560px; margin:0 auto; padding:64px 20px;}
  h1{font-size:32px; line-height:1.25; margin:0 0 20px;}
  a{color:#204A44; font-weight:500;}
  button{margin-top:12px; min-height:56px; padding:14px 28px; font:inherit; font-weight:500; color:#fff; background:#2F6B62; border:0; border-radius:14px; cursor:pointer;}
  button:hover, button:focus-visible{background:#204A44;}
  button:focus-visible{outline:3px solid #C99A44; outline-offset:3px;}
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
${bodyHtml}
</main>
</body>
</html>`);
}
