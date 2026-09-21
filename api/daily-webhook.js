// POST /api/daily-webhook
// Receives Daily.co recording events and turns them into
// public.call_recordings rows.
//
// Nothing here trusts the caller until the HMAC checks out — this
// endpoint is public, and a forged request would otherwise be able to
// write rows claiming a recording exists for any match.
//
// SETUP — supply your own hmac, don't let Daily generate one. Daily
// sends a signed validation POST the moment the webhook is created, so
// a Daily-generated secret can't be verified: its only copy arrives in
// the response to the very call that triggered the ping. Generating it
// yourself means DAILY_WEBHOOK_SECRET is already deployed when the ping
// lands, and the ping verifies like any other delivery.
//
//   SECRET=$(openssl rand -base64 32)          # base64: Daily decodes
//                                              # it to the key bytes
//   # set DAILY_WEBHOOK_SECRET=$SECRET in Vercel, redeploy, then:
//   curl -X POST https://api.daily.co/v1/webhooks \
//     -H "Authorization: Bearer $DAILY_API_KEY" \
//     -H "Content-Type: application/json" \
//     -d "{\"url\":\"https://<your-domain>/api/daily-webhook\",
//          \"hmac\":\"$SECRET\",
//          \"eventTypes\":[\"recording.started\",\"recording.ready-to-download\"]}"
//
// If the secret isn't set yet, the handler accepts the unverified
// validation ping (and only that) so the webhook can still be created;
// see the comment on that branch below.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// @vercel/node exposes req.body as a lazy getter: as long as nothing
// touches it first, the request stream is still unread and we can get
// the exact bytes Daily signed. Re-serialising a parsed object would
// not reproduce them (key order, whitespace), so raw is the only way
// the signature can be checked at all.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function signatureIsValid(rawBody, timestamp, signature) {
  const secret = process.env.DAILY_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return false;

  const expected = crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rooms are named cq-match-<match id> in /api/daily-room, which is the
// only link back from a Daily event to a CareQuest match.
function matchIdFromRoomName(roomName) {
  if (typeof roomName !== 'string') return null;
  const id = roomName.replace(/^cq-match-/, '');
  return UUID_RE.test(id) ? id : null;
}

function toTimestamp(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

async function retentionDays() {
  const { data } = await supabaseAdmin
    .from('recording_settings')
    .select('retention_days')
    .maybeSingle();
  return data?.retention_days ?? 30;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];

    // Parsed before the signature is checked, because telling Daily's
    // one-off validation ping apart from a real event delivery needs
    // the body. Nothing here acts on the contents until the signature
    // has been verified below.
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      res.status(400).json({ error: 'Malformed JSON' });
      return;
    }

    const type = event.type;
    const payload = event.payload || {};

    // Daily POSTs {"test":"test"} once, when the webhook is created,
    // and requires a 200 within 8 seconds or the create call fails with
    // "non-200 status code returned from webhook endpoint". It has no
    // `type`, which is what distinguishes it from a real delivery.
    const isValidationPing = !type;

    if (!signatureIsValid(rawBody, timestamp, signature)) {
      // Daily's validation ping *is* signed — but if you let Daily
      // generate the hmac, the only copy of that secret comes back in
      // the create-webhook response, which hasn't happened yet when the
      // ping arrives. There is no way to verify it, so with no secret
      // configured we accept the ping (and nothing else) to let the
      // webhook be created at all.
      //
      // Passing your own base64 `hmac` to POST /v1/webhooks avoids this
      // entirely and is the better setup — see the header comment.
      // Once DAILY_WEBHOOK_SECRET is set, this branch stops accepting
      // anything: an unsigned ping is rejected like everything else.
      if (isValidationPing && !process.env.DAILY_WEBHOOK_SECRET) {
        console.warn(
          'daily-webhook: accepted an UNVERIFIED validation ping because ' +
          'DAILY_WEBHOOK_SECRET is not set. Set it to the hmac from the ' +
          'create-webhook response and redeploy — until you do, real ' +
          'recording events will be rejected and no recordings will be logged.'
        );
        res.status(200).json({ ok: true, unverified: true });
        return;
      }

      console.error('daily-webhook: rejected request with bad or missing signature', {
        validationPing: isValidationPing,
        secretConfigured: Boolean(process.env.DAILY_WEBHOOK_SECRET)
      });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Reject replays of an old, validly-signed request.
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
      console.error('daily-webhook: rejected stale request', { timestamp });
      res.status(401).json({ error: 'Stale request' });
      return;
    }

    // A verified validation ping, plus event types we didn't subscribe
    // to. Anything other than 2xx makes Daily mark the webhook FAILED,
    // so acknowledge them.
    if (type !== 'recording.started' && type !== 'recording.ready-to-download') {
      res.status(200).json({ ok: true, ignored: type || 'validation' });
      return;
    }

    const matchId = matchIdFromRoomName(payload.room_name);
    const dailyRecordingId = payload.recording_id;

    if (!matchId || !dailyRecordingId) {
      console.error('daily-webhook: event is not for a CareQuest match room', {
        type,
        roomName: payload.room_name,
        recordingId: dailyRecordingId
      });
      res.status(200).json({ ok: true, ignored: 'unrecognised room' });
      return;
    }

    const startedAt = toTimestamp(payload.start_ts) || new Date().toISOString();
    const days = await retentionDays();
    const expiresAt = new Date(
      new Date(startedAt).getTime() + days * 24 * 60 * 60 * 1000
    ).toISOString();

    const row = {
      match_id: matchId,
      daily_recording_id: dailyRecordingId,
      started_at: startedAt,
      expires_at: expiresAt
    };

    // recording.started arrives first and knows neither the length nor
    // where the file landed; ready-to-download fills both in. Sending
    // undefined for those on the first event would clobber nothing, but
    // being explicit keeps the upsert from ever writing a null over a
    // value the later event already supplied.
    if (type === 'recording.ready-to-download') {
      const duration = Number(payload.duration);
      if (Number.isFinite(duration) && duration >= 0) row.duration = Math.round(duration);
      row.download_path = payload.s3key || dailyRecordingId;
    }

    const { error } = await supabaseAdmin
      .from('call_recordings')
      .upsert(row, { onConflict: 'daily_recording_id' });

    if (error) {
      // 500 so Daily retries — losing the row would mean a recording
      // exists in Daily that nothing here knows to review or purge.
      console.error('daily-webhook: could not write call_recordings row', error);
      res.status(500).json({ error: 'Could not record event' });
      return;
    }

    console.log('daily-webhook: stored', { type, matchId, dailyRecordingId });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('daily-webhook: unexpected error', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
};

module.exports.config = { api: { bodyParser: false } };
