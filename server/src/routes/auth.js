import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const rows = await query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, orgId: user.org_id, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.org_id },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Completes an emailed invitation. The invite link carries the user id;
 * the new joiner picks their own password here.
 *
 * SECURITY FIX: this used to accept any userId with no proof of invitation,
 * and stored the password verbatim instead of hashing it — see the Part 1
 * review for the full writeup. There is no invite-token table yet (that is
 * a bigger feature than fits in this fix), so as an interim, defensible
 * guard this endpoint now only ever succeeds for an account that has never
 * had a password set (password_hash IS NULL). Every seeded account already
 * has a password, so this route is inert against today's data — which is
 * the correct, safe behaviour until a real token-based invite flow exists.
 */
router.post('/invite/accept', async (req, res, next) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ error: 'userId and password are required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL',
      [passwordHash, userId]
    );
    if (result.affectedRows === 0) {
      // Either the user doesn't exist or already has a password — don't
      // distinguish between the two in the response.
      return res.status(404).json({ error: 'Invitation not found or already used' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
