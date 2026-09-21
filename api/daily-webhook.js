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
//
// Note Daily signs the re-serialised JSON rather than the raw request
// bytes — see the comment on computeSignature. Do not "fix" this back
// to reading the raw stream: on Vercel the body is already parsed, the
// stream is drained, and reading it hangs the function until timeout.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Unlike most providers, Daily does NOT sign the raw request bytes —
// its documented verification is over the *re-serialised* JSON:
//
//   let signature = headers['X-Webhook-Timestamp'] + '.' + JSON.stringify(event);
//   const hmac = crypto.createHmac('sha256', Buffer.from(hmacSecret, 'base64'));
//   let computed_signature = hmac.update(signature).digest('base64');
//
// So the parsed body is exactly what we need, and @vercel/node having
// already parsed it is fine rather than a problem. An earlier version
// of this file read the request stream instead, to get raw bytes: on
// Vercel that stream is already drained, so 'end' never fired, the
// handler hung, and Daily saw a timeout instead of a 200.
function readEvent(req) {
  const body = req.body;
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  if (typeof body === 'string') return JSON.parse(body);
  if (typeof body === 'object') return body;
  return null;
}

function computeSignature(secret, timestamp, event) {
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${timestamp}.${JSON.stringify(event)}`)
    .digest('base64');
}

function signatureIsValid(event, timestamp, signature) {
  const secret = process.env.DAILY_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return false;

  const expected = computeSignature(secret, timestamp, event);

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

// Daily does not document the unit of X-Webhook-Timestamp, and it does
// not match the rest of the API: `event_ts` and `start_ts` are both
// documented as epoch *seconds*, but the header arrives in
// milliseconds (13 digits). Normalising by magnitude is correct
// whichever one Daily sends, rather than betting on an undocumented
// format staying put — 1e11 seconds is the year 5138 and 1e11 ms is
// 1973, so nothing real is ambiguous.
//
// This is only for the replay window. The signature is always computed
// over the header string exactly as received, never a normalised form.
function timestampToMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? n : n * 1000;
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
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];

    let event;
    try {
      event = readEvent(req);
    } catch (e) {
      event = null;
    }

    if (!event || typeof event !== 'object') {
      console.error('daily-webhook: could not read a JSON body', {
        contentType: req.headers['content-type'],
        bodyType: typeof req.body,
        isBuffer: Buffer.isBuffer(req.body)
      });
      res.status(400).json({ error: 'Malformed JSON' });
      return;
    }

    // TEMPORARY DIAGNOSTICS — remove once the webhook is delivering.
    // Logs enough to tell the three failure modes apart (secret not
    // reaching the runtime / header missing / signature mismatch)
    // without putting the secret or a full valid signature in the logs.
    const secretForLog = process.env.DAILY_WEBHOOK_SECRET;
    console.log('daily-webhook: inbound', {
      type: event.type || '(validation ping)',
      secretConfigured: Boolean(secretForLog),
      secretLength: secretForLog ? secretForLog.length : 0,
      hasTimestampHeader: Boolean(timestamp),
      hasSignatureHeader: Boolean(signature),
      receivedSignature: signature ? String(signature).slice(0, 16) + '…' : null,
      computedSignature: secretForLog && timestamp
        ? computeSignature(secretForLog, timestamp, event).slice(0, 16) + '…'
        : null,
      signedStringLength: timestamp ? `${timestamp}.${JSON.stringify(event)}`.length : 0
    });

    const type = event.type;
    const payload = event.payload || {};

    // Daily POSTs {"test":"test"} once, when the webhook is created,
    // and requires a 200 within 8 seconds or the create call fails with
    // "non-200 status code returned from webhook endpoint". It has no
    // `type`, which is what distinguishes it from a real delivery.
    const isValidationPing = !type;

    if (!signatureIsValid(event, timestamp, signature)) {
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
    const sentAtMs = timestampToMs(timestamp);
    if (sentAtMs === null || Math.abs(Date.now() - sentAtMs) > 5 * 60 * 1000) {
      console.error('daily-webhook: rejected stale request', {
        timestamp,
        ageSeconds: sentAtMs === null ? null : Math.round((Date.now() - sentAtMs) / 1000)
      });
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
      // recording.started's documented payload carries no room_name
      // (only action/recording_id/layout/started_by/instance_id/
      // start_ts), so there's nothing to map it to a match with. That's
      // expected, not a fault: recording.ready-to-download does carry
      // room_name and writes the row a few seconds later. A *present*
      // room_name we don't recognise is a different matter — that's
      // someone else's room on the same Daily domain.
      if (!payload.room_name) {
        console.log('daily-webhook: no room_name on this event, waiting for ready-to-download', {
          type,
          recordingId: dailyRecordingId
        });
      } else {
        console.warn('daily-webhook: event is not for a CareQuest match room', {
          type,
          roomName: payload.room_name,
          recordingId: dailyRecordingId
        });
      }
      res.status(200).json({ ok: true, ignored: 'unmapped room' });
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
      // Daily's field is s3_key, not s3key — an earlier spelling here
      // meant download_path silently fell back to the recording id for
      // every recording, losing where the file actually landed.
      row.download_path = payload.s3_key || dailyRecordingId;
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
