const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TIME_ZONE = 'Africa/Addis_Ababa';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
let cachedToken;

function getServiceAccount() {
  const configuredPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || 'abrehot-tutoring-d2e834cdc000.json';
  const credentialsPath = path.resolve(__dirname, '..', configuredPath);
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Google Meet credentials file was not found. Set GOOGLE_SERVICE_ACCOUNT_FILE on the backend.');
    }
    throw new Error('Google Meet credentials file could not be read or is not valid JSON.');
  }
  if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) {
    throw new Error('Google Meet credentials must be a service-account JSON file with client_email and private_key.');
  }
  if (!process.env.GOOGLE_CALENDAR_ID) {
    throw new Error('Google Meet is selected, but GOOGLE_CALENDAR_ID is not configured on the backend.');
  }
  return credentials;
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const credentials = getServiceAccount();
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertionHeader = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const assertionClaims = encodeBase64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsignedAssertion = `${assertionHeader}.${assertionClaims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedAssertion), credentials.private_key);
  const assertion = `${unsignedAssertion}.${signature.toString('base64url')}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.error_description || result.error || `Google authentication failed (HTTP ${response.status}).`);
  }
  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000,
  };
  return cachedToken.value;
}

function meetingTimes(booking) {
  const date = booking.dateKey || String(booking.date || '').slice(0, 10);
  const time = String(booking.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('The booking needs a valid date and time before a Google Meet link can be created.');
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59 || new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) {
    throw new Error('The booking needs a valid date and time before a Google Meet link can be created.');
  }
  const localStart = Date.UTC(year, month - 1, day, hour, minute);
  const start = new Date(localStart - 3 * 60 * 60 * 1000);
  const durationMinutes = {
    '1 Hour': 60,
    '1.5 Hours': 90,
    '2 Hours': 120,
    '2 + Hours': 150,
  }[booking.duration] || 60;
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + durationMinutes * 60 * 1000).toISOString(),
  };
}

async function createGoogleMeet(booking) {
  const accessToken = await getAccessToken();
  const times = meetingTimes(booking);
  const subjects = Array.isArray(booking.subject) ? booking.subject.join(', ') : '';
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=none`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: `Abrehot tutoring${subjects ? `: ${subjects}` : ''}`,
        description: `Abrehot tutoring booking ${booking._id || booking.id || ''}`.trim(),
        start: { dateTime: times.start, timeZone: TIME_ZONE },
        end: { dateTime: times.end, timeZone: TIME_ZONE },
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );
  const result = await response.json();
  if (!response.ok) {
    const message = result.error && result.error.message;
    throw new Error(message || `Google Calendar event creation failed (HTTP ${response.status}).`);
  }
  const joinUrl = result.hangoutLink ||
    (result.conferenceData && result.conferenceData.entryPoints || [])
      .find((entry) => entry.entryPointType === 'video' && entry.uri)?.uri;
  if (!result.id || !joinUrl) {
    throw new Error('Google Calendar created an event without a Google Meet link. Check calendar permissions and conference settings.');
  }
  return { id: result.id, joinUrl };
}

function isGoogleMeetBooking(booking) {
  return booking.platform === 'googleMeet' &&
    (booking.session === 'online' || (booking.session === 'group' && booking.groupMode === 'online'));
}

module.exports = { createGoogleMeet, isGoogleMeetBooking };
