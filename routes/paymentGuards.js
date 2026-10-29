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
 * Rejects bookings without valid payment proof and passes validated payment
 * fields to the booking route for atomic persistence with the booking.
 */
function validatePaymentOnCreate(req, res, next) {
  const { packageId, paymentScreenshot, paymentMethod, transactionId } = req.body || {};

  if (!PACKAGE_IDS.includes(packageId)) {
    return res.status(400).json({ message: 'Please select a package.' });
  }
  if (packageId === FREE_PACKAGE) {
    return res.status(400).json({ message: 'Tutoring bookings require a paid package.' });
  }

  const fields = { paymentStatus: 'pending' };

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
    const booking = await Booking.findById(bookingId).select('paymentStatus paymentNote').lean();
    if (!booking) return next(); // route will 404

    const status = booking.paymentStatus;
    if (!status || status === 'approved') return next();

    const message =
      status === 'rejected'
        ? 'Your payment was rejected' + (booking.paymentNote ? ': ' + booking.paymentNote : '.') + ' Please contact support.'
        : 'Chat unlocks once your payment is approved.';
    return res.status(403).json({ message, paymentStatus: status });
  } catch (err) {
    next(err);
  }
}

module.exports = { validatePaymentOnCreate, requireApprovedPayment, PACKAGE_IDS };
