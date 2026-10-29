const router = require('express').Router();
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const BookingMessage = require('../models/BookingMessage');
const TutorProfile = require('../models/TutorProfile');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../utils/notifications');

async function getBookingParticipant(booking, userId) {
  const isRequester = booking.requestedBy && booking.requestedBy.toString() === userId;
  if (isRequester) return { isRequester: true, isTutor: false };

  if (booking.tutor) {
    const tutor = await TutorProfile.findOne({ _id: booking.tutor, user: userId });
    if (tutor) return { isRequester: false, isTutor: true };
  }

  return null;
}

async function loadChatBooking(id, userId) {
  const booking = await Booking.findById(id);
  if (!booking) return { error: { status: 404, message: 'Booking not found' } };
  if (booking.status === 'cancelled') {
    return { error: { status: 400, message: 'Chat is unavailable for cancelled bookings' } };
  }

  const participant = await getBookingParticipant(booking, userId);
  if (!participant) return { error: { status: 403, message: 'You are not a participant in this booking' } };
  return { booking, participant };
}

// GET /api/messages/booking/:bookingId
router.get('/booking/:bookingId', requireAuth, async (req, res) => {
  try {
    const result = await loadChatBooking(req.params.bookingId, req.user.id);
    if (result.error) return res.status(result.error.status).json({ message: result.error.message });

    const messages = await BookingMessage.find({ booking: result.booking._id })
      .populate('sender', 'fullname role')
      .populate('replyTo', 'body imageUrl sender')
      .sort({ createdAt: 1 })
      .limit(200);

    res.json({
      booking: {
        id: result.booking._id,
        subject: result.booking.subject || [],
        date: result.booking.date,
        time: result.booking.time,
        status: result.booking.status,
      },
      messages,
    });
  } catch (err) {
    res.status(500).json({ message: 'Could not load chat', error: err.message });
  }
});

// POST /api/messages/booking/:bookingId
router.post('/booking/:bookingId', requireAuth, async (req, res) => {
  try {
    const result = await loadChatBooking(req.params.bookingId, req.user.id);
    if (result.error) return res.status(result.error.status).json({ message: result.error.message });

    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl : '';
    const replyTo = req.body.replyTo;
    if (!body && !imageUrl) return res.status(400).json({ message: 'Message cannot be empty' });
    if (body.length > 2000) return res.status(400).json({ message: 'Message must be 2000 characters or fewer' });
    if (imageUrl && !/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(imageUrl)) {
      return res.status(400).json({ message: 'Only valid image uploads are allowed' });
    }
    if (imageUrl.length > 3000000) return res.status(400).json({ message: 'Images must be 2 MB or smaller' });

    let replyMessage;
    if (replyTo) {
      if (!mongoose.Types.ObjectId.isValid(replyTo)) {
        return res.status(400).json({ message: 'Invalid reply message' });
      }
      replyMessage = await BookingMessage.findOne({ _id: replyTo, booking: result.booking._id });
      if (!replyMessage) return res.status(400).json({ message: 'The message being replied to was not found' });
    }

    const message = await BookingMessage.create({
      booking: result.booking._id,
      sender: req.user.id,
      body,
      imageUrl: imageUrl || undefined,
      replyTo: replyMessage ? replyMessage._id : undefined,
    });
    await message.populate('sender', 'fullname role');
    await message.populate('replyTo', 'body imageUrl sender');

    if (result.participant.isRequester && result.booking.tutor) {
      const tutor = await TutorProfile.findById(result.booking.tutor).select('user');
      if (tutor && tutor.user) {
        notify(tutor.user, 'You have a new message about a tutoring booking.', '../chat.html?bookingId=' + result.booking._id);
      }
    } else if (result.participant.isTutor && result.booking.requestedBy) {
      notify(result.booking.requestedBy, 'You have a new message from your tutor.', '../chat.html?bookingId=' + result.booking._id);
    }

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ message: 'Could not send message', error: err.message });
  }
});

// PATCH /api/messages/:messageId/like — toggle a participant's like
router.patch('/:messageId/like', requireAuth, async (req, res) => {
  try {
    const message = await BookingMessage.findById(req.params.messageId);
    if (!message) return res.status(404).json({ message: 'Message not found' });
    const result = await loadChatBooking(message.booking, req.user.id);
    if (result.error) return res.status(result.error.status).json({ message: result.error.message });

    const userId = req.user.id.toString();
    const index = message.likes.findIndex((id) => id.toString() === userId);
    if (index === -1) message.likes.push(req.user.id);
    else message.likes.splice(index, 1);
    await message.save();
    res.json({ liked: index === -1, likes: message.likes.length });
  } catch (err) {
    res.status(500).json({ message: 'Could not update like', error: err.message });
  }
});

module.exports = router;
