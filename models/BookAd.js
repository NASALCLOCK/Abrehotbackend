const mongoose = require('mongoose');

const bookAdSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    author: { type: String, trim: true },
    description: { type: String, trim: true },
    price: { type: Number, required: true },
    imageUrl: { type: String, trim: true }, // link to a cover image — can be a full URL or a path under /images
    buyLink: { type: String, trim: true }, // where "Buy Now" sends people (Telegram, phone, external store, etc.)
    active: { type: Boolean, default: true }, // inactive ads are hidden from the public site but kept in admin
  },
  { timestamps: true }
);

module.exports = mongoose.model('BookAd', bookAdSchema);
