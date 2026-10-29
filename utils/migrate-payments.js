// Run ONCE from the backend folder:  node scripts/migrate-payments.js
// Marks every booking created before payment verification existed as approved,
// so their chats stay open and they never show up in the admin "pending" list.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const r = await mongoose.connection
    .collection('bookings')
    .updateMany({ paymentStatus: { $exists: false } }, { $set: { paymentStatus: 'approved' } });
  console.log('Bookings updated:', r.modifiedCount);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
