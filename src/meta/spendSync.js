const axios = require('axios');
const { Seminar, AdSpendDaily } = require('../db/pool');
const { getCurrentToken } = require('./tokenManager');
const { sendAlert } = require('../alerts');

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

async function syncDailySpend() {
  const { access_token } = await getCurrentToken();
  const seminars = await Seminar.find({ meta_campaign_id: { $ne: null } }, 'meta_campaign_id').lean();

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr  = yesterday.toISOString().slice(0, 10);  // YYYY-MM-DD
  const spendDate = new Date(dateStr);                      // UTC midnight

  for (const { _id: seminar_id, meta_campaign_id } of seminars) {
    try {
      const [insightsResp, campaignResp] = await Promise.all([
        axios.get(`${GRAPH_BASE}/${meta_campaign_id}/insights`, {
          params: { access_token, time_range: JSON.stringify({ since: dateStr, until: dateStr }), fields: 'spend' },
        }),
        axios.get(`${GRAPH_BASE}/${meta_campaign_id}`, {
          params: { access_token, fields: 'daily_budget,lifetime_budget' },
        }),
      ]);

      const spend = Number(insightsResp.data?.data?.[0]?.spend) || 0;
      const c = campaignResp.data;
      const hasLifetime = c.lifetime_budget && c.lifetime_budget !== '0';
      const campaign_budget      = hasLifetime ? Number(c.lifetime_budget) / 100 : Number(c.daily_budget) / 100 || null;
      const campaign_budget_type = hasLifetime ? 'lifetime' : c.daily_budget ? 'daily' : null;

      await AdSpendDaily.findOneAndUpdate(
        { meta_campaign_id, spend_date: spendDate },
        { seminar_id, spend_amount: spend, campaign_budget, campaign_budget_type },
        { upsert: true }
      );

      console.log(`Synced spend for campaign ${meta_campaign_id} on ${dateStr}: $${spend} (budget: $${campaign_budget} ${campaign_budget_type})`);
    } catch (err) {
      // One campaign failing must not stop the rest — but it must not be silent either.
      await sendAlert(`Failed to sync Meta spend for campaign ${meta_campaign_id}`, {
        seminar_id, date: dateStr, error: err.response?.data || err.message,
      });
    }
  }
}

module.exports = { syncDailySpend };
