const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Notification = require('../models/Notification');
const { subscriptionEndDate } = require('../utils/subscription');
const { sendToUser } = require('../utils/mailer');
const { createZoomMeeting, isZoomBooking } = require('../utils/zoom');
const { createGoogleMeet, isGoogleMeetBooking } = require('../utils/googleMeet');

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
    const existingBooking = await Booking.findById(id)
      .select('subscriptionFrequency status paymentStatus platform session groupMode dateKey date time duration subject googleMeetEventId googleMeetJoinUrl zoomMeetingId zoomJoinUrl contactEmail confirmationEmailSentAt')
      .lean();
    if (!existingBooking) return res.status(404).json({ message: 'Booking not found.' });
    const reviewTime = new Date();
    const activateSubscription = approved &&
      existingBooking.subscriptionFrequency &&
      existingBooking.paymentStatus !== 'approved';
    const newlyConfirmed = approved && existingBooking.status === 'pending';
    let zoomMeeting = existingBooking.zoomJoinUrl
      ? { id: existingBooking.zoomMeetingId, joinUrl: existingBooking.zoomJoinUrl }
      : null;
    let googleMeet = existingBooking.googleMeetJoinUrl
      ? { id: existingBooking.googleMeetEventId, joinUrl: existingBooking.googleMeetJoinUrl }
      : null;
    let zoomDelivery = zoomMeeting ? { created: true, alreadyCreated: true } : { created: false, reason: 'not-required' };
    let googleMeetDelivery = googleMeet ? { created: true, alreadyCreated: true } : { created: false, reason: 'not-required' };
    if (approved && isZoomBooking(existingBooking) && !zoomMeeting) {
      try {
        zoomMeeting = await createZoomMeeting(existingBooking);
        zoomDelivery = { created: true };
      } catch (e) {
        zoomDelivery = { created: false, reason: e.message };
        console.error('[zoom] Could not create a meeting for booking ' + id + ':', e.message);
      }
    }
    if (approved && isGoogleMeetBooking(existingBooking) && !googleMeet) {
      try {
        googleMeet = await createGoogleMeet(existingBooking);
        googleMeetDelivery = { created: true };
      } catch (e) {
        googleMeetDelivery = { created: false, reason: e.message };
        console.error('[google-meet] Could not create a meeting for booking ' + id + ':', e.message);
      }
    }
    const update = approved
      ? {
          $set: {
            paymentStatus: 'approved',
            paymentReviewedAt: reviewTime,
            ...(newlyConfirmed ? { status: 'confirmed' } : {}),
            ...(zoomMeeting ? { zoomMeetingId: zoomMeeting.id, zoomJoinUrl: zoomMeeting.joinUrl } : {}),
            ...(googleMeet ? { googleMeetEventId: googleMeet.id, googleMeetJoinUrl: googleMeet.joinUrl } : {}),
            ...(activateSubscription
              ? {
                  subscriptionStatus: 'active',
                  subscriptionStartedAt: reviewTime,
                  subscriptionEndsAt: subscriptionEndDate(reviewTime, existingBooking.subscriptionFrequency),
                }
              : {}),
          },
          $unset: { paymentNote: '' },
        }
      : {
          $set: {
            paymentStatus: 'rejected',
            paymentNote: String(note).trim().slice(0, 500),
            paymentReviewedAt: reviewTime,
            subscriptionStatus: 'pending',
          },
        };

    const booking = await Booking.findByIdAndUpdate(id, update, { new: true, runValidators: false })
      .populate('tutor', 'fullname user')
      .populate('requestedBy', 'fullname email');
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    // Notifications (best effort: never fail the review because of them)
    try {
      const chatLink = 'chat.html?bookingId=' + booking._id;
      const notes = [];
      const meetingUrl = booking.googleMeetJoinUrl || booking.zoomJoinUrl;
      const meetingName = booking.googleMeetJoinUrl ? 'Google Meet' : 'Zoom';
      if (booking.requestedBy) {
        notes.push({
          user: booking.requestedBy._id,
          message: approved
            ? 'Your payment was approved and your booking is confirmed.' +
              (meetingUrl ? ' Join your ' + meetingName + ' session: ' + meetingUrl : '') +
              ' You can now chat with ' + ((booking.tutor && booking.tutor.fullname) || 'your tutor') + '.'
            : 'Your payment was rejected: ' + booking.paymentNote,
          link: approved ? chatLink : 'book.html',
        });
      }
      if (newlyConfirmed && booking.tutor && booking.tutor.user) {
        notes.push({
          user: booking.tutor.user,
          message: 'You have a new confirmed booking' +
            (booking.requestedBy ? ' from ' + booking.requestedBy.fullname : '') +
            (meetingUrl ? '. ' + meetingName + ' link: ' + meetingUrl : '.'),
          link: chatLink,
        });
      }
      if (notes.length) await Notification.insertMany(notes);
    } catch (e) {
      console.error('Payment notification failed', e);
    }

    const emailRecipient = (booking.requestedBy && booking.requestedBy.email) || booking.contactEmail;
    const shouldSendConfirmationEmail = approved &&
      Boolean(emailRecipient) &&
      (!existingBooking.confirmationEmailSentAt ||
        (zoomDelivery.created && !zoomDelivery.alreadyCreated) ||
        (googleMeetDelivery.created && !googleMeetDelivery.alreadyCreated));
    let emailDelivery = { sent: false, reason: 'not-approved' };
    if (shouldSendConfirmationEmail) {
      try {
        const site = (process.env.SITE_URL || 'https://abrehottutoring.com.et').replace(/\/+$/, '');
        const chatUrl = site + '/chat.html?bookingId=' + booking._id;
        const meetingUrl = booking.googleMeetJoinUrl || booking.zoomJoinUrl;
        const platformNames = { googleMeet: 'Google Meet', zoom: 'Zoom', telegram: 'Telegram' };
        const details = [
          'Tutor: ' + ((booking.tutor && booking.tutor.fullname) || 'your tutor'),
          'Subject(s): ' + ((booking.subject || []).join(', ') || '-'),
          booking.session ? 'Session: ' + booking.session : null,
          booking.paymentMethod ? 'Paid via: ' + booking.paymentMethod : null,
          booking.subscriptionEndsAt ? 'Subscription active until: ' + booking.subscriptionEndsAt.toDateString() : null,
          booking.platform ? 'Meeting platform: ' + (platformNames[booking.platform] || booking.platform) : null,
          meetingUrl ? (booking.googleMeetJoinUrl ? 'Google Meet link: ' : 'Zoom link: ') + meetingUrl : null,
          booking.platform === 'telegram' ? 'Your tutor will share the Telegram session details through chat.' : null,
          booking.platform && !meetingUrl && booking.platform !== 'telegram'
            ? 'Your meeting link is being prepared and will be sent in a follow-up email.'
            : null,
        ].filter(Boolean);
        emailDelivery = await sendToUser(
          emailRecipient,
          'Payment confirmed — Abrehot Online Tutorials',
          'Hi ' + ((booking.requestedBy && booking.requestedBy.fullname) || 'there') + ',\n\n' +
            'Good news! Your payment was approved by our team.\n\n' +
            details.join('\n') + '\n\n' +
            'You can now chat with your tutor:\n' + chatUrl + '\n\n' +
            'If anything looks wrong, just reply to this email.\n\n' +
            '— Abrehot Online Tutorials'
        );
        if (emailDelivery.sent) {
          const sentAt = new Date();
          await Booking.updateOne({ _id: booking._id }, { $set: { confirmationEmailSentAt: sentAt } });
          booking.confirmationEmailSentAt = sentAt;
        }
      } catch (e) {
        console.error('Payment confirmation email failed', e);
        emailDelivery = { sent: false, reason: 'send-failed', message: e.message };
      }
    }

    if (approved && !shouldSendConfirmationEmail && existingBooking.confirmationEmailSentAt) {
      emailDelivery = { sent: true, alreadySent: true };
    } else if (approved && !emailRecipient) {
      emailDelivery = { sent: false, reason: 'no-recipient' };
    }

    res.json({
      message: 'Payment ' + booking.paymentStatus + '.',
      paymentStatus: booking.paymentStatus,
      bookingStatus: booking.status,
      emailDelivery,
      zoomDelivery,
      googleMeetDelivery,
      ...(booking.googleMeetJoinUrl ? { googleMeetJoinUrl: booking.googleMeetJoinUrl } : {}),
      ...(booking.zoomJoinUrl ? { zoomJoinUrl: booking.zoomJoinUrl } : {}),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
