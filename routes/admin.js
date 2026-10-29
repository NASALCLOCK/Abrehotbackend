const router = require('express').Router();
const TutorProfile = require('../models/TutorProfile');
const Booking = require('../models/Booking');
const ContactMessage = require('../models/ContactMessage');
const User = require('../models/User');
const BookAd = require('../models/BookAd');
const PricingRate = require('../models/PricingRate');
const TutorBook = require('../models/TutorBook');
const Subject = require('../models/Subject');
const { DEFAULT_PRICES } = require('../utils/pricing');
const { DEFAULT_SUBJECTS } = require('../utils/subjects');
const { requireAdmin } = require('../middleware/adminAuth');
const { notify } = require('../utils/notifications');
const { sendToUser } = require('../utils/mailer');

// Every route below requires the x-admin-secret header to match ADMIN_SECRET
router.use(requireAdmin);

const pricingPlanIds = new Set(Object.keys(DEFAULT_PRICES));
const defaultSubjectNames = new Set(DEFAULT_SUBJECTS.map((name) => name.toLowerCase()));

router.get('/subjects', async (req, res, next) => {
  try {
    const saved = await Subject.find().select('name -_id').sort({ name: 1 }).lean();
    res.json({
      subjects: [
        ...DEFAULT_SUBJECTS.map((name) => ({ name, isDefault: true })),
        ...saved.map(({ name }) => ({ name, isDefault: false })),
      ],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/subjects', async (req, res, next) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ message: 'Subject name must be between 1 and 120 characters' });
  }
  const normalizedName = name.toLowerCase();
  if (defaultSubjectNames.has(normalizedName)) {
    return res.status(409).json({ message: 'That subject is already in the catalog' });
  }
  try {
    const subject = await Subject.create({ name, normalizedName });
    res.status(201).json({ name: subject.name, isDefault: false });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'That subject is already in the catalog' });
    next(err);
  }
});

function addisAbabaDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, month: `${values.year}-${values.month}` };
}

router.get('/overview', async (req, res, next) => {
  try {
    const { day, month } = addisAbabaDateParts(new Date());
    const amountExpression = {
      $let: {
        vars: {
          match: {
            $regexFind: {
              input: { $convert: { input: { $ifNull: ['$packageFee', '$studentFee'] }, to: 'string', onNull: '' } },
              regex: /^[0-9,]+(?:\.[0-9]+)?/,
            },
          },
        },
        in: {
          $convert: {
            input: { $replaceAll: { input: { $ifNull: ['$$match.match', '0'] }, find: ',', replacement: '' } },
            to: 'double',
            onError: 0,
            onNull: 0,
          },
        },
      },
    };
    const paidAtExpression = { $ifNull: ['$paymentReviewedAt', '$createdAt'] };
    const dateFormat = (format) => ({
      $dateToString: { format, date: paidAtExpression, timezone: 'Africa/Addis_Ababa' },
    });
    const [revenueRows, users, approvedTutors, bookings, pendingPayments, pendingBooks] = await Promise.all([
      Booking.aggregate([
        { $match: { paymentStatus: 'approved' } },
        { $set: { revenueAmount: amountExpression, revenuePaidAt: paidAtExpression } },
        {
          $facet: {
            allTime: [{ $group: { _id: null, total: { $sum: '$revenueAmount' }, payments: { $sum: 1 } } }],
            today: [
              { $match: { $expr: { $eq: [dateFormat('%Y-%m-%d'), day] } } },
              { $group: { _id: null, total: { $sum: '$revenueAmount' } } },
            ],
            month: [
              { $match: { $expr: { $eq: [dateFormat('%Y-%m'), month] } } },
              { $group: { _id: null, total: { $sum: '$revenueAmount' } } },
            ],
          },
        },
      ]),
      User.countDocuments(),
      TutorProfile.countDocuments({ status: 'approved' }),
      Booking.countDocuments(),
      Booking.countDocuments({ paymentStatus: 'pending' }),
      TutorBook.countDocuments({ status: 'pending' }),
    ]);
    const totals = revenueRows[0] || {};
    res.json({
      revenue: {
        allTime: totals.allTime[0]?.total || 0,
        month: totals.month[0]?.total || 0,
        today: totals.today[0]?.total || 0,
        approvedPayments: totals.allTime[0]?.payments || 0,
      },
      stats: { users, approvedTutors, bookings, pendingPayments, pendingBooks },
      timeZone: 'Africa/Addis_Ababa',
    });
  } catch (err) {
    next(err);
  }
});

