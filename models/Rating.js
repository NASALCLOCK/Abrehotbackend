const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema(
  {
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true },
  },
  { timestamps: true }
);

// One rating per person per tutor — submitting again updates their existing rating.
ratingSchema.index({ tutor: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('Rating', ratingSchema);
