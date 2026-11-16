// Signed unsubscribe links for message notification emails. The link
// has to work without logging in, so instead of a session it carries
// an HMAC of the user id keyed with UNSUBSCRIBE_SECRET — nobody can
// turn off someone else's emails by guessing or editing the id.
// Shared by /api/send-message-email (makes links) and /api/unsubscribe
// (checks them).
const crypto = require('crypto');

const SITE_URL = 'https://carequest.info';

function sign(userId) {
  return crypto
    .createHmac('sha256', process.env.UNSUBSCRIBE_SECRET)
    .update(`unsubscribe:${userId}`)
    .digest('hex');
}

function unsubscribeUrl(userId) {
  return `${SITE_URL}/api/unsubscribe?u=${encodeURIComponent(userId)}&t=${sign(userId)}`;
}

function verify(userId, token) {
  if (!process.env.UNSUBSCRIBE_SECRET) return false;
  if (typeof userId !== 'string' || typeof token !== 'string') return false;
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[0-9a-f]{64}$/i.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(userId), 'hex'), Buffer.from(token, 'hex'));
}

module.exports = { SITE_URL, unsubscribeUrl, verify };
