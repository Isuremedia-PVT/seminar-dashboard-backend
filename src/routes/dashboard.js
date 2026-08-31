const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { Seminar, Lead, StageHistory, AdSpendDaily } = require('../db/pool');
const { getCurrentToken } = require('../meta/tokenManager');

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

const router = express.Router();

function safeDivide(numerator, denominator) {
  if (!denominator || Number(denominator) === 0) return null;
  return Number(numerator) / Number(denominator);
}

router.get('/api/seminars', async (req, res) => {
  const seminars = await Seminar.find({}, 'name event_date location meta_campaign_id meta_campaign_name active ghl_pipeline_id stage_role_map').sort({ event_date: -1 }).lean();

  // Fetch all-time spend live from Meta for each linked campaign in parallel.
  // Failures per campaign are caught individually so one bad campaign doesn't break the list.
  let spendMap = {};
  const withCampaign = seminars.filter(s => s.meta_campaign_id);
  if (withCampaign.length) {
    try {
      const { access_token } = await getCurrentToken();
      const results = await Promise.all(
        withCampaign.map(s =>
          axios.get(`${GRAPH_BASE}/${s.meta_campaign_id}/insights`, {
            params: { access_token, fields: 'spend', date_preset: 'maximum' },
          })
          .then(r => [s._id.toString(), Number(r.data?.data?.[0]?.spend) || 0])
          .catch(() => [s._id.toString(), null])
        )
      );
      spendMap = Object.fromEntries(results);
    } catch { /* no token — leave spendMap empty */ }
  }

  res.json(seminars.map(s => ({
    seminar_id: s._id, name: s.name, event_date: s.event_date, location: s.location,
    meta_campaign_id: s.meta_campaign_id, meta_campaign_name: s.meta_campaign_name,
    active: s.active !== false, ghl_pipeline_id: s.ghl_pipeline_id,
    stage_role_map: s.stage_role_map || {},
    total_spend: spendMap[s._id.toString()] ?? null,  // null = no campaign or fetch failed
  })));
});

router.get('/api/dashboard/summary', async (req, res) => {
  const { date_from, date_to, seminar_id } = req.query;
  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from and date_to are required (YYYY-MM-DD)' });
  }
  if (seminar_id && !mongoose.Types.ObjectId.isValid(seminar_id)) {
    return res.status(400).json({ error: 'Invalid seminar_id' });
  }

  const dateFrom = new Date(date_from);
  const dateTo   = new Date(date_to + 'T23:59:59.999Z');
  const seminarFilter = seminar_id ? { seminar_id: new mongoose.Types.ObjectId(seminar_id) } : {};

  // Build a live Meta spend fetcher for the date range
  async function fetchMetaSpend() {
    const timeRange = JSON.stringify({ since: date_from, until: date_to });
    const { access_token } = await getCurrentToken();
    if (seminar_id) {
      const sem = await Seminar.findById(seminar_id, 'meta_campaign_id').lean();
      if (!sem?.meta_campaign_id) return 0;
      const { data } = await axios.get(`${GRAPH_BASE}/${sem.meta_campaign_id}/insights`, {
        params: { access_token, fields: 'spend', time_range: timeRange },
      });
      return Number(data?.data?.[0]?.spend) || 0;
    }
    // All seminars — fetch each campaign in parallel and sum
    const all = await Seminar.find({ meta_campaign_id: { $ne: null } }, 'meta_campaign_id').lean();
    const spends = await Promise.all(all.map(s =>
      axios.get(`${GRAPH_BASE}/${s.meta_campaign_id}/insights`, {
        params: { access_token, fields: 'spend', time_range: timeRange },
      }).then(r => Number(r.data?.data?.[0]?.spend) || 0).catch(() => 0)
    ));
    return spends.reduce((a, b) => a + b, 0);
  }

  try {
    const [funnelAgg, leadCount, totalSpend] = await Promise.all([
      // Count distinct leads per stage_role within the date window.
      // Two-stage group: first deduplicate (lead, role) pairs, then count per role.
      StageHistory.aggregate([
        { $match: { event_timestamp: { $gte: dateFrom, $lte: dateTo }, ...seminarFilter } },
        { $group: { _id: { lead_id: '$lead_id', stage_role: '$stage_role' } } },
        { $group: { _id: '$_id.stage_role', count: { $sum: 1 } } },
      ]),
      Lead.countDocuments({ created_at: { $gte: dateFrom, $lte: dateTo }, ...seminarFilter }),
      fetchMetaSpend().catch(() => 0),
    ]);

    const funnel = Object.fromEntries(funnelAgg.map(r => [r._id, r.count]));
    const registered       = funnel.registered        || 0;
    const attended         = funnel.attended           || 0;
    const consultBooked    = funnel.consult_booked     || 0;
    const consultCompleted = funnel.consult_completed  || 0;
    const closedWon        = funnel.closed_won         || 0;

    res.json({
      filters: { date_from, date_to, seminar_id: seminar_id || 'all' },
      raw_counts: { leads: leadCount, registered, attended, consult_booked: consultBooked, consult_completed: consultCompleted, closed_won: closedWon, total_spend: totalSpend },
      metrics: {
        cost_per_lead:                safeDivide(totalSpend, leadCount),
        cost_per_registration:        safeDivide(totalSpend, registered),
        lead_to_registration_rate_pct:safeDivide(registered * 100, leadCount),
        attendance_rate_pct:          safeDivide(attended * 100, registered),
        cost_per_attendee:            safeDivide(totalSpend, attended),
        attendee_to_consult_rate_pct: safeDivide(consultBooked * 100, attended),
        cost_per_consult_booked:      safeDivide(totalSpend, consultBooked),
        pct_consults_occurred:        safeDivide(consultCompleted * 100, consultBooked),
        cost_per_consult_completed:   safeDivide(totalSpend, consultCompleted),
        close_rate_pct:               safeDivide(closedWon * 100, consultCompleted),
        cost_per_sale:                safeDivide(totalSpend, closedWon),
      },
    });
  } catch (err) {
    console.error('Dashboard summary error:', err);
    res.status(500).json({ error: 'Failed to compute dashboard summary' });
  }
});

