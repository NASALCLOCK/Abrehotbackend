// Simple shared-secret admin check — not full user accounts, just a gate
// so random visitors can't approve tutors. The person enters ADMIN_SECRET
// (from .env) once in admin.html and it's sent as a header on every request.
function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ message: 'Invalid admin secret' });
  }
  next();
}

module.exports = { requireAdmin };
