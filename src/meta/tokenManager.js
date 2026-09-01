const axios = require('axios');
const { MetaToken } = require('../db/pool');
const { sendAlert } = require('../alerts');

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

async function bootstrapLongLivedToken() {
  const shortLivedToken = process.env.META_INITIAL_ACCESS_TOKEN;
  if (!shortLivedToken) throw new Error('META_INITIAL_ACCESS_TOKEN not set in .env');

  const { data } = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    },
  });

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await MetaToken.findOneAndUpdate(
    { _id: 1 },
    { access_token: data.access_token, expires_at: expiresAt, last_refreshed_at: new Date() },
    { upsert: true }
  );

  console.log('Bootstrapped long-lived Meta token, expires at', expiresAt);
  return data.access_token;
}

async function getCurrentToken() {
  const token = await MetaToken.findOne({ _id: 1 }).lean();
  if (!token) {
    if (process.env.META_INITIAL_ACCESS_TOKEN) {
      const access_token = await bootstrapLongLivedToken();
      return { access_token };
    }
    throw new Error('No Meta token stored yet — set META_INITIAL_ACCESS_TOKEN in env');
  }
  if (new Date(token.expires_at) <= new Date()) {
    await sendAlert('Meta access token has expired — set META_INITIAL_ACCESS_TOKEN and restart to re-bootstrap', {
      expired_at: token.expires_at,
    });
    throw new Error('Meta access token has expired');
  }
  return token;
}

async function refreshTokenIfNeeded() {
  const { access_token, expires_at } = await getCurrentToken();
  const daysUntilExpiry = (new Date(expires_at) - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntilExpiry > 10) {
    console.log(`Meta token still valid for ${Math.round(daysUntilExpiry)} days, skipping refresh.`);
    return;
  }

  try {
    const { data } = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: access_token,
      },
    });

    const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);
    await MetaToken.updateOne(
      { _id: 1 },
      { access_token: data.access_token, expires_at: newExpiresAt, last_refreshed_at: new Date() }
    );
    console.log('Refreshed Meta token, new expiry:', newExpiresAt);
  } catch (err) {
    await sendAlert('Meta access token refresh failed — spend sync will stop working once the current token expires', {
      error: err.response?.data || err.message,
      current_expiry: expires_at,
    });
    throw err;
  }
}

module.exports = { bootstrapLongLivedToken, getCurrentToken, refreshTokenIfNeeded };
