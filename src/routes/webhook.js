const express = require('express');
const { StageHistory, UnmappedEvent } = require('../db/pool');

const router = express.Router();

router.get('/api/webhook/config', (req, res) => {
  res.json({ secret_configured: !!process.env.GHL_WEBHOOK_SECRET });
});

router.get('/api/webhook/events', async (req, res) => {
  try {
    const [history, unmapped] = await Promise.all([
      StageHistory.find().sort({ _id: -1 }).limit(50).populate('seminar_id', 'name').lean(),
      UnmappedEvent.find().sort({ _id: -1 }).limit(20).lean(),
    ]);

    const events = [
      ...history.map(e => ({
        type: 'mapped',
        received_at: e.received_at || e.event_timestamp,
        contact_id: e.lead_id,
        seminar: e.seminar_id?.name || '—',
        stage_role: e.stage_role || '—',
        event_timestamp: e.event_timestamp,
        payload: e.raw_data || null,
      })),
      ...unmapped.map(e => ({
        type: 'unmapped',
        received_at: e.received_at,
        pipeline_name: e.ghl_pipeline_name,
        resolved: e.resolved,
        payload: e.raw_payload,
      })),
    ]
      .sort((a, b) => new Date(b.received_at) - new Date(a.received_at))
      .slice(0, 60);

    res.json(events);
  } catch (err) {
    console.error('Webhook events error:', err);
    res.status(500).json({ error: 'Failed to load webhook events' });
  }
});

module.exports = router;
