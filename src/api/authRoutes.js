import { Router } from 'express';
import { authService } from '../services/authService.js';
import logger from '../utils/logger.js';
import { getPrisma } from '../db/client.js';

const router = Router();
const prisma = getPrisma();

/**
 * Middleware to simulate session for non-Telegram platforms for demonstration.
 * In a real-world scenario, you would use JWTs or another stateless auth mechanism.
 */
const attachUserFromHeader = async (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (userId) {
    req.user = await authService.findUserById(String(userId));
    req.userId = String(userId);
  }
  next();
};

/**
 * GET /api/auth/check-email
 * Checks if an email address is already registered.
 * @query {string} email - The email to check.
 */
router.get('/check-email', async (req, res) => {
  const { email } = req.query;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email query parameter is required and must be a string.' });
  }

  try {
    const exists = await authService.checkEmailExists(email.toLowerCase());
    res.json({ exists });
  } catch (error) {
    logger.error('API Error in /check-email', { error: error.message, email });
    res.status(500).json({ error: 'An internal error occurred while checking the email.' });
  }
});

/**
 * POST /api/auth/signup/initiate
 * Initiates the signup process for a new user and sends a verification email.
 * @body {string} fullName
 * @body {string} email
 * @body {string} userId - A unique identifier from the client platform.
 * @body {string} platform - The name of the client platform (e.g., 'website', 'app').
 */
router.post('/signup/initiate', async (req, res) => {
  const { fullName, email, userId, platform } = req.body;

  if (!fullName || !email || !userId || !platform) {
    return res.status(400).json({ error: 'fullName, email, userId, and platform are required.' });
  }

  try {
    const emailExists = await authService.checkEmailExists(email);
    if (emailExists) {
      return res.status(409).json({ error: 'This email address is already in use.' });
    }

    // For non-Telegram platforms, we need a way to store the verification code.
    // Here, we'll temporarily store it in a `verifications` table.
    // In a production app, use a more robust solution like Redis with TTL.
    const firstName = fullName.split(' ')[0] || fullName;
    const result = await authService.initiateSignup(fullName, email, firstName, userId);

    if (result.success) {
      // Store verification details for the next step
      await prisma.sessions.create({
        data: {
          session_key: `verification:${email}`,
          session_data: {
            code: result.verificationCode,
            userId,
            fullName,
            platform,
            expiresAt: Date.now() + 15 * 60 * 1000, // 15-minute expiry
          },
        },
      });
      res.status(200).json({ message: 'Verification code sent to your email.' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send verification email.' });
    }
  } catch (error) {
    logger.error('API Error in /signup/initiate', { error: error.message });
    res.status(500).json({ error: 'An internal error occurred during signup initiation.' });
  }
});

/**
 * POST /api/auth/signup/complete
 * Completes the registration process using a verification code.
 * @body {string} email
 * @body {string} code
 */
router.post('/signup/complete', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required.' });
  }

  try {
    const verificationSession = await prisma.sessions.findUnique({
      where: { session_key: `verification:${email}` },
    });

    if (!verificationSession || verificationSession.session_data.expiresAt < Date.now()) {
      return res.status(404).json({ error: 'Verification code is invalid or has expired.' });
    }

    if (verificationSession.session_data.code !== code) {
      return res.status(400).json({ error: 'Incorrect verification code.' });
    }

    const { userId, fullName, platform } = verificationSession.session_data;
    const result = await authService.completeRegistration(userId, fullName, email, platform);

    if (result.success) {
      // Clean up the verification session
      await prisma.sessions.delete({ where: { session_key: `verification:${email}` } });
      res.status(201).json({ message: 'Registration successful.', user: result.user });
    } else {
      res.status(500).json({ error: result.error || 'Failed to complete registration.' });
    }
  } catch (error) {
    logger.error('API Error in /signup/complete', { error: error.message });
    res.status(500).json({ error: 'An internal error occurred during registration completion.' });
  }
});

export default router;