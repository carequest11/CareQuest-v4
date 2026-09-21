#!/usr/bin/env node
// Verifies that the meeting tokens /api/daily-room hands out cannot be
// used to start or stop a recording.
//
//   DAILY_API_KEY=... node scripts/verify-recording-token.js
//
// A hidden Record button is not a denied permission — enable_recording_ui
// only removes the control from Daily Prebuilt, and anyone with a console
// could still call stopRecording(). So this checks the token's actual
// decoded claims, and Daily's own reading of them, rather than anything
// about the UI.
//
// It imports the real builder from lib/recordingConfig.js — the same
// module /api/daily-room.js uses — so it can't drift out of sync with
// what the endpoint actually sends.
const { buildMeetingTokenProperties, RECORDING_ROOM_PROPERTIES } = require('../lib/recordingConfig.js');

const API_KEY = process.env.DAILY_API_KEY;
const ROOM_NAME = `cq-verify-${Date.now()}`;

if (!API_KEY) {
  console.error('DAILY_API_KEY is not set.\n\nRun:  DAILY_API_KEY=... node scripts/verify-recording-token.js');
  process.exit(2);
}

const auth = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

// A Daily meeting token is a JWT: the middle segment is base64url-encoded
// JSON and needs no secret to read.
function decodeClaims(token) {
  const segment = String(token).split('.')[1];
  if (!segment) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

const results = [];
function check(label, passed, detail) {
  results.push({ label, passed });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`);
}

async function main() {
  let created = false;

  try {
    // 1. A room configured exactly like a real match room.
    const roomRes = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: ROOM_NAME,
        privacy: 'private',
        properties: {
          ...RECORDING_ROOM_PROPERTIES,
          exp: Math.floor(Date.now() / 1000) + 600
        }
      })
    });

    if (!roomRes.ok) {
      console.error(`\nCould not create the test room (${roomRes.status}):\n${await roomRes.text()}`);
      process.exit(1);
    }
    created = true;
    const room = await roomRes.json();

    console.log('\nRoom config as Daily stored it:');
    console.log(`  enable_recording = ${JSON.stringify(room.config?.enable_recording)}`);
    check('room permits cloud recording', room.config?.enable_recording === 'cloud', room.config?.enable_recording);

    // 2. A token built by the same function the endpoint uses.
    const props = buildMeetingTokenProperties({ roomName: ROOM_NAME, userId: 'verify-user' });
    console.log('\nToken properties requested:');
    console.log(JSON.stringify(props, null, 2).split('\n').map((l) => '  ' + l).join('\n'));

    const tokenRes = await fetch('https://api.daily.co/v1/meeting-tokens', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ properties: props })
    });

    if (!tokenRes.ok) {
      console.error(`\nCould not mint a token (${tokenRes.status}):\n${await tokenRes.text()}`);
      process.exit(1);
    }
    const { token } = await tokenRes.json();

    // 3. The claims actually baked into the token.
    const claims = decodeClaims(token);
    console.log('\nDecoded token claims:');
    console.log(JSON.stringify(claims, null, 2).split('\n').map((l) => '  ' + l).join('\n'));

    const canAdmin = claims.permissions?.canAdmin;
    const adminList = Array.isArray(canAdmin) ? canAdmin : canAdmin === true ? ['<all>'] : [];

    console.log('\nChecks:');
    check('recording auto-starts on join (start_cloud_recording)', claims.start_cloud_recording === true, claims.start_cloud_recording);
    check('Record button hidden (enable_recording_ui === false)', claims.enable_recording_ui === false, claims.enable_recording_ui);
    check('not a meeting owner (is_owner not true)', claims.is_owner !== true, claims.is_owner);
    check('no streaming/recording admin (canAdmin excludes "streaming")', !adminList.includes('streaming') && !adminList.includes('<all>'), canAdmin);
    check('no admin permissions at all (canAdmin empty)', adminList.length === 0, canAdmin);
    check('can still send audio/video (canSend not disabled)', claims.permissions?.canSend !== false, claims.permissions?.canSend);
    check('still present in the call (hasPresence not false)', claims.permissions?.hasPresence !== false, claims.permissions?.hasPresence);

    // 4. Daily's own reading of the token, which is what it enforces.
    const introspectRes = await fetch(`https://api.daily.co/v1/meeting-tokens/${token}`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    if (introspectRes.ok) {
      const seen = await introspectRes.json();
      console.log('\nDaily\'s own reading of the token (GET /meeting-tokens/:token):');
      console.log(JSON.stringify(seen, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
      check('Daily agrees the Record button is hidden', seen.enable_recording_ui === false, seen.enable_recording_ui);
      check('Daily agrees recording auto-starts', seen.start_cloud_recording === true, seen.start_cloud_recording);
    } else {
      console.log(`\n(Could not introspect the token: ${introspectRes.status}. Decoded claims above still stand.)`);
    }
  } finally {
    if (created) {
      await fetch(`https://api.daily.co/v1/rooms/${ROOM_NAME}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${API_KEY}` }
      }).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('');
  if (failed.length) {
    console.log(`${failed.length} of ${results.length} checks FAILED:`);
    failed.forEach((f) => console.log(`  - ${f.label}`));
    process.exit(1);
  }
  console.log(`All ${results.length} checks passed.`);
  console.log('\nStill worth one live call: confirm the recording actually starts');
  console.log('and that no Record control appears for either participant.');
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
