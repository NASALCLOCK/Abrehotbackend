require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

// --- Middleware ---
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// First-party HTTPS subdomains of the production site (www, api, and the
// admin panel on admin.abrehottutoring.com.et) are always allowed — they are
// all served by us, so they don't need to be listed in CLIENT_ORIGIN.
const SITE_DOMAIN = 'abrehottutoring.com.et';

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (curl, Postman) AND the literal string
      // "null", which is what browsers send as Origin when a page is opened
      // via file:// (e.g. double-clicking admin.html instead of using a
      // local dev server).
      if (!origin || origin === 'null' || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      try {
        const { protocol, hostname } = new URL(origin);
        if (
          protocol === 'https:' &&
          (hostname === SITE_DOMAIN || hostname === 'www.' + SITE_DOMAIN || hostname.endsWith('.' + SITE_DOMAIN))
        ) {
          return callback(null, true);
        }
      } catch (e) {
        /* not a parseable URL — fall through to rejection */
      }
      callback(new Error('Not allowed by CORS: ' + origin));
    },
  })
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // supports plain HTML form posts too

// --- Payment verification guards (must come before the routes they protect) ---
const { validatePaymentOnCreate, requireApprovedPayment } = require('./middleware/paymentGuards');
app.post('/api/bookings', validatePaymentOnCreate); // validates + saves the payment screenshot data
app.use('/api/messages/booking/:bookingId', requireApprovedPayment); // chat locked until payment approved
app.use('/api/admin/payments', require('./routes/payments')); // admin review; mounted before /api/admin

// --- Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/tutors', require('./routes/tutors'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/children', require('./routes/children'));
app.use('/api/book-ads', require('./routes/bookads'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Error fallback ---
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message || 'Server error' });
});

// --- Start ---
const PORT = process.env.PORT || 5000;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Abrehot backend running on http://localhost:${PORT}`));
});
