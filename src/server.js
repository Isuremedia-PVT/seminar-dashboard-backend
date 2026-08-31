require('dotenv').config();
const cron = require('node-cron');
const app = require('./app');
const { bootstrapLongLivedToken, getCurrentToken, refreshTokenIfNeeded } = require('./meta/tokenManager');
const { syncDailySpend } = require('./meta/spendSync');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Seminar dashboard backend listening on port ${PORT}`);
});

// Ensure Meta token is ready on startup
(async () => {
  try {
    await getCurrentToken();
    await refreshTokenIfNeeded();
  } catch {
    if (process.env.META_INITIAL_ACCESS_TOKEN) {
      console.log('No Meta token in DB — bootstrapping from META_INITIAL_ACCESS_TOKEN...');
      try {
        await bootstrapLongLivedToken();
        console.log('Meta token bootstrapped successfully.');
      } catch (err) {
        console.error('Meta token bootstrap failed:', err.response?.data?.error?.message || err.message);
      }
    } else {
      console.log('Meta token not initialized — set META_INITIAL_ACCESS_TOKEN in .env and restart.');
    }
  }
})();

// Daily spend sync — runs at 3:00 AM server time, after Meta's prior-day figures settle.
cron.schedule('0 3 * * *', async () => {
  console.log('Running daily Meta spend sync...');
  try {
    await syncDailySpend();
  } catch (err) {
    console.error('Daily spend sync failed:', err);
  }
});

// Token refresh check — runs weekly. The function itself only actually refreshes when
// within 10 days of expiry, so running it weekly is a safe margin.
cron.schedule('0 4 * * 1', async () => {
  console.log('Checking Meta token expiry...');
  try {
    await refreshTokenIfNeeded();
  } catch (err) {
    console.error('Token refresh check failed:', err);
  }
});
