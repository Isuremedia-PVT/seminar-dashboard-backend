const express = require('express');
const axios = require('axios');
const { Seminar } = require('../db/pool');
const { getCurrentToken } = require('../meta/tokenManager');

const router = express.Router();

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const REQUIRED_STAGE_ROLES = ['registered', 'attended', 'consult_booked', 'consult_completed', 'closed_won', 'closed_lost'];

// Fetch Meta campaigns using the stored token
router.get('/api/meta/campaigns', async (req, res) => {
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!adAccountId) return res.status(503).json({ error: 'META_AD_ACCOUNT_ID not set in .env' });

  try {
    const { access_token } = await getCurrentToken();
    const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/campaigns`, {
      params: {
        access_token,
        fields: 'id,name,status,effective_status',
        effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES']),
        limit: 200,
      },
    });
    res.json(data.data || []);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    console.error('Meta campaigns fetch failed:', err.response?.status, detail);
    const msg = err.message?.includes('No Meta token')
      ? 'Meta token not initialized — set META_INITIAL_ACCESS_TOKEN and restart'
      : `Meta API error: ${detail}`;
    res.status(502).json({ error: msg });
  }
});

// List all pipelines for the configured GHL location (GHL_LOCATION_ID from env)
router.get('/api/ghl/pipelines', async (req, res) => {
  const api_key     = process.env.GHL_API_KEY;
  const location_id = process.env.GHL_LOCATION_ID;
  if (!api_key)     return res.status(503).json({ error: 'GHL_API_KEY not set in .env' });
  if (!location_id) return res.status(503).json({ error: 'GHL_LOCATION_ID not set in .env' });

  try {
    const { data } = await axios.get('https://services.leadconnectorhq.com/opportunities/pipelines', {
      headers: { Authorization: `Bearer ${api_key}`, Version: '2021-07-28' },
      params: { locationId: location_id },
    });
    res.json((data?.pipelines || []).map(p => ({ id: p.id, name: p.name })));
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('GHL pipelines fetch failed:', err.response?.status, detail);
    res.status(502).json({ error: `GHL error: ${detail}` });
  }
});

// Fetch GHL pipeline stages using server-side API key
router.get('/api/seminars/stages', async (req, res) => {
  const { pipeline_id } = req.query;
  const api_key = process.env.GHL_API_KEY;
  if (!pipeline_id) return res.status(400).json({ error: 'pipeline_id required' });
  if (!api_key) return res.status(503).json({ error: 'GHL_API_KEY not set in .env' });

  try {
    const { data } = await axios.get(`https://services.leadconnectorhq.com/opportunities/pipelines/${pipeline_id}`, {
      headers: { Authorization: `Bearer ${api_key}`, Version: '2021-07-28' },
    });
    const stages = (data?.pipeline?.stages || []).map(s => ({ id: s.id, name: s.name }));
    res.json(stages);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch stages from GHL — check GHL_API_KEY and pipeline ID' });
  }
});

router.post('/api/seminars', async (req, res) => {
  const { name, event_date, location, ghl_pipeline_id, meta_campaign_id, meta_campaign_name, stage_name_to_role } = req.body;
  const ghl_api_key = process.env.GHL_API_KEY;

  if (!name || !ghl_pipeline_id || !stage_name_to_role) {
    return res.status(400).json({ error: 'name, ghl_pipeline_id, and stage_name_to_role are required' });
  }
  if (!ghl_api_key) {
    return res.status(503).json({ error: 'GHL_API_KEY not set in .env' });
  }

  // Enforce one campaign per seminar — check before hitting GHL
  if (meta_campaign_id) {
    const conflict = await Seminar.findOne({ meta_campaign_id, ghl_pipeline_id: { $ne: ghl_pipeline_id } }, 'name').lean();
    if (conflict) {
      return res.status(409).json({ error: `Campaign already linked to seminar "${conflict.name}". Each campaign can only be used once.` });
    }
  }

  try {
    const { data } = await axios.get(`https://services.leadconnectorhq.com/opportunities/pipelines/${ghl_pipeline_id}`, {
      headers: { Authorization: `Bearer ${ghl_api_key}`, Version: '2021-07-28' },
    });

    const pipeline = data?.pipeline || {};
    const stages = pipeline.stages || [];
    const stageRoleMap = {};
    for (const stage of stages) {
      const role = stage_name_to_role[stage.name];
      if (role) stageRoleMap[role] = stage.name;
    }

    const seminar = await Seminar.findOneAndUpdate(
      { ghl_pipeline_id },
      { name, event_date, location, ghl_pipeline_name: pipeline.name, meta_campaign_id, meta_campaign_name, stage_role_map: stageRoleMap },
      { upsert: true, new: true }
    );

    res.status(201).json(seminar);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This Meta campaign is already linked to another seminar.' });
    }
    console.error('Seminar registration error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to register seminar — check GHL pipeline ID' });
  }
});

router.put('/api/seminars/:id', async (req, res) => {
  const { name, event_date, location, meta_campaign_id, meta_campaign_name, active, stage_role_map } = req.body;

  if (meta_campaign_id) {
    const conflict = await Seminar.findOne({ meta_campaign_id, _id: { $ne: req.params.id } }, 'name').lean();
    if (conflict) return res.status(409).json({ error: `Campaign already linked to seminar "${conflict.name}"` });
  }

  try {
    const update = {};
    if (active      !== undefined) update.active             = active !== false;
    if (name        !== undefined) update.name               = name;
    if (event_date  !== undefined) update.event_date         = event_date || null;
    if (location    !== undefined) update.location           = location;
    if (meta_campaign_id   !== undefined) update.meta_campaign_id   = meta_campaign_id   || null;
    if (meta_campaign_name !== undefined) update.meta_campaign_name = meta_campaign_name || null;
    if (stage_role_map     !== undefined) update.stage_role_map     = stage_role_map;

    const seminar = await Seminar.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );
    if (!seminar) return res.status(404).json({ error: 'Seminar not found' });
    res.json(seminar);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'This Meta campaign is already linked to another seminar.' });
    res.status(500).json({ error: 'Failed to update seminar' });
  }
});

module.exports = router;
