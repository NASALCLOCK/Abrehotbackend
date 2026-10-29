const router = require('express').Router();
const multer = require('multer');
const TutorProfile = require('../models/TutorProfile');
const TutorIntroVideo = require('../models/TutorIntroVideo');
const Rating = require('../models/Rating');
const Subject = require('../models/Subject');
const { attachUserIfPresent, requireAuth } = require('../middleware/auth');
const { notifyAdmin } = require('../utils/mailer');
const { DEFAULT_SUBJECTS } = require('../utils/subjects');
const { inspectIntroVideo, sendIntroVideo } = require('../utils/introVideo');

const MAX_INTRO_VIDEO_SIZE = 15 * 1024 * 1024;
const introVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INTRO_VIDEO_SIZE, files: 1, fields: 0 },
  fileFilter(req, file, callback) {
    const allowed = (file.mimetype === 'video/mp4' && /\.mp4$/i.test(file.originalname))
      || (file.mimetype === 'video/webm' && /\.webm$/i.test(file.originalname));
    if (!allowed) return callback(new Error('Upload an MP4 or WebM video.'));
    callback(null, true);
  },
});

function handleIntroVideoUpload(req, res, next) {
  introVideoUpload.single('videoFile')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Intro videos must be 15 MB or smaller.'
      : err.message || 'Could not upload this video.';
    res.status(400).json({ message });
  });
}

async function addIntroVideoUrls(tutors) {
  if (!tutors.length) return [];
  const videoRows = await TutorIntroVideo.find({ tutor: { $in: tutors.map((tutor) => tutor._id) } })
    .select('tutor -_id')
    .lean();
  const videoTutorIds = new Set(videoRows.map((video) => String(video.tutor)));
  return tutors.map((tutor) => {
    const result = tutor.toObject();
    if (videoTutorIds.has(String(tutor._id))) {
      result.introVideoUrl = '/api/tutors/' + tutor._id + '/intro-video';
    }
    return result;
  });
}

router.get('/subjects', async (req, res, next) => {
  try {
    const subjects = await Subject.find().select('name -_id').sort({ name: 1 }).lean();
    const names = new Map(DEFAULT_SUBJECTS.map((name) => [name.toLowerCase(), name]));
    subjects.forEach(({ name }) => names.set(name.toLowerCase(), name));
    res.json({
      subjects: Array.from(names.values()),
      customSubjects: subjects.map(({ name }) => name),
    });
  } catch (err) {
    next(err);
  }
});

// Helper: HTML checkboxes with the same `name` submit as a single value when only
// one is checked, and as an array when several are checked. Normalize to an array.
function toArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

// POST /api/tutors/apply — matches becomeatutor.html
// Login is required, and the account must already have the "Tutor" role
// (chosen at signup on create-account.html). Parent and Student accounts
// can't submit a tutor application — becoming a tutor happens by signing up
// as one, not by applying from a Parent/Student account.
router.post('/apply', requireAuth, async (req, res) => {
  if (req.user.role !== 'Tutor') {
    return res.status(403).json({
      message: 'Only tutor accounts can submit a tutor application. Parent and Student accounts can\'t apply — sign up for a new account and choose "Tutor" instead.',
    });
  }
  try {
    const {
      fullname, gender, dob, phone, email,
      education, institution, experience, certificateUrl,
      subject, grade, language, mode,
      city, address, availability, bio,
    } = req.body;

    if (!fullname || !phone || !email || !city || !String(availability || '').trim()) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const profile = await TutorProfile.create({
      user: req.user.id,
      fullname, gender, dob, phone, email,
      education, institution, experience, certificateUrl,
      subjects: toArray(subject),
      grades: toArray(grade),
      languages: toArray(language),
      mode,
      city, address,
      availability, bio,
    });

    notifyAdmin(
      `New tutor application: ${fullname}`,
      `${fullname} (${email}, ${phone}) just applied to become a tutor.\n\n` +
        `Subjects: ${(profile.subjects || []).join(', ') || '-'}\n` +
        `Grades: ${(profile.grades || []).join(', ') || '-'}\n` +
        `City: ${city || '-'}\n\n` +
        `Review and approve it on your admin page.`
    );

    const profileData = profile.toObject();
    res.status(201).json({
      message: 'Application submitted. It will be reviewed before appearing in search.',
      profile: profileData,
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not submit application', error: err.message });
  }
});

// GET /api/tutors/me — the logged-in tutor's own profile (for tutor-dash.html)
// Must come BEFORE /:id or Express will treat "me" as an id.
router.get('/me', requireAuth, async (req, res) => {
  const profile = await TutorProfile.findOne({ user: req.user.id }).sort({ createdAt: -1 });
  if (!profile) {
    return res.status(404).json({ message: 'No tutor application found for this account yet. Submit one via becomeatutor.html.' });
  }
  const result = profile.toObject();
  if (await TutorIntroVideo.exists({ tutor: profile._id })) {
    result.introVideoUrl = '/api/tutors/' + profile._id + '/intro-video';
  }
  res.json(result);
});

// PATCH /api/tutors/me — used by the tutor dashboard profile and availability controls
router.patch('/me', requireAuth, async (req, res) => {
  const profile = await TutorProfile.findOne({ user: req.user.id }).sort({ createdAt: -1 });
  if (!profile) return res.status(404).json({ message: 'No tutor profile found for this account' });

  const editable = [
    'subjects', 'grades', 'languages', 'mode',
    'bio', 'availability', 'availableDays', 'availableTimeSlots',
    'experience', 'education', 'institution', 'city', 'address', 'profilePhotoUrl',
  ];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) profile[field] = req.body[field];
  });
  await profile.save();
  res.json(profile.toObject());
});

