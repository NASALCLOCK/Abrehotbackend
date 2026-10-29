const mongoose = require('mongoose');
const Booking = require('../models/Booking');

const PACKAGE_IDS = [
  'starter',
  'group-basic',
  'small-group',
  'mini-group',
  'duo',
  'premium-one-to-one',
  'vip-one-to-one',
];
const FREE_PACKAGE = 'starter';
const MAX_SCREENSHOT_CHARS = 3500000; // ~2.6 MB of image once base64 is decoded
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/;

/**
 * POST /api/bookings
 * Validates a paid booking's payment proof (screenshot, method, transaction id)
 * and, if it's valid, attaches the fields the route should save on
 * req.paymentFields. routes/bookings.js reads that and includes it directly
 * in the Booking.create({...}) call — the fields are saved as part of the
 * same document write, so there's no separate step that can silently fail
 * to attach the screenshot to the new booking.
 */
function validatePaymentOnCreate(req, res, next) {
  const { packageId, paymentScreenshot, paymentMethod, transactionId } = req.body || {};

  if (!PACKAGE_IDS.includes(packageId)) {
    return res.status(400).json({ message: 'Please select a package.' });
  }

  const isFree = packageId === FREE_PACKAGE;
  const fields = { paymentStatus: isFree ? 'approved' : 'pending' };

  if (!isFree) {
    if (!['CBE', 'Telebirr'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Please choose CBE or Telebirr.' });
    }
    if (typeof paymentScreenshot !== 'string' || !DATA_URL_RE.test(paymentScreenshot)) {
      return res.status(400).json({ message: 'Please upload a payment screenshot (PNG, JPG or WEBP).' });
    }
    if (paymentScreenshot.length > MAX_SCREENSHOT_CHARS) {
      return res.status(400).json({ message: 'Screenshot is too large. Please upload a smaller image.' });
    }
    fields.paymentMethod = paymentMethod;
    fields.paymentScreenshot = paymentScreenshot;
    if (typeof transactionId === 'string' && transactionId.trim()) {
      fields.transactionId = transactionId.trim().slice(0, 100);
    }
  }

  req.paymentFields = fields;
  next();
}

/**
 * /api/messages/booking/:bookingId  (GET + POST)
 * Blocks chat until the payment is approved. Bookings without a paymentStatus
 * (created before this feature) are allowed through.
 */
async function requireApprovedPayment(req, res, next) {
  try {
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId)) return next(); // let the route handle bad ids

    // lean() so missing paymentStatus stays undefined instead of picking up the schema default
    const booking = await Booking.findById(bookingId)
      .select('paymentStatus paymentNote subscriptionFrequency subscriptionEndsAt subscriptionStatus')
      .lean();
    if (!booking) return next(); // route will 404

    const status = booking.paymentStatus;
    if (!status || status === 'approved') {
      if (
        status === 'approved' &&
        booking.subscriptionFrequency &&
        booking.subscriptionEndsAt &&
        new Date(booking.subscriptionEndsAt) <= new Date()
      ) {
        return res.status(403).json({
          message: 'Your subscription has ended. Pay your subscription to continue chatting.',
          paymentStatus: 'expired',
          renewalUrl: '/renew.html?bookingId=' + bookingId,
          subscriptionEndsAt: booking.subscriptionEndsAt,
        });
      }
      return next();
    }

    const message =
      status === 'rejected'
        ? 'Your payment was rejected' + (booking.paymentNote ? ': ' + booking.paymentNote : '.') + ' Please contact support.'
        : 'Chat unlocks once your payment is approved.';
    return res.status(403).json({
      message,
      paymentStatus: status,
      renewalUrl: booking.subscriptionFrequency ? '/renew.html?bookingId=' + bookingId : undefined,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { validatePaymentOnCreate, requireApprovedPayment, PACKAGE_IDS };
