// POST /api/daily-room  { matchId }
// Header: Authorization: Bearer <supabase access token>
//
// Verifies the caller is actually one of the two people in the match,
// then creates (or reuses) a private Daily.co room for that match and
// mints a short-lived meeting token. The DAILY_API_KEY never reaches
// the browser.
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

    const { matchId } = req.body || {};
    if (!matchId) {
      res.status(400).json({ error: 'Missing matchId' });
      return;
    }

    const { data: match, error: matchErr } = await supabaseAdmin
      .from('matches')
      .select('id, youth_id, senior_id, daily_room_url')
      .eq('id', matchId)
      .maybeSingle();

    if (matchErr || !match || (match.youth_id !== uid && match.senior_id !== uid)) {
      res.status(403).json({ error: 'Not part of this match' });
      return;
    }

    let roomUrl = match.daily_room_url;

    if (!roomUrl) {
      const roomRes = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: `cq-match-${match.id}`,
          privacy: 'private',
          properties: {
            enable_chat: true,
            exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
          }
        })
      });

      if (!roomRes.ok) {
        const detail = await roomRes.text();
        console.error('daily-room: rooms request failed', roomRes.status, detail);
        res.status(502).json({ error: 'Could not create video room', detail });
        return;
      }

      const room = await roomRes.json();
      roomUrl = room.url;

      await supabaseAdmin.from('matches').update({ daily_room_url: roomUrl }).eq('id', match.id);
    }

    const tokenRes = await fetch('https://api.daily.co/v1/meeting-tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          room_name: roomUrl.split('/').pop(),
          user_id: uid,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2
        }
      })
    });

    if (!tokenRes.ok) {
      // The room is private, so a client can't actually join without a
      // token — returning success here without one just moves this same
      // failure into daily-js on the client with a much worse error.
      const detail = await tokenRes.text();
      console.error('daily-room: meeting-tokens request failed', tokenRes.status, detail);
      res.status(502).json({ error: 'Could not create a video call token', detail });
      return;
    }

    const tokenData = await tokenRes.json();
    const responseBody = { url: roomUrl, token: tokenData.token };
    console.log('daily-room: returning', responseBody);
    res.status(200).json(responseBody);
  } catch (err) {
    console.error('daily-room: unexpected error', err);
    res.status(500).json({ error: 'Unexpected server error', detail: err.message });
  }
};
