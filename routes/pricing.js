const router = require('express').Router();
const PricingRate = require('../models/PricingRate');
const { DEFAULT_PRICES } = require('../utils/pricing');

router.get('/', async (req, res, next) => {
  try {
    const rates = await PricingRate.find().select('planId price -_id').lean();
    const prices = Object.assign(
      {},
      DEFAULT_PRICES,
      Object.fromEntries(rates.map((rate) => [rate.planId, rate.price]))
    );
    res.json({ prices });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
