const ZOOM_API = 'https://api.zoom.us/v2';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const ADDIS_ABABA = 'Africa/Addis_Ababa';
let cachedToken;

function getCredentials() {
  const credentials = {
    accountId: process.env.ZOOM_ACCOUNT_ID,
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET,
  };
  if (Object.values(credentials).some((value) => !value)) {
    throw new Error('Zoom is selected for this booking, but Zoom OAuth credentials are not configured on the backend.');
  }
  return credentials;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const { accountId, clientId, clientSecret } = getCredentials();
  const response = await fetch(
    `${ZOOM_TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
      signal: AbortSignal.timeout(15000),
    }
  );
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.reason || result.message || `Zoom authentication failed (HTTP ${response.status}).`);
  }

  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(0, Number(result.expires_in || 0) - 60) * 1000,
  };
  return cachedToken.value;
}

function meetingStart(booking) {
  const date = booking.dateKey || (booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : '');
  const time = String(booking.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('The booking needs a valid date and time before a Zoom meeting can be created.');
  }
  return `${date}T${time}:00`;
}

function meetingDuration(booking) {
  const durations = { '1 Hour': 60, '1.5 Hours': 90, '2 Hours': 120, '2 + Hours': 120 };
  return durations[booking.duration] || 60;
}

async function createZoomMeeting(booking) {
  const accessToken = await getAccessToken();
  const subjects = Array.isArray(booking.subject) ? booking.subject.join(', ') : '';
  const response = await fetch(`${ZOOM_API}/users/me/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topic: `Abrehot tutoring${subjects ? `: ${subjects}` : ''}`,
      type: 2,
      start_time: meetingStart(booking),
      duration: meetingDuration(booking),
      timezone: ADDIS_ABABA,
      settings: {
        join_before_host: false,
        waiting_room: true,
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.id || !result.join_url) {
    throw new Error(result.message || `Zoom meeting creation failed (HTTP ${response.status}).`);
  }

  return { id: String(result.id), joinUrl: result.join_url };
}

function isZoomBooking(booking) {
  return booking.platform === 'zoom' &&
    (booking.session === 'online' || (booking.session === 'group' && booking.groupMode === 'online'));
}

module.exports = { createZoomMeeting, isZoomBooking };
