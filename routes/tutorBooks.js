const router = require('express').Router();
const multer = require('multer');
const TutorBook = require('../models/TutorBook');
const TutorProfile = require('../models/TutorProfile');
const { requireAuth } = require('../middleware/auth');

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 5, fieldSize: 10 * 1024 },
  fileFilter(req, file, callback) {
    if (file.mimetype !== 'application/pdf' || !/\.pdf$/i.test(file.originalname)) {
      return callback(new Error('Upload a PDF file.'));
    }
    callback(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('bookFile')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'PDF files must be 8 MB or smaller.'
      : err.message || 'Could not upload this PDF.';
    res.status(400).json({ message });
  });
}

function fileResponse(res, book, disposition) {
  const filename = 'tutor-book-' + book._id + '.pdf';
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': book.fileData.length,
    'Content-Disposition': disposition + '; filename="' + filename + '"',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.send(book.fileData);
}

function bookMetadata(book) {
  const result = book.toObject();
  delete result.fileData;
  return result;
}

router.get('/', async (req, res, next) => {
  try {
    const books = await TutorBook.find({ status: 'approved' })
      .select('title author description subject grade fileSize tutor createdAt')
      .populate('tutor', 'fullname')
      .sort({ createdAt: -1 })
      .lean();
    res.json(books);
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'Tutor') return res.status(403).json({ message: 'Only tutor accounts can manage uploaded books.' });
    const books = await TutorBook.find({ user: req.user.id })
      .select('-fileData')
      .sort({ createdAt: -1 })
      .lean();
    res.json(books);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, handleUpload, async (req, res, next) => {
  try {
    if (req.user.role !== 'Tutor') return res.status(403).json({ message: 'Only tutor accounts can upload books.' });
    if (!req.file) return res.status(400).json({ message: 'Choose a PDF book to upload.' });
    if (req.file.buffer.subarray(0, 5).toString() !== '%PDF-') {
      return res.status(400).json({ message: 'The uploaded file is not a valid PDF.' });
    }
    const tutor = await TutorProfile.findOne({ user: req.user.id }).sort({ createdAt: -1 });
    if (!tutor) return res.status(403).json({ message: 'Submit a tutor application before uploading books.' });

    const title = String(req.body.title || '').trim();
    if (!title || title.length > 160) return res.status(400).json({ message: 'Book title is required and must be 160 characters or fewer.' });
    const book = await TutorBook.create({
      tutor: tutor._id,
      user: req.user.id,
      title,
      author: String(req.body.author || '').trim().slice(0, 160),
      description: String(req.body.description || '').trim().slice(0, 1500),
      subject: String(req.body.subject || '').trim().slice(0, 120),
      grade: String(req.body.grade || '').trim().slice(0, 80),
      fileName: req.file.originalname.slice(0, 255),
      fileData: req.file.buffer,
      fileSize: req.file.size,
    });
    res.status(201).json({ message: 'Book submitted for admin review.', book: bookMetadata(book) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/file', async (req, res, next) => {
  try {
    const book = await TutorBook.findOne({ _id: req.params.id, status: 'approved' }).select('+fileData');
    if (!book) return res.status(404).json({ message: 'Approved book not found.' });
    fileResponse(res, book, 'attachment');
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Approved book not found.' });
    next(err);
  }
});

module.exports = router;
