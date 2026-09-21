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

// Daily's own room object always has an absolute url like
// "https://yourdomain.daily.co/room-name". Anything else — a bare room
// name left over from a stale/bad row, for instance — isn't something
// daily-js can join.
function isFullRoomUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

// Every call is cloud-recorded for safeguarding, and the recording
// starts on its own as soon as someone joins — nobody on the call has
// to (or gets to) press record. /api/daily-webhook turns the resulting
// recording.* events into public.call_recordings rows.
//
// The two halves live on different objects, which is easy to get wrong:
//   - enable_recording: 'cloud' is a ROOM property — it permits cloud
//     recording at all.
//   - start_cloud_recording: true is a MEETING TOKEN property — it is
//     what actually starts the recording when that token's holder
//     joins. Daily starts a cloud recording only via an owner clicking
//     Record, or a token carrying this flag.
//
// Putting start_cloud_recording in the room config (as this once did)
// is rejected by Daily and leaves the room un-patchable.
const RECORDING_ROOM_PROPERTIES = {
  enable_recording: 'cloud'
};

function roomIsRecording(room) {
  const cfg = (room && room.config) || {};
  return cfg.enable_recording === 'cloud';
}

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

    // Calls are recorded, so nobody joins one until *both* people have
    // agreed to that. This is the real gate — the client-side check in
    // member.html only exists to explain the situation nicely, and a
    // caller who skips it still can't get a meeting token from here.
    const [youthRow, seniorRow] = await Promise.all([
      supabaseAdmin.from('youth_profiles').select('recording_consent_at').eq('id', match.youth_id).maybeSingle(),
      supabaseAdmin.from('senior_profiles').select('recording_consent_at').eq('id', match.senior_id).maybeSingle()
    ]);

    const selfConsented = uid === match.youth_id
      ? Boolean(youthRow.data?.recording_consent_at)
      : Boolean(seniorRow.data?.recording_consent_at);
    const partnerConsented = uid === match.youth_id
      ? Boolean(seniorRow.data?.recording_consent_at)
      : Boolean(youthRow.data?.recording_consent_at);

    if (!selfConsented || !partnerConsented) {
      res.status(403).json({
        error: !selfConsented
          ? 'You need to agree to call recording before you can start a call.'
          : 'Your match hasn’t agreed to call recording yet.',
        code: 'recording_consent_required',
        selfConsented,
        partnerConsented
      });
      return;
    }

    let roomUrl = match.daily_room_url;

    if (roomUrl && !isFullRoomUrl(roomUrl)) {
      console.error('daily-room: stored daily_room_url is not a full URL, recreating', { matchId: match.id, storedValue: roomUrl });
      roomUrl = null;
    }

    // A cached daily_room_url only means a room existed once — rooms are
    // created with a 30-day exp (below), and Daily deletes them once that
    // passes. Reusing a URL to an expired/deleted room fails with "The
    // meeting you're trying to join does not exist" for every caller,
    // forever, since nothing ever clears the stale value. Confirming the
    // room still exists before reuse is what makes this self-healing.
    if (roomUrl) {
      const roomName = roomUrl.split('/').pop();
      const checkRes = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` }
      });
      if (!checkRes.ok) {
        if (checkRes.status !== 404) {
          const detail = await checkRes.text();
          console.error('daily-room: room-lookup request failed', checkRes.status, detail);
        }
        console.log('daily-room: cached room no longer exists on Daily, recreating', { matchId: match.id, roomUrl });
        roomUrl = null;
      } else {
        // Rooms created before recording was added are still perfectly
        // joinable, so the check above happily reuses them — and they'd
        // silently never record. Patch them instead, so every match
        // converges on recording without waiting for its 30-day exp.
        const existingRoom = await checkRes.json();

        if (!roomIsRecording(existingRoom)) {
          console.log('daily-room: existing room is not set to record, patching', {
            matchId: match.id,
            roomName,
            config: existingRoom.config
          });

          const patchRes = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ properties: RECORDING_ROOM_PROPERTIES })
          });

          const patchBody = await patchRes.text();

          // Trust the room Daily returns, not the fact it said 200 —
          // a property it declines to apply comes back as a success
          // with the old config, which would otherwise look patched.
          let patched = null;
          if (patchRes.ok) {
            try {
              patched = JSON.parse(patchBody);
            } catch (e) {
              console.error('daily-room: patch response was not JSON', patchBody);
            }
          }

          if (!patchRes.ok || !roomIsRecording(patched)) {
            console.error('daily-room: could not enable recording by patching, will recreate', {
              matchId: match.id,
              roomName,
              status: patchRes.status,
              dailyResponse: patchBody
            });

            // Fall back to a clean room. The name is derived from the
            // match id, so the delete has to land before the create can
            // reuse it — if the delete fails there's no way to get a
            // recording room for this match, and the call must not
            // proceed unrecorded.
            const delRes = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` }
            });

            if (!delRes.ok && delRes.status !== 404) {
              const delBody = await delRes.text();
              console.error('daily-room: could not delete un-patchable room', delRes.status, delBody);
              res.status(502).json({
                error: 'Could not enable call recording for this room, so the call was not started.',
                detail: delBody
              });
              return;
            }

            console.log('daily-room: deleted un-patchable room, recreating', { matchId: match.id, roomName });
            roomUrl = null;
          } else {
            console.log('daily-room: enabled recording on pre-existing room', { matchId: match.id, roomUrl });
          }
        }
      }
    }

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
            exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
            ...RECORDING_ROOM_PROPERTIES
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
      console.log('daily-room: Daily room created', room);

      if (!isFullRoomUrl(room.url)) {
        console.error('daily-room: Daily API did not return a full room url', room);
        res.status(502).json({ error: 'Daily.co did not return a valid room URL', detail: JSON.stringify(room) });
        return;
      }

      // Daily silently drops enable_recording on plans/domains where
      // cloud recording isn't turned on, so the room comes back looking
      // fine and simply never records. Failing loudly here beats
      // discovering months later that there's nothing to review.
      if (!roomIsRecording(room)) {
        console.error('daily-room: room created without cloud recording', room.config);
        res.status(502).json({
          error: 'Call recording is not enabled on this Daily.co domain, so the call was not started.',
          detail: JSON.stringify(room.config || {})
        });
        return;
      }

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
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2,
          // This is what actually starts the recording, the moment
          // either person joins. It requires the room's
          // enable_recording: 'cloud', checked above.
          start_cloud_recording: true
          // Deliberately NOT setting enable_recording: false here. It
          // reads like "stop them turning recording off", but it
          // contradicts the line above — start_cloud_recording needs
          // enable_recording to be 'cloud' on the room or the token —
          // and it stopped recording from ever starting. Participants
          // can't stop a recording anyway: only owners get the Record
          // control, and these tokens don't set is_owner.
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
    // Deliberately not claiming "recording: true" here. All this knows
    // is that the room and token are configured to record; whether a
    // recording actually started is something only Daily's in-call
    // events can say, and the UI waits for those before telling anyone
    // their call is being recorded.
    const responseBody = { url: roomUrl, token: tokenData.token };
    console.log('daily-room: returning room for match', match.id);
    res.status(200).json(responseBody);
  } catch (err) {
    console.error('daily-room: unexpected error', err);
    res.status(500).json({ error: 'Unexpected server error', detail: err.message });
  }
};
