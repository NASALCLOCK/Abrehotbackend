const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const User = require('../models/User');
const TutorProfile = require('../models/TutorProfile');

// Profile photos live on disk under backend/uploads/avatars and are served
// from /uploads/avatars (see server.js). The 2 MB limit matches the
// client-side check in frontend/js/api.js handlePhotoUpload().
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'avatars');

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
      const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
      cb(null, req.user.id + '-' + Date.now() + ext);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

const PRESET_AVATARS = new Set([
  'avatar-sky',
  'avatar-rose',
  'avatar-sage',
  'avatar-gold',
  'avatar-violet',
  'avatar-teal',
]);

function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, fullname: user.fullname },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(user) {
  return {
    id: user._id,
    fullname: user.fullname,
    email: user.email,
    phone: user.phone,
    role: user.role,
    city: user.city,
    avatar: user.avatar || 'avatar-sky',
    photoUrl: user.photoUrl || null,
  };
}

function isValidAvatar(value) {
  return value === '' || value === null || (typeof value === 'string' && PRESET_AVATARS.has(value));
}

// POST /api/auth/register  — matches create-account.html
router.post('/register', async (req, res) => {
  try {
    const { fullname, phone, email, password, confirmPassword, account, city } = req.body;

    if (!fullname || !email || !password || !account) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    // "Tutor" is a self-selectable signup role, same as Parent/Student — picking
    // it grants tutor-dashboard access immediately. Admin review (see
    // routes/admin.js and routes/tutors.js) doesn't gate the role itself; it
    // only decides whether the tutor's profile shows up in the public search
    // on tutors.html (see the "status" field on TutorProfile).
    if (account !== 'Parent' && account !== 'Student' && account !== 'Tutor') {
      return res.status(400).json({
        message: 'Please select Parent, Student, or Tutor.',
      });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'An account with that email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      fullname,
      phone,
      email,
      password: hashed,
      role: account, // "Parent" | "Student" | "Tutor"
      city,
    });

    const token = signToken(user);
    res.status(201).json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    res.status(500).json({ message: 'Registration failed', error: err.message });
  }
});

// POST /api/auth/login — matches login.html (name, role, email, password)
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(400).json({ message: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Invalid email or password' });

    // Optional: catch a mismatched role selection at login
    if (role && role !== user.role) {
      return res.status(400).json({
        message: `This account is registered as ${user.role}, not ${role}. Select the correct role and try again.`,
      });
    }

    const token = signToken(user);
    res.json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    res.status(500).json({ message: 'Login failed', error: err.message });
  }
});

// GET /api/auth/me — return the logged-in user (used to autofill pages like contact.html)
const { requireAuth } = require('../middleware/auth');
router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

// PATCH /api/auth/me — used by the "Edit Profile" buttons on dashboards
router.patch('/me', requireAuth, async (req, res) => {
  if (req.body.avatar !== undefined && !isValidAvatar(req.body.avatar)) {
    return res.status(400).json({ message: 'Please choose one of the preset avatars.' });
  }

  const editable = ['fullname', 'phone', 'city', 'avatar', 'photoUrl'];
  const updates = {};
  editable.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });
  const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

// POST /api/auth/favorites/:tutorId/toggle — used by the heart icon on tutor cards
router.post('/favorites/:tutorId/toggle', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const tutorId = req.params.tutorId;
  const idx = user.favorites.findIndex((f) => f.toString() === tutorId);
  let isFavorite;
  if (idx === -1) {
    user.favorites.push(tutorId);
    isFavorite = true;
  } else {
    user.favorites.splice(idx, 1);
    isFavorite = false;
  }
  await user.save();
  res.json({ isFavorite, favorites: user.favorites });
});

// GET /api/auth/favorites — the logged-in user's favorited tutors (for dashboards)
router.get('/favorites', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).populate('favorites');
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user.favorites);
});

module.exports = router;
