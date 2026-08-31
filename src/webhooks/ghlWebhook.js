const express = require('express');
const crypto = require('crypto');
const { Seminar, Lead, StageHistory, UnmappedEvent } = require('../db/pool');
const { sendAlert } = require('../alerts');

const router = express.Router();

function verifyWebhook(req) {
  const provided = req.header('x-webhook-secret');
  const expected = process.env.GHL_WEBHOOK_SECRET;
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function resolveStageRole(stageRoleMap, stageName) {
  for (const [role, val] of Object.entries(stageRoleMap || {})) {
    const names = Array.isArray(val) ? val : [val];
    if (names.includes(stageName)) return role;
  }
  return null;
}

router.post('/webhooks/ghl', async (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).json({ error: 'Invalid or missing webhook signature' });
  }

  const payload = req.body.customData || req.body;
  const {
    contact_id, opportunity_id, pipeline_name, stage_name,
    event_timestamp, name, email, phone, deal_value,
  } = payload;

  if (!contact_id || !pipeline_name || !stage_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const seminar = await Seminar.findOne({ ghl_pipeline_name: pipeline_name }, 'stage_role_map').lean();

    if (!seminar) {
      await UnmappedEvent.create({ raw_payload: payload, ghl_pipeline_name: pipeline_name });
      await sendAlert('Webhook received for an unregistered GHL pipeline', { pipeline_name, contact_id });
      return res.status(202).json({ status: 'stored_unmapped' });
    }

    const stageRole = resolveStageRole(seminar.stage_role_map, stage_name);
    if (!stageRole) {
      await sendAlert('Stage name not found in seminar stage_role_map — pipeline may not match master template', {
        seminar_id: seminar._id, stage_name,
      });
    }

    const eventTs = event_timestamp ? new Date(event_timestamp) : new Date();
    const dealValueNum = Number(deal_value) || 0;

    // Non-stage fields always update; created_at only on first insert.
    await Lead.updateOne(
      { _id: contact_id },
      {
        $set: { opportunity_id, seminar_id: seminar._id, name, email, phone, deal_value: dealValueNum, deal_won: stageRole === 'closed_won'  },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true }
    );

    // Only advance stage if this event is newer — guards against out-of-order webhook delivery.
    await Lead.updateOne(
      { _id: contact_id, $or: [{ updated_at: { $exists: false } }, { updated_at: { $lte: eventTs } }] },
      { $set: { current_stage_name: stage_name, current_stage_role: stageRole, updated_at: eventTs } }
    );

    // Always append to the journey log regardless of ordering — this is what powers
    // accurate date-range funnel queries. Never overwrite, always insert.
    await StageHistory.create({
      lead_id: contact_id,
      seminar_id: seminar._id,
      stage_name,
      stage_role: stageRole,
      event_timestamp: eventTs,
      raw_data: payload,
    });

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Internal error processing webhook' });
  }
});

module.exports = router;
