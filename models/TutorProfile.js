const mongoose = require('mongoose');

// Matches every field in becomeatutor.html
const tutorProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // set once they also have a login account (optional)
    fullname: { type: String, required: true, trim: true },
    gender: { type: String, enum: ['Male', 'Female'] },
    dob: { type: Date },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },

    education: String, // e.g. "BSc in Mathematics"
    institution: String, // e.g. "Addis Ababa University"
    experience: {
      type: String,
      enum: ['Less than 1 Year', '1-2 Years', '3-5 Years', 'More than 5 Years'],
    },
    certificateUrl: String, // path/URL to the uploaded certificate file, if any

    subjects: [String], // Mathematics, English, Physics, Chemistry, Biology, ICT, History, Geography
    grades: [String], // KG, Grade 1-6, Grade 7-8, Grade 9-10, Grade 11-12
    languages: [String], // English, Amharic, Afaan Oromo, Tigrinya
    mode: { type: String, enum: ['Online', 'In-Person', 'Both'] },

    city: { type: String, required: true, trim: true },
    address: String,
    // Actual uploaded profile photo stored as a base64 data URL (for tutor cards)
    profilePhotoUrl: { type: String, default: null },
    availability: String, // free-text, e.g. "Monday-Friday, 4-8 PM"
    availableDays: [String], // e.g. ['Monday', 'Wednesday', 'Friday']
    availableTimeSlots: [
      {
        day: { type: String, enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] },
        startTime: String, // "16:00"
        endTime: String, // "18:00"
      },
    ],
    bio: String,

    // Every application starts pending so you (the admin) can review before it appears in search
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

    // Denormalized rating summary, kept in sync by routes/tutors.js whenever a
    // rating is submitted — avoids recalculating an average on every page load.
    averageRating: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TutorProfile', tutorProfileSchema);
