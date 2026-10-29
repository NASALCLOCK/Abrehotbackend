const mongoose = require('mongoose');

// Matches contact.html: message + satisfaction rating + optional feedback
const contactMessageSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    subject: {
      type: String,
      enum: ['General Inquiry', 'Booking Assistance', 'Tutor Application', 'Technical Issue', 'Complaint', 'Other'],
    },
    message: { type: String, required: true },
    rating: { type: String, enum: ['Excellent', 'Good', 'Average', 'Poor'] },
    feedback: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
