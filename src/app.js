const path    = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');

const ghlWebhookRouter  = require('./webhooks/ghlWebhook');
const dashboardRouter   = require('./routes/dashboard');
const seminarsRouter    = require('./routes/seminars');
const webhookInfoRouter = require('./routes/webhook');
const authRouter        = require('./routes/auth');
const requireAuth       = require('./middleware/auth');
const { User }          = require('./db/pool');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

// Seed initial admin user if none exist
async function seedAdmin() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!email || !password) return;
  const exists = await User.findOne({ email: email.toLowerCase() }).lean();
  if (exists) return;
  await User.create({ email: email.toLowerCase(), password_hash: await bcrypt.hash(password, 10) });
  console.log('Admin user created:', email);
}
seedAdmin().catch(err => console.error('Admin seed failed:', err));

app.get('/',      (req, res) => res.render('dashboard', { isLoggedIn: !!req.session.user }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auth routes (public)
app.use(authRouter);

// Webhook ingestion (public — called by GHL, not users)
app.use(ghlWebhookRouter);

// Public dashboard APIs
app.use(dashboardRouter);

// Protected: webhook management info
app.use(requireAuth, webhookInfoRouter);

// Protected: seminar management + GHL/Meta API proxies
app.use(requireAuth, seminarsRouter);

module.exports = app;
