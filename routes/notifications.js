const router = require('express').Router();
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');

// GET /api/notifications — the logged-in user's most recent notifications
router.get('/', requireAuth, async (req, res) => {
  const notifications = await Notification.find({ user: req.user.id })
    .sort({ createdAt: -1 })
    .limit(30);
  res.json(notifications);
});

// PATCH /api/notifications/mark-read — marks every notification as read
router.patch('/mark-read', requireAuth, async (req, res) => {
  await Notification.updateMany({ user: req.user.id, read: false }, { read: true });
  res.json({ message: 'Marked as read' });
});

module.exports = router;
