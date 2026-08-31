const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/seminar_dashboard')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); });

// One doc per seminar event. ghl_pipeline_id is unique — the guard that enforces one
// registered pipeline per seminar (never built from scratch, always from master template).
const seminarSchema = new mongoose.Schema({
  name:               { type: String, required: true },
  event_date:         Date,
  location:           String,
  ghl_pipeline_id:    { type: String, required: true, unique: true },
  ghl_pipeline_name:  { type: String },
  meta_campaign_id:   String,
  meta_campaign_name: String,
  active:             { type: Boolean, default: true },
  stage_role_map:     { type: mongoose.Schema.Types.Mixed, default: {} },
  created_at:         { type: Date, default: Date.now },
});
seminarSchema.index({ ghl_pipeline_name: 1 });
// sparse: null seminars don't conflict; unique: one campaign per seminar
seminarSchema.index({ meta_campaign_id: 1 }, { unique: true, sparse: true });
const Seminar = mongoose.model('Seminar', seminarSchema);

// _id = GHL contact_id so upserts are naturally idempotent — no duplicate leads even when
// webhooks retry.
const Lead = mongoose.model('Lead', new mongoose.Schema({
  _id:                String,   // GHL contact_id
  opportunity_id:     String,
  seminar_id:         { type: mongoose.Schema.Types.ObjectId, ref: 'Seminar' },
  name:               String,
  email:              String,
  phone:              String,
  current_stage_name: String,
  current_stage_role: String,
  deal_value:         { type: Number, default: 0 },
  deal_won:           { type: Boolean, default: false },
  created_at:         { type: Date, default: Date.now },
  updated_at:         Date,
}));

// Append-only funnel event log. Source of truth for all date-range/historical queries —
// never read leads.current_stage_role for reporting, always aggregate this collection.
const stageHistorySchema = new mongoose.Schema({
  lead_id:         { type: String, required: true },
  seminar_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Seminar' },
  stage_name:      String,
  stage_role:      String,
  event_timestamp: { type: Date, required: true },
  received_at:     { type: Date, default: Date.now },
  raw_data:        { type: mongoose.Schema.Types.Mixed },
});
stageHistorySchema.index({ lead_id: 1 });
stageHistorySchema.index({ seminar_id: 1, event_timestamp: 1 });
const StageHistory = mongoose.model('StageHistory', stageHistorySchema);

// One doc per campaign per day of actual spend (not Meta's "budget" setting).
const adSpendSchema = new mongoose.Schema({
  seminar_id:           { type: mongoose.Schema.Types.ObjectId, ref: 'Seminar' },
  meta_campaign_id:     { type: String, required: true },
  spend_date:           { type: Date, required: true },   // stored at UTC midnight
  spend_amount:         { type: Number, default: 0 },
  campaign_budget:      { type: Number, default: null },  // dollars; snapshot of budget on this day
  campaign_budget_type: { type: String, default: null },  // 'daily' | 'lifetime'
});
adSpendSchema.index({ meta_campaign_id: 1, spend_date: 1 }, { unique: true });
const AdSpendDaily = mongoose.model('AdSpendDaily', adSpendSchema);

// Guardrail: webhooks for unregistered pipelines land here so a missed setup step is
// caught within minutes via an alert, not discovered weeks later as missing data.
const UnmappedEvent = mongoose.model('UnmappedEvent', new mongoose.Schema({
  raw_payload:      mongoose.Schema.Types.Mixed,
  ghl_pipeline_name: String,
  received_at:      { type: Date, default: Date.now },
  resolved:         { type: Boolean, default: false },
}));

// Singleton doc (_id=1) for the current Meta long-lived access token.
const MetaToken = mongoose.model('MetaToken', new mongoose.Schema({
  _id:               { type: Number },
  access_token:      { type: String, required: true },
  expires_at:        { type: Date, required: true },
  last_refreshed_at: { type: Date, default: Date.now },
}));

const User = mongoose.model('User', new mongoose.Schema({
  email:               { type: String, required: true, unique: true, lowercase: true },
  password_hash:       { type: String, required: true },
  reset_token:         String,
  reset_token_expires: Date,
}));

module.exports = { Seminar, Lead, StageHistory, AdSpendDaily, UnmappedEvent, MetaToken, User };
