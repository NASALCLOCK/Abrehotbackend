const mongoose = require('mongoose');

const pricingRateSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, trim: true },
    price: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PricingRate', pricingRateSchema);