router.get('/api/dashboard/table', async (req, res) => {
  const { date_from, date_to } = req.query;
  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from and date_to are required (YYYY-MM-DD)' });
  }

  const dateFrom = new Date(date_from);
  const dateTo   = new Date(date_to + 'T23:59:59.999Z');

  try {
    const [seminars, stageCounts] = await Promise.all([
      Seminar.find({}, 'name event_date meta_campaign_id').sort({ event_date: -1 }).lean(),
      StageHistory.aggregate([
        { $match: { event_timestamp: { $gte: dateFrom, $lte: dateTo } } },
        { $group: { _id: { seminar_id: '$seminar_id', stage_role: '$stage_role', lead_id: '$lead_id' } } },
        { $group: { _id: { seminar_id: '$_id.seminar_id', stage_role: '$_id.stage_role' }, count: { $sum: 1 } } },
        { $group: { _id: '$_id.seminar_id', stages: { $push: { k: '$_id.stage_role', v: '$count' } } } },
        { $project: { stages: { $arrayToObject: '$stages' } } },
      ]),
    ]);

    const timeRange = JSON.stringify({ since: date_from, until: date_to });
    const spendMap = {};
    try {
      const { access_token } = await getCurrentToken();
      await Promise.all(seminars.filter(s => s.meta_campaign_id).map(s =>
        axios.get(`${GRAPH_BASE}/${s.meta_campaign_id}/insights`, {
          params: { access_token, fields: 'spend', time_range: timeRange },
        })
        .then(r => { spendMap[s._id.toString()] = Number(r.data?.data?.[0]?.spend) || 0; })
        .catch(() => {})
      ));
    } catch { /* no token — spendMap stays empty */ }

    const stageMap = Object.fromEntries(stageCounts.map(s => [s._id?.toString(), s.stages]));

    const rows = seminars.map(s => {
      const id               = s._id.toString();
      const stages           = stageMap[id]  || {};
      const total_spend      = spendMap[id]   || 0;
      const registered       = stages.registered       || 0;
      const attended         = stages.attended          || 0;
      const consult_booked   = stages.consult_booked    || 0;
      const consult_completed= stages.consult_completed || 0;
      const closed_won       = stages.closed_won        || 0;
      return {
        seminar_id: id,
        name: s.name,
        event_date: s.event_date,
        total_spend,
        registered, attended, consult_booked, consult_completed, closed_won,
        cost_per_attendee: safeDivide(total_spend, attended),
        close_rate_pct:    safeDivide(closed_won * 100, consult_completed),
        cost_per_sale:     safeDivide(total_spend, closed_won),
      };
    });

    res.json(rows);
  } catch (err) {
    console.error('Dashboard table error:', err);
    res.status(500).json({ error: 'Failed to compute dashboard table' });
  }
});

router.get('/api/leads', async (req, res) => {
  const { seminar_id } = req.query;
  const filter = seminar_id && mongoose.Types.ObjectId.isValid(seminar_id)
    ? { seminar_id: new mongoose.Types.ObjectId(seminar_id) } : {};

  try {
    const leads = await Lead.find(filter, 'name email phone current_stage_name current_stage_role seminar_id created_at')
      .populate('seminar_id', 'name')
      .sort({ created_at: -1 })
      .limit(500)
      .lean();
    res.json(leads);
  } catch (err) {
    console.error('Leads error:', err);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

module.exports = router;
