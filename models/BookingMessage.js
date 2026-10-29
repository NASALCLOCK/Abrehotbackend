const mongoose = require('mongoose');

const bookingMessageSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, trim: true, maxlength: 2000, default: '' },
    imageUrl: { type: String, maxlength: 3000000 },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingMessage' },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

bookingMessageSchema.index({ booking: 1, createdAt: 1 });

module.exports = mongoose.model('BookingMessage', bookingMessageSchema);
