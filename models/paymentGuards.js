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
 * 1. Rejects paid bookings that have no valid screenshot / payment method.
 * 2. After the existing bookings route has created the booking, writes the
 *    payment fields onto it (and sets paymentStatus) before the response is sent.
 *
 * Step 2 hooks res.json so routes/bookings.js does not need to change. Once you
 * are happy with it you can move the fields into the Booking.create({...}) call
 * in that route and delete the res.json hook below.
 */
function validatePaymentOnCreate(req, res, next) {
  const { packageId, paymentScreenshot, paymentMethod, transactionId } = req.body || {};

  if (!PACKAGE_IDS.includes(packageId)) {
    return res.status(400).json({ message: 'Please select a package.' });
  }

  const isFree = packageId === FREE_PACKAGE;
  const fields = { packageId, paymentStatus: isFree ? 'approved' : 'pending' };

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

  // Save payment fields onto the booking once the route has created it.
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    res.json = originalJson; // only intercept once
    const id = body && (body._id || (body.booking && body.booking._id));
    if (res.statusCode >= 400 || !id) return originalJson(body);

    Booking.updateOne({ _id: id }, { $set: fields })
      .then(() => {
        // Reflect the status in the response the client receives.
        const target = body.booking && typeof body.booking === 'object' ? body.booking : body;
        try { target.paymentStatus = fields.paymentStatus; } catch (e) { /* ignore */ }
        originalJson(body);
      })
      .catch((err) => {
        console.error('Could not save payment details for booking', String(id), err);
        originalJson(body);
      });
    return res;
  };

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
