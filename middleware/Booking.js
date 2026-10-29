const mongoose = require('mongoose');

// Matches every field in book.html
const bookingSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional, if logged in
    tutor: { type: mongoose.Schema.Types.ObjectId, ref: 'TutorProfile' }, // optional, if booking a specific tutor
    child: { type: mongoose.Schema.Types.ObjectId, ref: 'Child' }, // who the session is actually for, when requestedBy is a Parent

    grade: { type: String, required: true }, // Kindergarten (KG) ... Grade 12
    subject: [String], // mathematics, english, physics, chemistry, biology, iCT, history, geography, other
    otherSubject: String, // free-text "other" subject
    topic: String, // e.g. "Algebra"
    goal: [String], // homework, exam, assignment, revision, weeklytutoring

    // Group sessions are their own session type — the tutor's rate is split
    // equally between the students attending, so each student pays less than
    // they would for a private (in-person or online) session.
    session: { type: String, enum: ['online', 'in-person', 'group'] },
    // Only for group sessions: how the group actually meets the tutor.
    // A group can meet online (picking a platform) or in-person (picking a location).
    groupMode: { type: String, enum: ['online', 'in-person'] },
    // Only for group sessions: how many students are splitting the rate.
    groupSize: { type: Number, min: 2, max: 30 },
    packageId: { type: String },
    packageClassSize: { type: String },

    // --- Payment verification -------------------------------------------
    // Paid packages start as 'pending' until an admin approves the screenshot.
    // Chat with the tutor is locked until paymentStatus === 'approved'.
    // Bookings created before this feature have NO paymentStatus field and are
    // treated as approved (run scripts/migrate-payments.js to set it explicitly).
    paymentMethod: { type: String, enum: ['CBE', 'Telebirr'] },
    transactionId: { type: String, trim: true },
    // base64 data URL. select:false keeps it out of every normal query so list
    // endpoints stay small; only the admin route asks for it with +paymentScreenshot.
    paymentScreenshot: { type: String, select: false },
    paymentStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    paymentNote: { type: String, trim: true }, // admin's reason when rejected
    paymentReviewedAt: { type: Date },
    studentFee: { type: String },
    teacherPayment: { type: Number },
    packageFee: { type: String },
    platform: { type: String, enum: ['googleMeet', 'zoom', 'telegram'] },

    // Plan type: 'hourly' session vs 'monthly' recurring plan
    planType: { type: String, enum: ['hourly', 'monthly'], default: 'hourly' },
    selectedDays: [String], // for monthly plan: e.g. ['Monday', 'Wednesday', 'Friday']
    selectedTimeSlots: [
      {
        day: String,
        startTime: String,
        endTime: String,
      },
    ],

    // Pricing snapshot, captured from the tutor's rate at booking time so later
    // rate changes on the tutor's profile never rewrite past bookings.

    city: String,
    address: String,
    language: { type: String, enum: ['English', 'Amharic', 'Afaan Oromo', 'Tigrinya'] },

    date: Date,
    // Calendar date key used to prevent two active bookings for one tutor on one day.
    dateKey: String,
    time: String, // stored as "HH:MM" from the <input type="time">
    duration: { type: String, enum: ['1 Hour', '1.5 Hours', '2 Hours', '2 + Hours'] },
    notes: String,

    // Sessions are automatically confirmed after the timetable schedule check
    status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'completed'], default: 'confirmed' },
    // Set only once a session is marked completed by the tutor: true = the
    // student showed up, false = no-show. Null for everything else, which is
    // what lets attendance % only count sessions that actually happened.
    attended: { type: Boolean, default: null },
  },
  { timestamps: true }
);

bookingSchema.index(
  { tutor: 1, dateKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      tutor: { $exists: true },
      dateKey: { $exists: true },
      status: { $in: ['pending', 'confirmed'] },
    },
  }
);

module.exports = mongoose.model('Booking', bookingSchema);
