const router = require('express').Router();
const Child = require('../models/Child');
const { requireAuth } = require('../middleware/auth');

// GET /api/children/mine — the logged-in parent's children
router.get('/mine', requireAuth, async (req, res) => {
  const children = await Child.find({ parent: req.user.id }).sort({ createdAt: -1 });
  res.json(children);
});

// POST /api/children — add a child
router.post('/', requireAuth, async (req, res) => {
  const { name, grade, school } = req.body;
  if (!name) return res.status(400).json({ message: 'Name is required' });
  const child = await Child.create({ parent: req.user.id, name, grade, school });
  res.status(201).json(child);
});

// PATCH /api/children/:id — edit a child (only the parent who added them)
router.patch('/:id', requireAuth, async (req, res) => {
  const child = await Child.findById(req.params.id);
  if (!child) return res.status(404).json({ message: 'Not found' });
  if (child.parent.toString() !== req.user.id) return res.status(403).json({ message: 'Not allowed' });

  const editable = ['name', 'grade', 'school', 'status'];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) child[field] = req.body[field];
  });
  await child.save();
  res.json(child);
});

// DELETE /api/children/:id — remove a child
router.delete('/:id', requireAuth, async (req, res) => {
  const child = await Child.findById(req.params.id);
  if (!child) return res.status(404).json({ message: 'Not found' });
  if (child.parent.toString() !== req.user.id) return res.status(403).json({ message: 'Not allowed' });

  await child.deleteOne();
  res.json({ message: 'Removed' });
});

module.exports = router;
