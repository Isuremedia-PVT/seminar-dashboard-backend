const axios = require('axios');

/**
 * Fires a lightweight alert (e.g. to a Slack incoming webhook) so operational problems
 * are loud instead of silent: unmapped pipeline_id, Meta token refresh failure, etc.
 * If ALERT_WEBHOOK_URL isn't configured, this just logs — it should never throw and
 * break the calling code path.
 */
async function sendAlert(message, context = {}) {
  console.warn('[ALERT]', message, context);

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  try {
    await axios.post(url, {
      text: `⚠️ Seminar Dashboard Alert: ${message}\n\`\`\`${JSON.stringify(context, null, 2)}\`\`\``,
    });
  } catch (err) {
    console.error('Failed to send alert (non-fatal):', err.message);
  }
}

module.exports = { sendAlert };
