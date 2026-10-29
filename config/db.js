const mongoose = require('mongoose');
const dns = require('dns');

// Node.js has its own DNS resolver, separate from the OS's. On some Windows
// setups (certain routers/ISPs) Node's resolver fails to look up the SRV
// record Atlas needs, even though `nslookup` at the OS level works fine.
// Pointing Node explicitly at Google's DNS fixes this in almost all cases.
dns.setServers(['8.8.8.8', '8.8.4.4']);

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected:', mongoose.connection.host);
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
