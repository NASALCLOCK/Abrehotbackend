const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_MEET_API = 'https://meet.googleapis.com/v2';
const TIME_ZONE = 'Africa/Addis_Ababa';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/meetings.space.created',
];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();
let cachedToken;

function getOAuthConfig() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI } = process.env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REDIRECT_URI) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI on the backend.');
  }
  if (!process.env.GOOGLE_CALENDAR_ID) {
    throw new Error('GOOGLE_CALENDAR_ID is not configured on the backend.');
  }
  return { clientId: GOOGLE_OAUTH_CLIENT_ID, clientSecret: GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: GOOGLE_OAUTH_REDIRECT_URI };
}

function getTokenFilePath() {
  const configuredPath = process.env.GOOGLE_OAUTH_TOKEN_FILE || '.google-calendar-oauth-token.json';
  return path.resolve(__dirname, '..', configuredPath);
}

function getStoredRefreshToken() {
  const tokenPath = getTokenFilePath();
  let tokenData;
  try {
    tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Google Calendar is not connected. Use Connect Google Calendar in the admin Payments page.');
    }
    throw new Error('The saved Google Calendar authorization could not be read. Reconnect Google Calendar.');
  }
  if (!tokenData.refresh_token) {
    throw new Error('The saved Google Calendar authorization is incomplete. Reconnect Google Calendar.');
  }
  return tokenData.refresh_token;
}

function saveRefreshToken(refreshToken) {
  const tokenPath = getTokenFilePath();
  const tempPath = `${tokenPath}.${crypto.randomUUID()}.tmp`;
  const data = JSON.stringify({ refresh_token: refreshToken });
  try {
    fs.writeFileSync(tempPath, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, tokenPath);
    fs.chmodSync(tokenPath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

function createAuthorizationUrl() {
  const config = getOAuthConfig();
  const state = crypto.randomBytes(32).toString('base64url');
  pendingStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

async function exchangeAuthorizationCode(code, state) {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expiresAt || expiresAt < Date.now()) {
    throw new Error('Google authorization expired or was not started by this server. Start the connection again.');
  }
  const config = getOAuthConfig();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.error_description || result.error || `Google authentication failed (HTTP ${response.status}).`);
  }
  if (!result.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove this app from your Google Account permissions and connect again.');
  }
  saveRefreshToken(result.refresh_token);
  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000,
  };
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const config = getOAuthConfig();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: getStoredRefreshToken(),
      grant_type: 'refresh_token',
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
  const spaceResponse = await fetch(`${GOOGLE_MEET_API}/spaces`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ config: { accessType: 'OPEN' } }),
    signal: AbortSignal.timeout(20000),
  });
  const space = await spaceResponse.json();
  if (!spaceResponse.ok) {
    const message = space.error && space.error.message;
    throw new Error(message || `Google Meet space creation failed (HTTP ${spaceResponse.status}).`);
  }
  if (!space.name || !space.meetingUri) {
    throw new Error('Google Meet created a space without a meeting URL.');
  }
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${calendarId}/events?sendUpdates=none`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: `Abrehot tutoring${subjects ? `: ${subjects}` : ''}`,
        description: `Abrehot tutoring booking ${booking._id || booking.id || ''}\nJoin the open Google Meet: ${space.meetingUri}`.trim(),
        location: space.meetingUri,
        start: { dateTime: times.start, timeZone: TIME_ZONE },
        end: { dateTime: times.end, timeZone: TIME_ZONE },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );
  const result = await response.json();
  if (!response.ok) {
    const message = result.error && result.error.message;
    throw new Error(message || `Google Calendar event creation failed (HTTP ${response.status}).`);
  }
  if (!result.id) throw new Error('Google Calendar created an event without an event ID.');
  return { id: result.id, joinUrl: space.meetingUri };
}

function isGoogleMeetBooking(booking) {
  return booking.platform === 'googleMeet' &&
    (booking.session === 'online' || (booking.session === 'group' && booking.groupMode === 'online'));
}

module.exports = { createGoogleMeet, isGoogleMeetBooking, createAuthorizationUrl, exchangeAuthorizationCode };
