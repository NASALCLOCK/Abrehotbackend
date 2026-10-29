const mongoose = require('mongoose');

const tutorBookSchema = new mongoose.Schema(
  {
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    author: { type: String, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 1500 },
    subject: { type: String, trim: true, maxlength: 120 },
    grade: { type: String, trim: true, maxlength: 80 },
    fileName: { type: String, required: true, maxlength: 255 },
    fileData: { type: Buffer, required: true, select: false },
    fileSize: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TutorBook', tutorBookSchema);
