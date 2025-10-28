import { getPrisma } from '../db/client.js';
import logger from '../utils/logger.js';
import axios from 'axios';

const prisma = getPrisma();

// This URL should ideally be managed as an environment variable for production
const EMAIL_VERIFICATION_WEBHOOK_URL = 'https://hook.eu2.make.com/1rzify472wbi8lzbkazby3yyb7ot9rhp';

export const authService = {
  /**
   * Checks if a user with the given email already exists.
   * @param {string} email
   * @returns {Promise<boolean>} True if email exists, false otherwise.
   */
  async checkEmailExists(email) {
    logger.info('[authService] Checking if email exists', { email });
    try {
      const existingUser = await prisma.users.findFirst({ where: { email } });
      const emailExists = !!existingUser;
      logger.info(`[authService] Email existence check for ${email}: ${emailExists}`);
      return emailExists;
    } catch (err) {
      logger.error('Error in authService.checkEmailExists', { error: err.message, email });
      throw new Error('Failed to check email existence.');
    }
  },

  /**
   * Initiates the signup process by sending a verification email.
   * @param {string} fullName
   * @param {string} email
   * @param {string} firstName
   * @param {string} userId - The platform-specific user identifier.
   * @returns {Promise<{success: boolean, verificationCode?: string, error?: string}>}
   */
  async initiateSignup(fullName, email, firstName, userId) {
    logger.info('[authService] Initiating signup', { userId, email, fullName });
    try {
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      logger.debug('[authService] Generated verification code', { userId, verificationCode });

      const payload = {
        name: firstName,
        email: email,
        verification: verificationCode,
      };

      logger.info('[authService] Sending verification email webhook', { userId, email });
      await axios.post(EMAIL_VERIFICATION_WEBHOOK_URL, payload);
      logger.info('[authService] Verification email sent for signup', { userId, email });

      return { success: true, verificationCode };
    } catch (err) {
      logger.error('Error in authService.initiateSignup', { error: err.message, stack: err.stack, telegramId, email });
      return { success: false, error: 'Failed to send verification email. Please try again.' };
    }
  },

  /**
   * Completes user registration after email verification.
   * @param {string} userId - The platform-specific user identifier.
   * @param {string} fullName
   * @param {string} email
   * @param {string} platform
   * @returns {Promise<{success: boolean, user?: object, error?: string}>}
   */
  async completeRegistration(userId, fullName, email, platform) {
    logger.info('[authService] Completing user registration', { userId, email, fullName, platform });
    try {
      const userData = {
        userId: userId,
        fullName: fullName,
        email: email,
        platform: platform,
        admin: false,
        verified: false, // User is created, but might need further verification steps if any
      };
      logger.debug('[authService] Creating user with data', { userData });
      const user = await prisma.users.create({
        data: {
          userId: userId,
          fullName: fullName,
          email: email,
          platform: platform,
          admin: false,
          verified: false, // User is created, but might need further verification steps if any
        },
      });
      logger.info('[authService] User registered successfully', { userId, email: user.email });
      return { success: true, user };
    } catch (err) {
      logger.error('Error in authService.completeRegistration', { error: err.message, stack: err.stack, userId, email });
      return { success: false, error: 'Failed to complete registration.' };
    }
  },

  /**
   * Updates a user's full name.
   * @param {string} telegramId
   * @param {string} userId - The platform-specific user identifier.
   * @returns {Promise<{success: boolean, user?: object, error?: string}>}
   */
  async updateUserFullName(userId, newFullName) {
    logger.info('[authService] Updating user full name', { userId, newFullName });
    try {
      const user = await prisma.users.update({
        where: { userId: userId },
        data: { fullName: newFullName },
      });
      logger.info('[authService] User full name updated', { userId, newFullName });
      return { success: true, user };
    } catch (err) {
      logger.error('Error in authService.updateUserFullName', { error: err.message, stack: err.stack, userId, newFullName });
      return { success: false, error: 'Failed to update full name.' };
    }
  },

  /**
   * Initiates an email change by sending a verification email to the new address.
   * @param {string} firstName
   * @param {string} newEmail
   * @param {string} userId - The platform-specific user identifier.
   * @returns {Promise<{success: boolean, verificationCode?: string, error?: string}>}
   */
  async initiateEmailChange(firstName, newEmail, userId) {
    logger.info('[authService] Initiating email change', { userId, newEmail });
    return this.initiateSignup(firstName, newEmail, firstName, userId); // Reusing signup email logic
  },

  /**
   * Completes an email change, updating user's email and associated subscriptions.
   * @param {string} userId - The platform-specific user identifier.
   * @param {string} oldEmail
   * @param {string} verifiedNewEmail
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async completeEmailChange(userId, oldEmail, verifiedNewEmail) {
    logger.info('[authService] Completing email change', { userId, oldEmail, newEmail: verifiedNewEmail });
    try {
      // Update all subscriptions where the old email is in the crew array
      const subscriptionsToUpdate = await prisma.subscription.findMany({
        where: { crew: { has: oldEmail } },
      });
      logger.debug(`[authService] Found ${subscriptionsToUpdate.length} subscriptions to update for email change.`);

      const updatePromises = subscriptionsToUpdate.map((sub) => {
        const newCrew = sub.crew.map((email) => (email === oldEmail ? verifiedNewEmail : email));
        return prisma.subscription.update({
          where: { id: sub.id },
          data: { crew: newCrew },
        });
      });

      // Update the user's email
      const userUpdatePromise = prisma.users.update({
        where: { userId: userId },
        data: { email: verifiedNewEmail },
      });

      logger.info('[authService] Executing email change transaction in database');
      await prisma.$transaction([...updatePromises, userUpdatePromise]);

      logger.info('[authService] User email and crew memberships updated', { userId, oldEmail, verifiedNewEmail });
      return { success: true };
    } catch (err) {
      logger.error('Error in authService.completeEmailChange', {
        error: err.message,
        stack: err.stack,
        userId,
        oldEmail,
        verifiedNewEmail,
      });
      return { success: false, error: 'Failed to update user email and crew memberships.' };
    }
  },

  /**
   * Finds a user by their Telegram ID.
   * @param {string} userId - The platform-specific user identifier.
   * @returns {Promise<object|null>} The user object or null if not found.
   */
  async findUserById(userId) {
    logger.info('[authService] Finding user by ID', { userId });
    try {
      const user = await prisma.users.findUnique({ where: { userId: userId } });
      logger.info(user ? '[authService] User found' : '[authService] User not found', { userId });
      return user;
    } catch (err) {
      logger.error('Error in authService.findUserById', { error: err.message, stack: err.stack, userId });
      return null;
    }
  },
};