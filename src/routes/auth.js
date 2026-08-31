const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const nodemailer = require('nodemailer');
const { User } = require('../db/pool');

const router = express.Router();

function mailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email?.toLowerCase() }).lean();
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', { error: 'Invalid email or password' });
  }
  req.session.user = { id: user._id, email: user.email };
  res.redirect('/');
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { message: null, error: null });
});

router.post('/auth/forgot-password', async (req, res) => {
  const user = await User.findOne({ email: req.body.email?.toLowerCase() });
  // Always respond the same way to avoid email enumeration
  const ok = { message: 'If that email exists, a reset link has been sent.', error: null };
  if (!user) return res.render('forgot-password', ok);

  const token = crypto.randomBytes(32).toString('hex');
  user.reset_token         = token;
  user.reset_token_expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await user.save();

  const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password/${token}`;
  try {
    await mailer().sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      user.email,
      subject: 'Password Reset',
      text:    `Reset your password: ${resetUrl}\n\nExpires in 1 hour.`,
      html:    `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>Expires in 1 hour.</p>`,
    });
  } catch (err) {
    console.error('Reset email failed:', err.message);
  }

  res.render('forgot-password', ok);
});

router.get('/reset-password/:token', async (req, res) => {
  const user = await User.findOne({
    reset_token: req.params.token,
    reset_token_expires: { $gt: new Date() },
  }).lean();
  if (!user) return res.render('reset-password', { token: null, error: 'Reset link is invalid or expired.' });
  res.render('reset-password', { token: req.params.token, error: null });
});

router.post('/auth/reset-password/:token', async (req, res) => {
  const user = await User.findOne({
    reset_token: req.params.token,
    reset_token_expires: { $gt: new Date() },
  });
  if (!user) return res.render('reset-password', { token: null, error: 'Reset link is invalid or expired.' });

  const { password, confirm_password } = req.body;
  if (!password || password.length < 8)
    return res.render('reset-password', { token: req.params.token, error: 'Password must be at least 8 characters.' });
  if (password !== confirm_password)
    return res.render('reset-password', { token: req.params.token, error: 'Passwords do not match.' });

  user.password_hash       = await bcrypt.hash(password, 10);
  user.reset_token         = undefined;
  user.reset_token_expires = undefined;
  await user.save();

  res.redirect('/login?reset=1');
});

module.exports = router;
