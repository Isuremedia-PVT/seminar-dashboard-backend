module.exports = (req, res, next) => {
  if (req.session?.user) return next();
  if (req.accepts('html')) return res.redirect('/login');
  res.status(401).json({ error: 'Unauthorized' });
};
