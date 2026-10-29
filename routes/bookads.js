const router = require('express').Router();
const BookAd = require('../models/BookAd');

// GET /api/book-ads — public. Only active ads, newest first.
// Used by home.html to display the admin's book advertisements.
router.get('/', async (req, res) => {
  const ads = await BookAd.find({ active: true }).sort({ createdAt: -1 });
  res.json(ads);
});

module.exports = router;