router.post('/me/intro-video', requireAuth, handleIntroVideoUpload, async (req, res, next) => {
  try {
    if (req.user.role !== 'Tutor') return res.status(403).json({ message: 'Only tutor accounts can upload an introduction video.' });
    if (!req.file) return res.status(400).json({ message: 'Choose an MP4 or WebM video to upload.' });
    const tutor = await TutorProfile.findOne({ user: req.user.id }).sort({ createdAt: -1 });
    if (!tutor) return res.status(403).json({ message: 'Submit a tutor application before uploading an introduction video.' });
    const extension = req.file.mimetype === 'video/mp4' ? '.mp4' : '.webm';
    const duration = await inspectIntroVideo(req.file.buffer, extension);
    const video = await TutorIntroVideo.findOneAndUpdate(
      { tutor: tutor._id },
      {
        $set: {
          fileData: req.file.buffer,
          contentType: req.file.mimetype,
          fileSize: req.file.size,
          duration,
        },
      },
      { new: true, upsert: true, runValidators: true }
    ).select('-fileData');
    res.status(201).json({
      message: 'Introduction video saved.',
      video: { fileSize: video.fileSize, duration: video.duration, updatedAt: video.updatedAt },
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    next(err);
  }
});

// GET /api/tutors — matches the "Find Your Tutor" search on tutors.html
// Supports query params: ?subject=Mathematics&city=Addis%20Ababa&language=Amharic&grade=Grade%209-10&mode=Online
router.get('/', async (req, res) => {
  try {
    const { subject, city, language, grade, mode } = req.query;
    const filter = { status: 'approved' };

    if (subject) filter.subjects = subject;
    if (language) filter.languages = language;
    if (grade) filter.grades = grade;
    if (mode) filter.mode = mode;
    if (city) filter.city = { $regex: city, $options: 'i' };

    const tutors = await TutorProfile.find(filter).sort({ createdAt: -1 });
    res.json(await addIntroVideoUrls(tutors));
  } catch (err) {
    res.status(500).json({ message: 'Could not fetch tutors', error: err.message });
  }
});

// GET /api/tutors/recommended — top-rated approved tutors (a simple, honest
// "recommendation": highest average rating first, then most ratings, then
// newest — not personalized, just the best-reviewed tutors on the platform).
// Must come BEFORE /:id or Express will treat "recommended" as an id.
router.get('/recommended', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 4, 10);
  const tutors = await TutorProfile.find({ status: 'approved' })
    .sort({ averageRating: -1, ratingCount: -1, createdAt: -1 })
    .limit(limit);
  res.json(await addIntroVideoUrls(tutors));
});

// --- Rating & review routes MUST come BEFORE /:id so Express doesn't
//     treat "rate" or "reviews" as a tutor id. ---

// POST /api/tutors/:id/rate — rate a tutor (or update your existing rating of them)
router.post('/:id/rate', requireAuth, async (req, res) => {
  try {
    const value = Number(req.body.rating);
    if (!value || value < 1 || value > 5) {
      return res.status(400).json({ message: 'Rating must be a number from 1 to 5' });
    }
    const tutor = await TutorProfile.findById(req.params.id);
    if (!tutor) return res.status(404).json({ message: 'Tutor not found' });

    await Rating.findOneAndUpdate(
      { tutor: tutor._id, user: req.user.id },
      { rating: value, comment: req.body.comment },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const stats = await Rating.aggregate([
      { $match: { tutor: tutor._id } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const avg = stats.length ? stats[0].avg : 0;
    const count = stats.length ? stats[0].count : 0;

    tutor.averageRating = Math.round(avg * 10) / 10;
    tutor.ratingCount = count;
    await tutor.save();

    res.json({ averageRating: tutor.averageRating, ratingCount: tutor.ratingCount, yourRating: value });
  } catch (err) {
    res.status(500).json({ message: 'Could not submit rating', error: err.message });
  }
});

// GET /api/tutors/:id/rate — the logged-in user's existing rating for this tutor, if any
router.get('/:id/rate', requireAuth, async (req, res) => {
  const existing = await Rating.findOne({ tutor: req.params.id, user: req.user.id });
  res.json({ yourRating: existing ? existing.rating : null });
});

// GET /api/tutors/:id/reviews — most recent ratings/comments for a tutor, with the
// reviewer's name (public — used on the tutor's own dashboard).
router.get('/:id/reviews', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const reviews = await Rating.find({ tutor: req.params.id })
      .populate('user', 'fullname')
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(reviews.map(function (r) {
      return {
        reviewer: r.user ? r.user.fullname : 'Anonymous',
        rating: r.rating,
        comment: r.comment || '',
        createdAt: r.createdAt,
      };
    }));
  } catch (err) {
    res.status(400).json({ message: 'Invalid tutor id' });
  }
});

router.get('/:id/intro-video', async (req, res, next) => {
  try {
    const tutor = await TutorProfile.findOne({ _id: req.params.id, status: 'approved' }).select('_id');
    if (!tutor) return res.status(404).json({ message: 'Tutor video not found.' });
    const video = await TutorIntroVideo.findOne({ tutor: tutor._id }).select('+fileData');
    if (!video) return res.status(404).json({ message: 'Tutor video not found.' });
    sendIntroVideo(req, res, video);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Tutor video not found.' });
    next(err);
  }
});

// GET /api/tutors/:id — a single tutor's public profile (must come LAST among /:id routes)
router.get('/:id', async (req, res) => {
  try {
    const tutor = await TutorProfile.findById(req.params.id);
    if (!tutor) return res.status(404).json({ message: 'Tutor not found' });
    res.json((await addIntroVideoUrls([tutor]))[0]);
  } catch (err) {
    res.status(400).json({ message: 'Invalid tutor id' });
  }
});

module.exports = router;
