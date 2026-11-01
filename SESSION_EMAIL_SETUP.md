# Paid online-session email setup

When an admin approves a paid online booking, the backend creates the selected
Zoom or Google Meet session and emails its join link to the customer's account
email or guest booking email. The email includes the session date, Addis Ababa
time, and duration.

## Backend environment

Set these in the backend deployment environment (Render's service environment
settings in production), not in frontend code:

- `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`: credentials for a
  Zoom Server-to-Server OAuth app authorized to create meetings.
- Google Meet bookings require enabled Google Calendar and Google Meet APIs, a
  Google OAuth web client, and `GOOGLE_CALENDAR_ID`. Configure
  `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and
  `GOOGLE_OAUTH_REDIRECT_URI`, then connect the calendar owner from the admin
  Payments page using **Connect Google Calendar**. The resulting refresh token
  is stored in the ignored `.google-calendar-oauth-token.json` file in the
  backend folder with owner-only file permissions.
- Email delivery: configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  and `MAIL_FROM`, or use `GMAIL_USER` and `GMAIL_APP_PASSWORD` as the fallback.
- `SITE_URL`: public website origin used to build links in confirmation emails.

For local development, use `.env.example` as a template and keep real values in
the ignored `.env` file. Never put credentials in frontend code or commit them.

For local OAuth setup, create a Google OAuth client of type **Web application**
and add `http://localhost:5000/api/google-calendar/oauth-callback` as an
authorized redirect URI. Enable both the Google Calendar API and Google Meet
REST API in the same Google Cloud project. Configure the OAuth consent screen
as **External** and add the calendar owner's Google account as a test user.
Keep the client secret in the backend `.env`. Open the admin Payments page locally, click
**Connect Google Calendar**, and sign in as the account that owns the calendar.
The OAuth consent requests permission to create Meet spaces and set their
access to **Open**, so anyone with the link can join without knocking where
Google account or organization policies permit it. Reconnect to grant the Meet
scope; if Google doesn't show the updated permissions, remove the app's
existing access from the Google Account security settings and connect again.
For deployment, add the deployed callback URL as an authorized redirect URI,
set the matching environment variable on the backend, and connect the owner
account again on the deployed admin page.

## Delivery failures and retries

Payment approval remains successful even if Zoom or email delivery is
temporarily unavailable. The API response reports `zoomDelivery` and
`emailDelivery`. It does not send the confirmation email until the required
meeting link exists. In the admin panel's **Approved** payments list, use
**Retry meeting/email** after fixing the configuration or service issue. A
successful email is recorded on the booking to avoid duplicate confirmations.
