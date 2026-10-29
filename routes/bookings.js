const router = require('express').Router();
const Booking = require('../models/Booking');
const TutorProfile = require('../models/TutorProfile');
const Child = require('../models/Child');
const PricingRate = require('../models/PricingRate');
const { attachUserIfPresent, requireAuth } = require('../middleware/auth');
const { notifyAdmin, sendToUser } = require('../utils/mailer');
const { notify } = require('../utils/notifications');
const { calculateSubscription } = require('../utils/subscription');
const { DEFAULT_PRICES, resolveBookingPrice } = require('../utils/pricing');

function toArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function getDurationMinutes(durationStr) {
  if (!durationStr) return 60;
  if (durationStr.includes('1.5')) return 90;
  if (durationStr.includes('2 +') || durationStr.includes('2+')) return 150;
  if (durationStr.includes('2')) return 120;
  return 60;
}

function getSessionTimeRange(dateVal, timeStr, durationStr) {
  if (!dateVal || !timeStr) return null;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return null;

  let hours = 9, minutes = 0;
  if (typeof timeStr === 'string' && timeStr.includes(':')) {
    const parts = timeStr.split(':');
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
  }

  const start = new Date(d);
  start.setHours(hours, minutes, 0, 0);
  const durMins = getDurationMinutes(durationStr);
  const end = new Date(start.getTime() + durMins * 60 * 1000);

  return { start: start.getTime(), end: end.getTime() };
}