function tutorBookMetadata(book) {
  const result = book.toObject();
  delete result.fileData;
  return result;
}

router.get('/pricing', async (req, res, next) => {
  try {
    const rates = await PricingRate.find().select('planId price -_id').lean();
    res.json({
      prices: Object.assign(
        {},
        DEFAULT_PRICES,
        Object.fromEntries(rates.map((rate) => [rate.planId, rate.price]))
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/pricing', async (req, res, next) => {
  try {
    const prices = req.body && req.body.prices;
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
      return res.status(400).json({ message: 'A prices object is required' });
    }
    const entries = Object.entries(prices);
    if (!entries.length || entries.some(([planId, price]) =>
      !pricingPlanIds.has(planId) || !Number.isSafeInteger(price) || price < 0
    )) {
      return res.status(400).json({ message: 'Prices must use supported plan IDs and non-negative whole numbers' });
    }
    await PricingRate.bulkWrite(entries.map(([planId, price]) => ({
      updateOne: { filter: { planId }, update: { $set: { price } }, upsert: true },
    })));
    res.json({ prices: Object.fromEntries(entries) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/tutors?status=pending  (status optional, defaults to pending)
router.get('/tutors', async (req, res) => {
  const status = req.query.status || 'pending';
  const filter = status === 'all' ? {} : { status };
  const tutors = await TutorProfile.find(filter).sort({ createdAt: -1 });
  res.json(tutors);
});

// POST /api/admin/tutors/:id/approve
router.post('/tutors/:id/approve', async (req, res) => {
  const tutor = await TutorProfile.findByIdAndUpdate(req.params.id, { status: 'approved' }, { new: true });
  if (!tutor) return res.status(404).json({ message: 'Not found' });

  // Tutor accounts already have the "Tutor" role from signup — approval here
  // only controls whether the profile is publicly listed on tutors.html.
  // The role sync below is kept as a safety net for any legacy application
  // whose user account somehow isn't marked "Tutor" yet.
  if (tutor.user) {
    await User.findByIdAndUpdate(tutor.user, { role: 'Tutor' });
  }

  notify(tutor.user, "Great news — your tutor application has been approved! You're now listed on the Find a Tutor page.", '../dashboards/tutor-dash.html');

  // Welcome email to the newly accepted tutor (best effort: never fail the
  // approval because of it — sendToUser never throws either).
  if (tutor.email) {
    try {
      const site = (process.env.SITE_URL || 'https://abrehottutoring.com.et').replace(/\/+$/, '');
      const dashUrl = site + '/dashboards/tutor-dash.html';
      await sendToUser(
        tutor.email,
        'Welcome aboard — your tutor application was approved',
        'Hi ' + (tutor.fullname || 'there') + ',\n\n' +
          "Great news! Your tutor application has been approved. You're now listed on the Find a Tutor page, so students can discover and book you.\n\n" +
          'You can see your bookings, availability and profile here:\n' + dashUrl + '\n\n' +
          'If anything looks wrong, just reply to this email.\n\n' +
          '— Abrehot Online Tutorials'
      );
    } catch (e) {
      console.error('Tutor approval email failed', e);
    }
  }

  res.json(tutor);
});

// POST /api/admin/tutors/:id/reject
router.post('/tutors/:id/reject', async (req, res) => {
  const tutor = await TutorProfile.findByIdAndUpdate(req.params.id, { status: 'rejected' }, { new: true });
  if (!tutor) return res.status(404).json({ message: 'Not found' });
  notify(tutor.user, 'Your tutor application was not approved this time. Contact support if you have questions.', '../contact.html');
  res.json(tutor);
});

// GET /api/admin/bookings — quick visibility into incoming booking requests
router.get('/bookings', async (req, res) => {
  await Booking.updateMany(
    { paymentStatus: 'approved', status: 'pending' },
    { $set: { status: 'confirmed' } }
  );
  const bookings = await Booking.find()
    .populate('tutor', 'fullname user')
    .populate('requestedBy', 'fullname email')
    .sort({ createdAt: -1 })
    .limit(100);
  res.json(bookings);
});

// POST /api/admin/bookings/:id/approve — admin approves a pending request
router.post('/bookings/:id/approve', async (req, res) => {
  const booking = await Booking.findById(req.params.id).populate('tutor', 'fullname user');
  if (!booking) return res.status(404).json({ message: 'Not found' });
  if (booking.status !== 'pending') {
    return res.status(400).json({ message: 'Only pending requests can be approved' });
  }

  booking.status = 'confirmed';
  await booking.save();

  if (booking.requestedBy) {
    notify(booking.requestedBy, 'Your booking request was approved by an admin and is now confirmed.', '../dashboards/student-dash.html');
  }
  if (booking.tutor && booking.tutor.user) {
    notify(booking.tutor.user, 'A booking request assigned to you was approved by an admin.', '../dashboards/tutor-dash.html');
  }

  res.json(booking);
});

// POST /api/admin/bookings/:id/reject — admin rejects a pending request
router.post('/bookings/:id/reject', async (req, res) => {
  const booking = await Booking.findById(req.params.id).populate('tutor', 'fullname user');
  if (!booking) return res.status(404).json({ message: 'Not found' });
  if (booking.status !== 'pending') {
    return res.status(400).json({ message: 'Only pending requests can be rejected' });
  }

  booking.status = 'rejected';
  await booking.save();

  if (booking.requestedBy) {
    notify(booking.requestedBy, 'Your booking request was not approved by the admin. Contact support if you have questions.', '../contact.html');
  }
  // The tutor is intentionally not notified here — they were never shown this
  // request in the first place (see GET /api/bookings/for-tutor), so there's
  // nothing for them to be told got rejected.

  res.json(booking);
});

// GET /api/admin/contact — quick visibility into contact form submissions
router.get('/contact', async (req, res) => {
  const messages = await ContactMessage.find().sort({ createdAt: -1 }).limit(100);
  res.json(messages);
});

// GET /api/admin/book-ads — every ad, including inactive ones (admin-only view)
router.get('/book-ads', async (req, res) => {
  const ads = await BookAd.find().sort({ createdAt: -1 });
  res.json(ads);
});

router.get('/tutor-books', async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
      return res.status(400).json({ message: 'Choose a valid book status.' });
    }
    const filter = status === 'all' ? {} : { status };
    const books = await TutorBook.find(filter)
      .select('-fileData')
      .populate('tutor', 'fullname')
      .sort({ createdAt: -1 })
      .lean();
    res.json(books);
  } catch (err) {
    next(err);
  }
});

router.get('/tutor-books/:id/file', async (req, res, next) => {
  try {
    const book = await TutorBook.findById(req.params.id).select('+fileData');
    if (!book) return res.status(404).json({ message: 'Book not found.' });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': book.fileData.length,
      'Content-Disposition': 'inline; filename="tutor-book-' + book._id + '.pdf"',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(book.fileData);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Book not found.' });
    next(err);
  }
});

async function reviewTutorBook(req, res, status, next) {
  try {
    const book = await TutorBook.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status } },
      { new: true }
    );
    if (!book) return res.status(404).json({ message: 'Pending book not found.' });
    await notify(
      book.user,
      status === 'approved'
        ? 'Your book "' + book.title + '" was approved and is now available on the Books page.'
        : 'Your book "' + book.title + '" was not approved. Contact support if you have questions.',
      '../books.html'
    );
    res.json(tutorBookMetadata(book));
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Pending book not found.' });
    next(err);
  }
}

router.post('/tutor-books/:id/approve', (req, res, next) => reviewTutorBook(req, res, 'approved', next));
router.post('/tutor-books/:id/reject', (req, res, next) => reviewTutorBook(req, res, 'rejected', next));

// POST /api/admin/book-ads — add a new book advertisement
router.post('/book-ads', async (req, res) => {
  const { title, author, description, price, imageUrl, buyLink } = req.body;
  if (!title || price === undefined || price === '') {
    return res.status(400).json({ message: 'Title and price are required' });
  }
  const ad = await BookAd.create({
    title,
    author,
    description,
    price: Number(price),
    imageUrl,
    buyLink,
  });
  res.status(201).json(ad);
});

// PATCH /api/admin/book-ads/:id — edit a book ad, or flip active/inactive
router.patch('/book-ads/:id', async (req, res) => {
  const editable = ['title', 'author', 'description', 'price', 'imageUrl', 'buyLink', 'active'];
  const updates = {};
  editable.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });
  if (updates.price !== undefined) updates.price = Number(updates.price);
  const ad = await BookAd.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!ad) return res.status(404).json({ message: 'Not found' });
  res.json(ad);
});

// DELETE /api/admin/book-ads/:id
router.delete('/book-ads/:id', async (req, res) => {
  const ad = await BookAd.findByIdAndDelete(req.params.id);
  if (!ad) return res.status(404).json({ message: 'Not found' });
  res.json({ message: 'Removed' });
});

module.exports = router;
