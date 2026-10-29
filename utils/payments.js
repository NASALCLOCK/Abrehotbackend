const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Notification = require('../models/Notification');

const router = express.Router();

/**
 * ASSUMPTION: the admin panel authenticates with the ADMIN_SECRET from .env,
 * sent as the "x-admin-secret" header (or "Authorization: Bearer <secret>").
 * If routes/admin.js already has its own admin middleware, replace this
 * function with it: const requireAdmin = require('../middleware/yourAdminAuth');
 */
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_SECRET || '';
  const header = req.get('x-admin-secret') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: 'Admin access required.' });
  }
  next();
}

router.use(requireAdmin);

// GET /api/admin/payments?status=pending|approved|rejected
router.get('/', async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const bookings = await Booking.find({ paymentStatus: status })
      .select('+paymentScreenshot')
      .populate('tutor', 'fullname phone')
      .populate('requestedBy', 'fullname email phone role')
      .populate('child', 'name grade')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(bookings);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/counts  -> { pending, approved, rejected }
router.get('/counts', async (req, res, next) => {
  try {
    const rows = await Booking.aggregate([
      { $match: { paymentStatus: { $exists: true } } },
      { $group: { _id: '$paymentStatus', n: { $sum: 1 } } },
    ]);
    const out = { pending: 0, approved: 0, rejected: 0 };
    rows.forEach((r) => { if (r._id in out) out[r._id] = r.n; });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/payments/:id   body: { action: 'approve' | 'reject', note? }
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, note } = req.body || {};
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Invalid booking id.' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ message: 'Invalid action.' });
    if (action === 'reject' && !(note && String(note).trim())) {
      return res.status(400).json({ message: 'Please give a reason for rejecting.' });
    }

    const approved = action === 'approve';
    const update = approved
      ? { $set: { paymentStatus: 'approved', paymentReviewedAt: new Date() }, $unset: { paymentNote: '' } }
      : { $set: { paymentStatus: 'rejected', paymentNote: String(note).trim().slice(0, 500), paymentReviewedAt: new Date() } };

    const booking = await Booking.findByIdAndUpdate(id, update, { new: true, runValidators: false })
      .populate('tutor', 'fullname user')
      .populate('requestedBy', 'fullname');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    // Notifications (best effort: never fail the review because of them)
    try {
      const chatLink = 'chat.html?bookingId=' + booking._id;
      const notes = [];
      if (booking.requestedBy) {
        notes.push({
          user: booking.requestedBy._id,
          message: approved
            ? 'Your payment was approved. You can now chat with ' + ((booking.tutor && booking.tutor.fullname) || 'your tutor') + '.'
            : 'Your payment was rejected: ' + booking.paymentNote,
          link: approved ? chatLink : 'book.html',
        });
      }
      if (approved && booking.tutor && booking.tutor.user) {
        notes.push({
          user: booking.tutor.user,
          message: 'You have a new booking' + (booking.requestedBy ? ' from ' + booking.requestedBy.fullname : '') + '.',
          link: chatLink,
        });
      }
      if (notes.length) await Notification.insertMany(notes);
    } catch (e) {
      console.error('Payment notification failed', e);
    }

    res.json({ message: 'Payment ' + booking.paymentStatus + '.', paymentStatus: booking.paymentStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