function isSameDay(d1, d2) {
  if (!d1 || !d2) return false;
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

function getDateKey(dateValue) {
  const value = String(dateValue || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

const TUTORING_PACKAGES = {
  starter: { classSize: 'Self-paced', fee: 'Free', teacherPayment: undefined, min: 0, max: 0 },
  'group-basic': { classSize: '6-10 students', fee: '450-600 ETB/student/hour', teacherPayment: 1000, min: 6, max: 10 },
  'small-group': { classSize: '4-5 students', fee: '550-700 ETB/student/hour', teacherPayment: 1000, min: 4, max: 5 },
  'mini-group': { classSize: '3 students', fee: '800 ETB/student/hour', teacherPayment: 1000, min: 3, max: 3 },
  duo: { classSize: '2 students', fee: '1,000 ETB/student/hour', teacherPayment: 1000, min: 2, max: 2 },
  'premium-one-to-one': { classSize: '1 student', fee: '1,800 ETB/hour', teacherPayment: 1000, min: 1, max: 1 },
  'vip-one-to-one': { classSize: '1 student', fee: '2,300 ETB/hour', teacherPayment: 1000, min: 1, max: 1 },
};

// POST /api/bookings — matches book.html
router.post('/', attachUserIfPresent, async (req, res) => {
  try {
    const {
      grade, subject, other, topic, goal,
      session, groupMode, groupSize, platform, city, address, language,
      date, time, duration, notes, tutorId, childId, contactEmail,
      planType, selectedDays, selectedTimeSlots, pricingPlanId: submittedPricingPlanId, quotedPrice,
    } = req.body;

    if (!grade) {
      return res.status(400).json({ message: 'Grade is required' });
    }

    const savedRates = await PricingRate.find().select('planId price -_id').lean();
    const prices = Object.assign(
      {},
      DEFAULT_PRICES,
      Object.fromEntries(savedRates.map((rate) => [rate.planId, rate.price]))
    );
    const priceQuote = resolveBookingPrice(
      { subject, grade, planType: planType || 'hourly', session, groupSize, selectedDays, duration },
      prices
    );
    if (!priceQuote) {
      return res.status(400).json({
        message: 'No price is configured for this grade, subject, group size, and plan. Choose an available tutoring plan.',
      });
    }
    if ((submittedPricingPlanId && submittedPricingPlanId !== priceQuote.planId)
      || (quotedPrice !== undefined && Number(quotedPrice) !== priceQuote.amount)) {
      return res.status(409).json({ message: 'The price changed while you were booking. Please review the updated price and try again.' });
    }
    const packageId = priceQuote.packageId;
    const selectedPackage = TUTORING_PACKAGES[packageId];
    if (!selectedPackage) {
      return res.status(400).json({ message: 'Please choose a valid tutoring package.' });
    }
    if (selectedPackage.min >= 2 && session !== 'group') {
      return res.status(400).json({ message: 'Group packages must be booked as a group session.' });
    }
    if (selectedPackage.max === 1 && session !== 'online' && session !== 'in-person') {
      return res.status(400).json({ message: 'One-to-one packages require an online or in-person session.' });
    }

    if (planType === 'weekly' || planType === 'monthly') {
      const daysArr = toArray(selectedDays);
      if (!daysArr.length) {
        return res.status(400).json({ message: 'Please select at least one study day for your subscription.' });
      }
    }

    if (!date || !time) {
      return res.status(400).json({ message: 'Preferred Date and Time are required to schedule your session.' });
    }
    const dateKey = getDateKey(date);
    if (!dateKey) {
      return res.status(400).json({ message: 'Please choose a valid booking date.' });
    }

    // Tutors book out their own time — they don't book sessions with other
    // tutors through this form.
    if (req.user && req.user.role === 'Tutor') {
      return res.status(403).json({ message: 'Tutor accounts cannot book tutoring sessions.' });
    }
    const emailRecipient = req.user && req.user.email
      ? req.user.email
      : typeof contactEmail === 'string' ? contactEmail.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRecipient) || emailRecipient.length > 254) {
      return res.status(400).json({ message: 'Enter a valid email address to receive your booking updates.' });
    }

    // A booking with no tutor attached has nobody to accept/act on it — it just
    // sits there forever. Students/parents must pick a tutor (on tutors.html)
    // before they can submit the booking form.
    if (!tutorId) {
      return res.status(400).json({ message: 'Please choose a tutor before booking a session.' });
    }
    const chosenTutor = await TutorProfile.findById(tutorId).catch(function () { return null; });
    if (!chosenTutor || chosenTutor.status !== 'approved') {
      return res.status(400).json({ message: 'That tutor is not available for booking.' });
    }

    const requestedSubjects = toArray(subject)
      .map((value) => String(value).trim())
      .filter(Boolean);
    const tutorSubjects = (chosenTutor.subjects || []).map((value) => String(value).trim().toLowerCase());
    const unsupportedSubject = requestedSubjects.find(
      (value) => !tutorSubjects.includes(value.toLowerCase())
    );
    if (!requestedSubjects.length) {
      return res.status(400).json({ message: 'Please select a subject this tutor teaches.' });
    }
    if (unsupportedSubject) {
      return res.status(400).json({
        message: `This tutor does not teach ${unsupportedSubject}. Please choose one of the tutor's subjects.`,
      });
    }

    // A tutor accepts at most one active booking on each calendar date.
    const dayStart = new Date(`${dateKey}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const sameDayBooking = await Booking.findOne({
      tutor: tutorId,
      status: { $in: ['pending', 'confirmed'] },
      $or: [
        { dateKey },
        { date: { $gte: dayStart, $lt: dayEnd } },
      ],
    });
    if (sameDayBooking) {
      return res.status(400).json({
        message: 'This tutor is already booked for that day. Please select a different date.',
      });
    }

    // Group sessions: the booker must say how many students are splitting the
    // rate (2-30) and how the group will actually meet the tutor (online picks a
    // platform, in-person picks a location).
    let effectiveMode = session; // for 'online'/'in-person' the venue is the session itself
    if (selectedPackage.min >= 2) {
      const size = Number(groupSize);
      if (!Number.isInteger(size) || size < selectedPackage.min || size > selectedPackage.max) {
        return res.status(400).json({ message: `Group size must match the selected package (${selectedPackage.min}-${selectedPackage.max} students).` });
      }
      if (groupMode !== 'online' && groupMode !== 'in-person') {
        return res.status(400).json({ message: 'Please choose how the group will meet: online or in-person.' });
      }
      effectiveMode = groupMode;
    }

    // Session-type-specific requirements: an online meeting platform only makes
    // sense for online sessions (including online group sessions), and shouldn't
    // be forced on in-person bookings.
    const onlinePlatforms = new Set(['googleMeet', 'zoom', 'telegram']);
    if (effectiveMode === 'online' && !onlinePlatforms.has(platform)) {
      return res.status(400).json({ message: 'Please choose an online meeting platform.' });
    }
    const selectedPlatform = effectiveMode === 'online' ? platform : undefined;

    // If a childId was sent, make sure it actually belongs to whoever is logged in —
    // otherwise a parent could book "for" someone else's child.
    let child = null;
    if (childId) {
      child = await Child.findById(childId);
      if (!child || !req.user || child.parent.toString() !== req.user.id) {
        return res.status(400).json({ message: 'Invalid child selected' });
      }
    }

    let subscription;
    try {
      subscription = calculateSubscription({
        planType,
        selectedDays: toArray(selectedDays),
      });
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const booking = await Booking.create({
      requestedBy: req.user ? req.user.id : undefined,
      contactEmail: req.user && req.user.email ? undefined : emailRecipient,
      tutor: tutorId || undefined,
      child: child ? child._id : undefined,
      grade,
      subject: requestedSubjects,
      otherSubject: other,
      topic,
      goal: toArray(goal),
      session,
      groupMode: session === 'group' ? groupMode : undefined,
      groupSize: session === 'group' ? Number(groupSize) : undefined,
      packageId,
      packageClassSize: priceQuote.classSize,
      studentFee: priceQuote.fee,
      teacherPayment: selectedPackage.teacherPayment,
      packageFee: priceQuote.fee,
      platform: selectedPlatform,
      city,
      address,
      language,
      date: date || undefined,
      dateKey,
      time,
      duration,
      notes,
      planType: ['weekly', 'monthly'].includes(planType) ? planType : 'hourly',
      selectedDays: ['weekly', 'monthly'].includes(planType) ? toArray(selectedDays) : [],
      selectedTimeSlots: ['weekly', 'monthly'].includes(planType) ? (selectedTimeSlots || []) : [],
      status: 'pending', // Awaiting admin approval — see /api/admin/bookings/:id/approve|reject
      subscriptionFrequency: subscription.frequency,
      subscriptionStatus: subscription.frequency ? 'pending' : undefined,
      ...(req.paymentFields || {}), // paymentStatus, and paymentMethod/paymentScreenshot/transactionId for paid packages — set by validatePaymentOnCreate
    });

    const bookingEmailDelivery = await sendToUser(
          emailRecipient,
          'Booking request received — Abrehot Online Tutorials',
          'Hi ' + (req.user.fullname || 'there') + ',\n\n' +
            'We received your tutoring request and will review it shortly.\n\n' +
            'Tutor: ' + (chosenTutor.fullname || 'your tutor') + '\n' +
            'Subject(s): ' + ((booking.subject || []).join(', ') || other || '-') + '\n' +
            'Session: ' + (session || '-') + '\n' +
            'Meeting platform: ' + ({ googleMeet: 'Google Meet', zoom: 'Zoom', telegram: 'Telegram' }[selectedPlatform] || 'In person') + '\n' +
            `Preferred date/time: ${dateKey} ${time}\n\n` +
            'If you selected an online platform, the meeting link will be emailed after your payment is approved.\n\n' +
            '— Abrehot Online Tutorials'
        );
    if (bookingEmailDelivery.sent) {
      booking.bookingEmailSentAt = new Date();
      try {
        await Booking.updateOne({ _id: booking._id }, { $set: { bookingEmailSentAt: booking.bookingEmailSentAt } });
      } catch (emailTrackingError) {
        console.error('Could not save booking receipt email status', emailTrackingError);
      }
    }
    res.status(201).json({
      message: 'Booking request submitted! An admin will review and approve it shortly.',
      booking,
      bookingEmailDelivery,
    });

    const groupLine = session === 'group'
      ? `Group session for ${booking.groupSize} students (${groupMode})\n`
      : '';

    notifyAdmin(
      `New booking request awaiting approval (${grade})`,
      `Subject(s): ${(booking.subject || []).join(', ') || other || '-'}\n` +
        (child ? `For: ${child.name}\n` : '') +
        `Session: ${session || '-'} via ${selectedPlatform || '-'}\n` +
        groupLine +
        `City: ${city || '-'}\n` +
        `Date/time: ${date || '-'} ${time || ''}\n` +
        (notes ? `Notes: ${notes}\n` : '') +
        `\nApprove or reject it on your admin page.`
    );

    // Note: the assigned tutor is intentionally NOT notified here — they
    // shouldn't see or hear about a request until an admin approves it
    // (see POST /api/admin/bookings/:id/approve, which notifies them then).
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({
        message: 'This tutor is already booked for that day. Please select a different date.',
      });
    }
    res.status(500).json({ message: 'Could not submit booking', error: err.message });
  }
});

// GET /api/bookings/mine — a logged-in user's own booking requests, as the requester
// (for parent-dash.html and student-dash.html)
router.get('/mine', requireAuth, async (req, res) => {
  await Booking.updateMany(
    { requestedBy: req.user.id, paymentStatus: 'approved', status: 'pending' },
    { $set: { status: 'confirmed' } }
  );
  const bookings = await Booking.find({ requestedBy: req.user.id })
    .populate('tutor', 'fullname')
    .populate('child', 'name grade')
    .sort({ date: 1, createdAt: -1 });
  res.json(bookings);
});

// GET /api/bookings/for-tutor — bookings assigned to the logged-in user's tutor profile
// (for tutor-dash.html). Pending requests are excluded — a tutor only finds out
// about a request once an admin has approved it.
router.get('/for-tutor', requireAuth, async (req, res) => {
  const profile = await TutorProfile.findOne({ user: req.user.id }).sort({ createdAt: -1 });
  if (!profile) return res.json([]); // not a tutor / no application yet — just show nothing
  await Booking.updateMany(
    { tutor: profile._id, paymentStatus: 'approved', status: 'pending' },
    { $set: { status: 'confirmed' } }
  );
  const bookings = await Booking.find({ tutor: profile._id, status: { $ne: 'pending' } })
    .populate('requestedBy', 'fullname email phone role')
    .populate('child', 'name grade')
    .sort({ date: 1, createdAt: -1 });
  res.json(bookings);
});

// GET /api/bookings/:id — used by the subscription renewal page.
router.get('/:id', requireAuth, async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('tutor', 'fullname')
    .populate('child', 'name grade');
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

  const isRequester = booking.requestedBy && booking.requestedBy.toString() === req.user.id;
  let isAssignedTutor = false;
  if (booking.tutor) {
    const tutorProfile = await TutorProfile.findOne({ user: req.user.id });
    isAssignedTutor = tutorProfile && booking.tutor._id.toString() === tutorProfile._id.toString();
  }
  if (!isRequester && !isAssignedTutor) return res.status(403).json({ message: 'Not allowed to view this booking' });
  res.json(booking);
});

// PATCH /api/bookings/:id/renew — submits payment proof for the same schedule.
router.patch('/:id/renew', requireAuth, async (req, res) => {
  const { paymentMethod, paymentScreenshot, transactionId } = req.body || {};
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!booking.requestedBy || booking.requestedBy.toString() !== req.user.id) {
    return res.status(403).json({ message: 'Only the student can renew this subscription' });
  }
  if (!['weekly', 'monthly'].includes(booking.subscriptionFrequency)) {
    return res.status(400).json({ message: 'This booking does not use a recurring subscription.' });
  }
  if (booking.subscriptionEndsAt && booking.subscriptionEndsAt > new Date()) {
    return res.status(400).json({ message: 'This subscription is still active.' });
  }
  if (!['CBE', 'Telebirr'].includes(paymentMethod)) {
    return res.status(400).json({ message: 'Please choose CBE or Telebirr.' });
  }
  if (typeof paymentScreenshot !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(paymentScreenshot)) {
    return res.status(400).json({ message: 'Please upload a payment screenshot (PNG, JPG or WEBP).' });
  }
  if (paymentScreenshot.length > 3500000) {
    return res.status(400).json({ message: 'Screenshot is too large. Please upload a smaller image.' });
  }

  booking.paymentMethod = paymentMethod;
  booking.paymentScreenshot = paymentScreenshot;
  booking.transactionId = typeof transactionId === 'string' ? transactionId.trim().slice(0, 100) : undefined;
  booking.paymentStatus = 'pending';
  booking.paymentNote = undefined;
  booking.paymentReviewedAt = undefined;
  booking.subscriptionStatus = 'pending';
  booking.subscriptionStartedAt = undefined;
  booking.subscriptionEndsAt = undefined;
  await booking.save();
  notifyAdmin(
    `Subscription renewal awaiting approval (${booking._id})`,
    `Please review the renewal payment screenshot for booking ${booking._id}.`
  );
  res.json({ message: 'Renewal submitted for payment verification.', paymentStatus: booking.paymentStatus });
});

// PATCH /api/bookings/:id/cancel — used by the "Cancel"/"Remove" buttons.
// Only the person who requested it, or the assigned tutor, may cancel it.
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

  const isRequester = booking.requestedBy && booking.requestedBy.toString() === req.user.id;
  let tutorProfile = null;
  let isAssignedTutor = false;
  if (booking.tutor) {
    tutorProfile = await TutorProfile.findOne({ user: req.user.id });
    isAssignedTutor = tutorProfile && booking.tutor.toString() === tutorProfile._id.toString();
  }
  if (!isRequester && !isAssignedTutor) {
    return res.status(403).json({ message: 'Not allowed to cancel this booking' });
  }
  // A pending request hasn't been approved yet — that decision belongs to the
  // admin (see /api/admin/bookings/:id/approve|reject), not the tutor.
  if (isAssignedTutor && !isRequester && booking.status === 'pending') {
    return res.status(403).json({ message: 'This request is awaiting admin approval — only an admin can accept or reject it.' });
  }

  booking.status = 'cancelled';
  await booking.save();

  // Let the other side know — whoever didn't do the cancelling.
  if (isRequester && booking.tutor) {
    TutorProfile.findById(booking.tutor).then((tutor) => {
      if (tutor && tutor.user) {
        notify(tutor.user, 'A booking request was cancelled by the requester.', '../dashboards/tutor-dash.html');
      }
    });
  } else if (isAssignedTutor && booking.requestedBy) {
    notify(booking.requestedBy, 'Your booking request was declined or cancelled by the tutor.', '../dashboards/parent-dash.html');
  }

  res.json(booking);
});

// Note: approving/rejecting a pending booking request is done by an admin —
// see POST /api/admin/bookings/:id/approve and /:id/reject in routes/admin.js.

// PATCH /api/bookings/:id/complete — tutor marks a confirmed session done.
// body: { attended: true|false } — true if the student showed up, false for
// a no-show. This is also what feeds the student's Attendance stat.
router.patch('/:id/complete', requireAuth, async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ message: 'Booking not found' });

  const tutorProfile = await TutorProfile.findOne({ user: req.user.id });
  const isAssignedTutor = tutorProfile && booking.tutor && booking.tutor.toString() === tutorProfile._id.toString();
  if (!isAssignedTutor) {
    return res.status(403).json({ message: 'Only the assigned tutor can complete this booking' });
  }
  if (booking.status !== 'confirmed') {
    return res.status(400).json({ message: 'Only confirmed sessions can be marked completed' });
  }

  booking.status = 'completed';
  booking.attended = req.body.attended !== false; // default to true unless explicitly marked a no-show
  await booking.save();

  if (booking.requestedBy) {
    notify(
      booking.requestedBy,
      booking.attended ? 'Your session was marked as completed.' : 'You were marked as a no-show for a scheduled session.',
      '../dashboards/student-dash.html'
    );
  }

  res.json(booking);
});

module.exports = router;
