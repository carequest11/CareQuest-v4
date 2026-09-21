// Shared call-recording configuration: the Daily room properties and
// the meeting-token properties /api/daily-room uses.
//
// This lives outside api/ so scripts/verify-recording-token.js can
// import the exact same values without pulling in daily-room.js's
// Supabase client (which needs credentials just to be constructed).
// Contains no secrets — only shape and policy.

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

// The meeting token each participant joins with. Recording must start
// by itself and then be entirely out of both participants' hands:
// safeguarding is worth nothing if the person a concern is about can
// switch the recording off mid-call.
//
// Three separate things are needed for that, and only the first is
// about the UI:
//   - enable_recording_ui: false removes the Record button from Daily
//     Prebuilt. On its own this is cosmetic — the underlying
//     startRecording()/stopRecording() calls would still be permitted
//     to anyone who opened a console.
//   - permissions.canAdmin: [] is the actual denial. Recording and
//     streaming control live under the 'streaming' admin permission,
//     so an empty list grants neither. hasPresence and canSend are set
//     explicitly alongside it so that supplying a permissions object
//     can't accidentally narrow the participant's ability to send
//     audio and video.
//   - is_owner is left unset (defaults false). Owners get recording
//     control regardless of the above.
//
// enable_recording is deliberately absent: the token's accepted values
// are 'cloud' | 'cloud-audio-only' | 'local' | 'raw-tracks', with no
// false, and the room already carries enable_recording: 'cloud' —
// which start_cloud_recording requires.
function buildMeetingTokenProperties({ roomName, userId, ttlSeconds = 60 * 60 * 2 }) {
  return {
    room_name: roomName,
    user_id: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    // Starts the recording the moment either person joins.
    start_cloud_recording: true,
    // Hides the Record button in Prebuilt.
    enable_recording_ui: false,
    // Denies the permission behind that button.
    permissions: {
      hasPresence: true,
      canSend: true,
      canAdmin: []
    }
  };
}

module.exports = {
  RECORDING_ROOM_PROPERTIES,
  roomIsRecording,
  buildMeetingTokenProperties
};
