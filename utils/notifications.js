const Notification = require('../models/Notification');

// Fire-and-forget — a failed notification write should never break the
// actual request that triggered it (approving a tutor, cancelling a
// booking, etc.).
async function notify(userId, message, link) {
  if (!userId) return;
  try {
    await Notification.create({ user: userId, message, link });
  } catch (err) {
    console.error('[notifications] Failed to create notification:', err.message);
  }
}

module.exports = { notify };
