const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    fullname: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    password: { type: String, required: true },
    // Matches the "account" radio in create-account.html (Parent / Student / Tutor)
    role: { type: String, enum: ['Parent', 'Student', 'Tutor'], required: true },
    city: { type: String, trim: true },
    avatar: { type: String, default: 'avatar-sky' },
    // Actual uploaded photo stored as a base64 data URL (falls back to preset SVG avatar when null)
    photoUrl: { type: String, default: null },
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
