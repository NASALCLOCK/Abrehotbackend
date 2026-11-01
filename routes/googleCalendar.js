const router = require('express').Router();
const { requireAdmin } = require('../middleware/adminAuth');
const { createAuthorizationUrl, exchangeAuthorizationCode } = require('../utils/googleMeet');

router.post('/connect-url', requireAdmin, (req, res, next) => {
  try {
    res.json({ authorizationUrl: createAuthorizationUrl() });
  } catch (error) {
    next(error);
  }
});

router.get('/oauth-callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(
      '<!doctype html><html><meta charset="utf-8"><title>Google Calendar connection</title>' +
      '<p>Google Calendar authorization was not completed. Close this tab and try again.</p></html>'
    );
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).send(
      '<!doctype html><html><meta charset="utf-8"><title>Google Calendar connection</title>' +
      '<p>Google did not return a valid authorization. Close this tab and try again.</p></html>'
    );
  }
  try {
    await exchangeAuthorizationCode(code, state);
    res.send(
      '<!doctype html><html><meta charset="utf-8"><title>Google Calendar connected</title>' +
      '<p>Google Calendar connected successfully. Return to the Abrehot admin page and retry the meeting link.</p></html>'
    );
  } catch (requestError) {
    console.error('[google-calendar] OAuth callback failed:', requestError.message);
    res.status(400).send(
      '<!doctype html><html><meta charset="utf-8"><title>Google Calendar connection</title>' +
      '<p>Google Calendar could not be connected: ' +
      requestError.message.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]) +
      '</p></html>'
    );
  }
});

module.exports = router;
