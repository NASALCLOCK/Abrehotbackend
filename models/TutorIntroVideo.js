const mongoose = require('mongoose');

const tutorIntroVideoSchema = new mongoose.Schema(
  {
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile', required: true, unique: true },
    fileData: { type: Buffer, required: true, select: false },
    contentType: { type: String, enum: ['video/mp4', 'video/webm'], required: true },
    fileSize: { type: Number, required: true },
    duration: { type: Number, required: true, max: 30 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TutorIntroVideo', tutorIntroVideoSchema);
