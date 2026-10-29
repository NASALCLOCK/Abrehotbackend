const router = require('express').Router();
const ContactMessage = require('../models/ContactMessage');
const { attachUserIfPresent } = require('../middleware/auth');
const User = require('../models/User');
const { notifyAdmin } = require('../utils/mailer');

// POST /api/contact — matches contact.html
router.post('/', attachUserIfPresent, async (req, res) => {
  try {
    const { subject, message, rating, feedback } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    let name, email;
    if (req.user) {
      const user = await User.findById(req.user.id);
      if (user) {
        name = user.fullname;
        email = user.email;
      }
    }

    const entry = await ContactMessage.create({ name, email, subject, message, rating, feedback });

    notifyAdmin(
      `New contact message: ${subject || 'General Inquiry'}`,
      `From: ${name || 'Guest'} (${email || 'no email given'})\n\n${message}` +
        (rating ? `\n\nSatisfaction rating: ${rating}` : '') +
        (feedback ? `\nFeedback: ${feedback}` : '') +
        `\n\nView it on your admin page.`
    );

    res.status(201).json({ message: 'Thanks — we received your message.', entry });
  } catch (err) {
    res.status(500).json({ message: 'Could not send message', error: err.message });
  }
});

module.exports = router;
