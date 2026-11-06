const Booking = require('../models/Booking');
const { sendToUser } = require('./mailer');

const REMINDER_LEAD_MS = 15 * 60 * 1000;
let reminderRunInProgress = false;

function dateKeyInAddisAbaba(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function reminderDateKeys(now) {
  const today = dateKeyInAddisAbaba(now);
  const tomorrowDate = new Date(`${today}T00:00:00.000Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  return [today, tomorrowDate.toISOString().slice(0, 10)];
}

function getMeetingStart(booking) {
  const dateKey = booking.dateKey ||
    (booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : '');
  const time = String(booking.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const calendarDate = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== dateKey) return null;
  const start = new Date(`${dateKey}T${time}:00+03:00`);
  return Number.isNaN(start.getTime()) ? null : start;
}

async function sendUpcomingTutorReminders(now = new Date()) {
  if (reminderRunInProgress) return;
  reminderRunInProgress = true;
  try {
    const [today, tomorrow] = reminderDateKeys(now);
    const bookings = await Booking.find({
      status: 'confirmed',
      dateKey: { $gte: today, $lte: tomorrow },
      $or: [
        { tutorReminderEmailSentAt: { $exists: false } },
        { tutorReminderEmailSentAt: null },
      ],
    })
      .populate('tutor', 'fullname email')
      .populate('requestedBy', 'fullname')
      .lean();

    for (const booking of bookings) {
      const start = getMeetingStart(booking);
      if (!start || start.getTime() <= now.getTime() || start.getTime() - now.getTime() > REMINDER_LEAD_MS) continue;
      if (!booking.tutor || !booking.tutor.email) {
        console.warn(`[reminder] Booking ${booking._id} has no assigned tutor email.`);
        continue;
      }

      const meetingUrl = booking.googleMeetJoinUrl || booking.zoomJoinUrl;
      const meetingName = booking.googleMeetJoinUrl ? 'Google Meet' : 'Zoom';
      const result = await sendToUser(
        booking.tutor.email,
        'Tutoring session starts in 15 minutes — Abrehot Online Tutorials',
        'Hi ' + (booking.tutor.fullname || 'there') + ',\n\n' +
          'Your tutoring session is scheduled to start in about 15 minutes.\n\n' +
          'Student: ' + ((booking.requestedBy && booking.requestedBy.fullname) || 'your student') + '\n' +
          'Subject(s): ' + ((booking.subject || []).join(', ') || '-') + '\n' +
          'Date and time: ' + (booking.dateKey || '') + ' ' + (booking.time || '') + ' (Africa/Addis_Ababa)\n' +
          (meetingUrl ? 'Join the ' + meetingName + ' session: ' + meetingUrl + '\n' : '') +
          '\n— Abrehot Online Tutorials'
      );
      if (result.sent) {
        await Booking.updateOne(
          {
            _id: booking._id,
            $or: [
              { tutorReminderEmailSentAt: { $exists: false } },
              { tutorReminderEmailSentAt: null },
            ],
          },
          { $set: { tutorReminderEmailSentAt: new Date() } }
        );
      }
    }
  } finally {
    reminderRunInProgress = false;
  }
}

module.exports = { sendUpcomingTutorReminders };
