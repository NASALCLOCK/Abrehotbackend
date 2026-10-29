const mongoose = require('mongoose');

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    normalizedName: { type: String, required: true, unique: true, maxlength: 120 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Subject', subjectSchema);
