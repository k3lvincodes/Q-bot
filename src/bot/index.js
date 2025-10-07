import { Telegraf, Markup, Composer } from 'telegraf';
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import safeSession from '../middlewares/session.js';
import { showMainMenu, showSupportMenu } from '../utils/menu.js';
import axios from 'axios';
import fetch from 'node-fetch';
import logger from '../utils/logger.js';
import { startCronJobs } from '../utils/cron.js';
import {
  addSubscriptionWorkflow,
  handleSubCategorySelection,
  handlePlanSelection,
  handleDurationSelection,
} from './workflows/add-subscription.js';
import {
  browseSubscriptionsWorkflow,
  handleBrowseCategorySelection,
  handleBrowseSubcategorySelection,
  handleSubscriptionSelection,
  initiatePayment,
  verifyPayment,
  cancelPayment,
} from './workflows/browse-subscriptions.js';
import {
  mySubscriptionsWorkflow,
  showListedSubscriptions,
  showJoinedSubscriptions,
  unlistSubscription,
  updateSubscription,
  handleUpdateSlots,
  handleUpdateDuration,
  renewSubscription,
  leaveSubscription,
  cancelLeaveRequest,
} from './workflows/my-subscriptions.js';
import {
  showFaqs,
  showFaqAnswer,
  handleLiveSupport,
} from './workflows/support.js';
import subscriptionPrices, { planIdMap } from '../utils/subscription-prices.js';
import { getPrisma } from '../db/client.js';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error', { error: err.message, stack: err.stack });
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

// Apply session middleware globally. This is crucial for webhooks.
bot.use(safeSession());
startCronJobs();

// Global error handler for Telegraf
bot.catch((err, ctx) => {
  logger.error(`Unhandled error processing ${ctx.updateType}`, { error: err.message, stack: err.stack, update: ctx.update });
  ctx.reply('An unexpected error occurred. Our team has been notified. Please try again later.').catch(e => 
    logger.error('Failed to send error message to user', { error: e.message })
  );
});

// Function to generate a short subscription ID (e.g., Q_D00ZG)
async function generateShortSubId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let subId;
  let isUnique = false;
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    subId = 'Q_' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const existing = await prisma.subscription.findUnique({ where: { subId } });
    if (!existing) {
      isUnique = true;
      break;
    }
  }

  if (!isUnique) {
    throw new Error('Failed to generate unique subscription ID after maximum attempts');
  }

  return subId;
}

// Inactivity middleware
bot.use(async (ctx, next) => {
  const now = Date.now();
  if (!ctx.session) {
    ctx.session = {};
    logger.info('Initialized new session', { telegramId: ctx.from?.id });
  }
  if (!ctx.session.lastActive) {
    ctx.session.lastActive = now;
    return next();
  }
  const inactiveThreshold = 10 * 60 * 1000;
  const timeSinceLast = now - ctx.session.lastActive;
  if (timeSinceLast > inactiveThreshold) {
    ctx.session.wasInactive = true;
    ctx.session.lastActive = now;
    clearListingSession(ctx);
    await ctx.reply('⏳ You were inactive for a while. Welcome  back to Q.');
    return showMainMenu(ctx);
  }
  if (ctx.session.wasInactive) {
    ctx.session.wasInactive = false;
    return;
  }
  ctx.session.lastActive = now;
  return next();
});

function escapeMarkdownV2(text) {
  if (text === null || typeof text === 'undefined') return 'N/A';
  // This is a safer and more standard way to escape MarkdownV2 characters.
  return text.toString().replace(/([_*\\~`>#+\-=|{}.!])/g, '\\$1');
}
export async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }
      return response.json();
    } catch (err) {
      logger.error(`Retry ${i + 1}/${retries} failed for ${url}`, { error: err.message });
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function clearListingSession(ctx) {
  ctx.session.step = null;
  ctx.session.subCat = null;
  ctx.session.subSubCat = null;
  ctx.session.subPlan = null;
  ctx.session.subAmount = null;
  ctx.session.subSlot = null;
  ctx.session.subDuration = null;
  ctx.session.subEmail = null;
  ctx.session.subPassword = null;
  ctx.session.shareType = null;
  ctx.session.whatsappNo = null;
  ctx.session.subId = null;
  ctx.session.browseCategory = null;
  ctx.session.browseSubcategory = null;
  ctx.session.browsePage = null;
  ctx.session.browseSort = null;
  ctx.session.selectedSubId = null;
  ctx.session.authUrl = null;
  ctx.session.transferReference = null;
  ctx.session.updateSubId = null;
  ctx.session.updateSlots = null;
  ctx.session.leaveSubId = null;
}

// Ensure user is registered before proceeding with actions
const ensureRegistered = async (ctx, next) => {
  const prisma = getPrisma();
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;

  const user = await prisma.users.findUnique({ where: { userId: telegramId } });
  if (user) {
    ctx.session.persistentUser = 'yes';
    ctx.session.email = user.email;
    ctx.session.fullName = user.fullName;
    ctx.session.firstName = user.fullName?.split(' ')[0] || user.fullName;
    ctx.session.admin = user.admin ? 'true' : 'false';
    logger.info('User found in database', { telegramId, email: user.email });
    return next(); // User found, proceed
  } else {
    // User not found, start registration
    ctx.session.persistentUser = 'no';
    ctx.session.platform = 'telegram';
    ctx.session.step = 'collectFullName';
    logger.info('New user detected. Starting registration.', { telegramId });
    await ctx.reply('Welcome to Q! To get started, please enter your full name:').catch(e => {
      logger.error('Failed to send registration prompt', { error: e.message, telegramId });
    });
    // If it's a callback query, answer it to remove the loading state
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(e => logger.warn('Failed to answer CB query in ensureRegistered', { error: e.message }));
  }
};

// Handle /start to reset session and initiate registration
bot.command('start', async (ctx) => {
  const prisma = getPrisma();
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;
  clearListingSession(ctx); // Reset any existing workflow
  ctx.session.step = null;
  ctx.session.email = null;
  ctx.session.firstName = null;
  ctx.session.persistentUser = 'no';
  ctx.session.platform = 'telegram';
  logger.info('Start command received, resetting session', { telegramId, session: { ...ctx.session } });

  const user = await prisma.users.findUnique({ where: { userId: telegramId } });
  if (user) {
    ctx.session.persistentUser = 'yes';
    ctx.session.email = user.email;
    ctx.session.fullName = user.fullName;
    ctx.session.firstName = user.fullName?.split(' ')[0] || '';
    ctx.session.admin = user.admin ? 'true' : 'false';
    logger.info('User found in database', { telegramId, email: user.email });
    await ctx.reply(`Welcome back to Q, ${ctx.session.firstName}!`);
    return showMainMenu(ctx);
  }

  ctx.session.step = 'collectFullName';
  logger.info('Initialized new user session', { telegramId, session: { ...ctx.session } });
  await ctx.reply(`Welcome to Q! Please enter your full name:`).catch(e => {
    logger.error('Failed to send initial registration prompt', { error: e.message, telegramId });
  });
});

// Handle cases where a user blocks the bot
bot.on('my_chat_member', async (ctx) => {
  const newStatus = ctx.myChatMember.new_chat_member.status;
  logger.info(`User ${ctx.from.id} changed bot status to: ${newStatus}`);
});

bot.hears(/menu/i, async (ctx) => {
  logger.info('Menu command triggered', { telegramId: ctx.from.id });
  clearListingSession(ctx);
  return showMainMenu(ctx);
});

const handleRegistration = async (ctx) => {
  const prisma = getPrisma();
  const text = ctx.message.text;
  const { userId, step } = ctx.session;

  switch (step) {
    case 'collectFullName':
      if (!text.trim()) {
        logger.warn('Empty full name input', { userId });
        return ctx.reply('Please enter a valid full name.');
      }
      ctx.session.fullName = text.trim();
      ctx.session.firstName = text.trim().split(' ')[0] || text.trim();
      ctx.session.step = 'collectEmail';
      logger.info('Advancing to collectEmail', { userId, fullName: ctx.session.fullName });
      return ctx.reply('Great! Now enter your email:');

    case 'collectEmail':
      const email = text.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        logger.warn('Invalid email input', { userId, email });
        return ctx.reply('❌ Invalid email. Try again:');
      }
      const existing = await prisma.users.findFirst({ where: { email } });
      if (existing) {
        logger.warn('Email already used', { userId, email });
        return ctx.reply('❌ Email already used. Enter another one:');
      }
      ctx.session.email = email;
      ctx.session.verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      ctx.session.step = 'verifyCode';
      const payload = {
        name: ctx.session.firstName,
        email: ctx.session.email,
        verification: ctx.session.verificationCode,
      };
      try {
        await axios.post('https://hook.eu2.make.com/1rzify472wbi8lzbkazby3yyb7ot9rhp', payload);
        logger.info('Verification email sent', { userId, email });
      } catch (e) {
        logger.error('Email webhook failed', { error: e.message, userId });
        await ctx.reply('❌ Failed to send verification email. Please try again.');
        ctx.session.step = null;
        return showMainMenu(ctx);
      }
      return ctx.reply('✅ Enter the code sent to your email:');

    case 'verifyCode':
      if (text.trim() !== ctx.session.verificationCode) {
        logger.warn('Incorrect verification code', { userId, input: text.trim() });
        return ctx.reply('❌ Incorrect code. Please try again:');
      }
      try {
        await prisma.users.create({
          data: {
            userId: ctx.session.userId,
            fullName: ctx.session.fullName,
            email: ctx.session.email,
            platform: ctx.session.platform,
            admin: false,
            verified: false,
          },
        });
        ctx.session.step = null;
        ctx.session.persistentUser = 'yes';
        logger.info('User registered', { userId, email: ctx.session.email });
        await ctx.reply("✅ You're now registered!");
        return showMainMenu(ctx);
      } catch (err) {
        logger.error('Failed to register user', { error: err.message, stack: err.stack, userId });
        ctx.session.step = null;
        await ctx.reply('❌ Error registering user. Please start over.');
        return showMainMenu(ctx);
      }

    case 'editFullName':
      const newFullName = text.trim();
      if (newFullName.split(' ').length < 2) {
        logger.warn('Invalid full name input for edit', { userId, input: newFullName });
        return ctx.reply('❌ Please enter at least your first and last name.');
      }
      try {
        await prisma.users.update({
          where: { userId: ctx.session.userId },
          data: { fullName: newFullName },
        });
        ctx.session.fullName = newFullName;
        ctx.session.firstName = newFullName.split(' ')[0];
        ctx.session.step = null;
        await ctx.reply('✅ Your name has been updated successfully!');
        return showMainMenu(ctx);
      } catch (error) {
        logger.error('Error updating user name', { error: error.message, stack: error.stack, userId });
        return ctx.reply('❌ An error occurred while updating your name.');
      }

    case 'editEmail':
      const newEmail = text.trim().toLowerCase();
      const newEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!newEmailRegex.test(newEmail)) {
        logger.warn('Invalid new email input', { userId, email: newEmail });
        return ctx.reply('❌ Invalid email format. Please try again:');
      }
      try {
        const existingUser = await prisma.users.findFirst({ where: { email: newEmail } });
        if (existingUser) {
          logger.warn('New email already in use', { userId, email: newEmail });
          return ctx.reply('❌ This email is already in use. Please enter a different one:');
        }
        ctx.session.newEmail = newEmail;
        ctx.session.verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        ctx.session.step = 'verifyNewEmail';
        const emailPayload = {
          name: ctx.session.firstName,
          email: newEmail,
          verification: ctx.session.verificationCode,
        };
        await axios.post('https://hook.eu2.make.com/1rzify472wbi8lzbkazby3yyb7ot9rhp', emailPayload);
        logger.info('Verification email sent for email change', { userId, newEmail });
        return ctx.reply(`✅ A verification code has been sent to ${newEmail}. Please enter the code:`);
      } catch (error) {
        logger.error('Error during email edit process', { error: error.message, stack: error.stack, userId });
        return ctx.reply('❌ An error occurred. Please try again.');
      }

    case 'verifyNewEmail':
      if (text.trim() !== ctx.session.verificationCode) {
        logger.warn('Incorrect new email verification code', { userId, input: text.trim() });
        return ctx.reply('❌ Incorrect code. Please try again:');
      }
      const oldEmail = ctx.session.email;
      const verifiedNewEmail = ctx.session.newEmail;
      try {
        const subscriptionsToUpdate = await prisma.subscription.findMany({ where: { crew: { has: oldEmail } } });
        const updatePromises = subscriptionsToUpdate.map(sub => {
          const newCrew = sub.crew.map(email => (email === oldEmail ? verifiedNewEmail : email));
          return prisma.subscription.update({ where: { id: sub.id }, data: { crew: newCrew } });
        });
        const userUpdatePromise = prisma.users.update({ where: { userId: ctx.session.userId }, data: { email: verifiedNewEmail } });
        await prisma.$transaction([...updatePromises, userUpdatePromise]);
        ctx.session.email = verifiedNewEmail;
        ctx.session.step = null;
        ctx.session.newEmail = null;
        ctx.session.verificationCode = null;
        await ctx.reply('✅ Your email has been updated successfully!');
        return showMainMenu(ctx);
      } catch (error) {
        logger.error('Error updating user email and crew memberships', { error: error.message, stack: error.stack, userId });
        return ctx.reply('❌ An error occurred while updating your email.');
      }
    default:
      return null;
  }
};

const handleSubscriptionListing = async (ctx) => {
  const text = ctx.message.text;
  const { userId, step } = ctx.session;

  switch (step) {
    case 'enterSlot':
      const slot = parseInt(text.trim());
      if (isNaN(slot) || slot <= 0) {
        logger.warn('Invalid slot input', { userId, input: text });
        return ctx.reply('❌ Enter a valid number of slots.');
      }
      ctx.session.subSlot = slot;
      ctx.session.step = 'shareType';
      logger.info('Set shareType step', { userId, subSlot: slot });
      return ctx.reply('How will you share access?', Markup.inlineKeyboard([
        [Markup.button.callback('Login Details', 'SHARE_LOGIN')],
        [Markup.button.callback('OTP (User contacts you on WhatsApp)', 'SHARE_OTP')],
      ]));

    case 'enterEmail':
      ctx.session.subEmail = text.trim();
      ctx.session.step = 'enterPassword';
      logger.info('Set subEmail', { userId, subEmail: text.trim() });
      return ctx.reply('Enter Subscription Login Password:');

    case 'enterPassword':
      ctx.session.subPassword = text.trim();
      ctx.session.step = 'selectDuration';
      logger.info('Set subPassword', { userId });
      return handleDurationSelection(ctx);

    case 'enterWhatsApp':
      const number = text.trim();
      if (!/^\+\d{10,15}$/.test(number)) {
        logger.warn('Invalid WhatsApp number', { userId, input: number });
        return ctx.reply('❌ Invalid WhatsApp number (e.g., +1234567890). Try again:');
      }
      ctx.session.subEmail = number;
      ctx.session.subPassword = '';
      ctx.session.whatsappNo = number;
      ctx.session.step = 'selectDuration';
      logger.info('Set WhatsApp number', { userId, whatsappNo: number });
      return handleDurationSelection(ctx);

    case 'updateSlots':
      return handleUpdateSlots(ctx, text);

    case 'updateDuration':
      return handleUpdateDuration(ctx, text);

    default:
      return null;
  }
};

bot.on('text', async (ctx, next) => {
  const prisma = getPrisma();
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;
  const text = ctx.message.text;
  logger.info('Received text input', { telegramId, text, step: ctx.session.step });

  // Prioritize registration and listing workflows
  if (await handleRegistration(ctx)) return;
  if (await handleSubscriptionListing(ctx)) return;

  // If not in a specific step, check for registration or handle as a menu command
  if (!ctx.session.step) {
    if (ctx.session.persistentUser !== 'yes') {
      await ensureRegistered(ctx, next); // This will trigger registration if needed
      return;
    }

    // Handle menu options only for registered users
    const menuOptions = ['Join Subscription', 'My Subscriptions', 'Add My Subscription', 'Wallet / Payments', 'Support & FAQs', 'Profile / Settings', 'Admin City (Admins only)'];
    if (menuOptions.includes(text)) {
      clearListingSession(ctx);
      switch (text) {
        case 'Join Subscription': return browseSubscriptionsWorkflow(ctx);
        case 'My Subscriptions': return mySubscriptionsWorkflow(ctx);
        case 'Add My Subscription': return addSubscriptionWorkflow(ctx);
        case 'Wallet / Payments': return ctx.reply('Wallet / Payments: Under construction.');
        case 'Support & FAQs': return showSupportMenu(ctx);
        case 'Profile / Settings': return ctx.reply('Profile / Settings: Under construction.');
        case 'Admin City (Admins only)':
          if (ctx.session.admin !== 'true') {
            return ctx.reply('❌ Access restricted to admins only.');
          }
          return ctx.reply('Admin City: Under construction.');
      }
    }
  }

  if (next) return next();
});

bot.action('BROWSE', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to answer callback query in BROWSE', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return browseSubscriptionsWorkflow(ctx);
});

bot.action(/^BROWSE_CAT_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in BROWSE_CAT', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleBrowseCategorySelection(ctx, category);
});

bot.action(/^BROWSE_SUBCAT_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in BROWSE_SUBCAT', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subcategory = ctx.match[1].replace(/_/g, ' ');
  return handleBrowseSubcategorySelection(ctx, subcategory);
});

bot.action('BROWSE_BACK', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in BROWSE_BACK', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  return browseSubscriptionsWorkflow(ctx);
});

bot.action('BROWSE_PREV', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in BROWSE_PREV', { error: err.message });
  }
  ctx.session.browsePage = Math.max(0, ctx.session.browsePage - 1);
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('BROWSE_NEXT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in BROWSE_NEXT', { error: err.message });
  }
  ctx.session.browsePage += 1;
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('SORT_NEWEST', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SORT_NEWEST', { error: err.message });
  }
  ctx.session.browseSort = 'newest';
  ctx.session.browsePage = 0;
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('SORT_OLDEST', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SORT_OLDEST', { error: err.message });
  }
  ctx.session.browseSort = 'oldest';
  ctx.session.browsePage = 0;
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action(/^SELECT_SUB_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SELECT_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return handleSubscriptionSelection(ctx, subId);
});

bot.action('PAY_SUB', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in PAY_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  return initiatePayment(ctx);
});

bot.action('VERIFY_PAYMENT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in VERIFY_PAYMENT', { error: err.message });
  }
  return verifyPayment(ctx);
});

bot.action('CANCEL_PAYMENT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in CANCEL_PAYMENT', { error: err.message });
  }
  return cancelPayment(ctx);
});

bot.action('BROWSE_SUBS', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to answer callback query in BROWSE_SUBS', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  return browseSubscriptionsWorkflow(ctx);
});

bot.action('MY_SUBS', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in MY_SUBS', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return mySubscriptionsWorkflow(ctx);
});

bot.action('LISTED_SUBS', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in LISTED_SUBS', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  ctx.session.mySubsListPage = 0;
  return showListedSubscriptions(ctx);
});

bot.action('JOINED_SUBS', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in JOINED_SUBS', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  ctx.session.mySubsJoinedPage = 0;
  return showJoinedSubscriptions(ctx);
});

bot.action('LISTED_SUBS_PREV', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    ctx.session.mySubsListPage = Math.max(0, (ctx.session.mySubsListPage || 0) - 1);
    return showListedSubscriptions(ctx);
  } catch (err) {
    logger.error('Failed to handle LISTED_SUBS_PREV', { error: err.message });
  }
});

bot.action('LISTED_SUBS_NEXT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    ctx.session.mySubsListPage = (ctx.session.mySubsListPage || 0) + 1;
    return showListedSubscriptions(ctx);
  } catch (err) {
    logger.error('Failed to handle LISTED_SUBS_NEXT', { error: err.message });
  }
});

bot.action('JOINED_SUBS_PREV', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    ctx.session.mySubsJoinedPage = Math.max(0, (ctx.session.mySubsJoinedPage || 0) - 1);
    return showJoinedSubscriptions(ctx);
  } catch (err) {
    logger.error('Failed to handle JOINED_SUBS_PREV', { error: err.message });
  }
});

bot.action('JOINED_SUBS_NEXT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    ctx.session.mySubsJoinedPage = (ctx.session.mySubsJoinedPage || 0) + 1;
    return showJoinedSubscriptions(ctx);
  } catch (err) {
    logger.error('Failed to handle JOINED_SUBS_NEXT', { error: err.message });
  }
});

bot.action(/^UNLIST_SUB_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in UNLIST_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return unlistSubscription(ctx, subId);
});

bot.action(/^UPDATE_SUB_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in UPDATE_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return updateSubscription(ctx, subId);
});

bot.action(/^UPDATE_SLOTS_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in UPDATE_SLOTS', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  ctx.session.updateSubId = ctx.match[1];
  ctx.session.step = 'updateSlots';
  return ctx.reply('Enter new number of slots:');
});

bot.action(/^UPDATE_SHARE_ACCESS_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in UPDATE_SHARE_ACCESS', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  ctx.session.updateSubId = ctx.match[1];
  ctx.session.step = 'updateShareAccess';
  return ctx.reply(
    'How will you share access?',
    Markup.inlineKeyboard([
      [Markup.button.callback('Login Details', 'SHARE_LOGIN')],
      [Markup.button.callback('OTP (User contacts you on WhatsApp)', 'SHARE_OTP')],
    ])
  );
});

bot.action(/^UPDATE_DURATION_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  ctx.session.updateSubId = ctx.match[1];
  ctx.session.step = 'updateDuration';
  return ctx.reply('Enter new duration (1–12 months):');
});

bot.action(/^RENEW_SUB_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in RENEW_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return renewSubscription(ctx, subId);
});

bot.action(/^LEAVE_SUB_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in LEAVE_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return leaveSubscription(ctx, subId);
});

bot.action(/^CONFIRM_LEAVE_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in CONFIRM_LEAVE', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return leaveSubscription(ctx, subId, true);
});

bot.action(/^CANCEL_LEAVE_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in CANCEL_LEAVE', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return cancelLeaveRequest(ctx, subId);
});

bot.action('ADD_SUB', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in ADD_SUB', { error: err.message });
  }
  if (ctx.session.admin !== 'true') {
    await ctx.deleteMessage().catch(() => {});
    return ctx.reply('❌ Access restricted to admins only.');
  }
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return addSubscriptionWorkflow(ctx);
});

bot.action('REQUEST_SUB', async (ctx) => { // ensureRegistered is applied to this
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in REQUEST_SUB', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  return ctx.reply('This feature is coming soon!');
});

bot.action(/^CATEGORY_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in CATEGORY', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleSubCategorySelection(ctx, category);
});

bot.action(/^SUBCATEGORY_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SUBCATEGORY', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const sub = ctx.match[1].replace(/_/g, ' ');
  return handlePlanSelection(ctx, sub);
});

bot.action(/^PLAN_ID_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in PLAN_ID', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const planId = ctx.match[1];
  const plan = Object.keys(planIdMap).find((p) => planIdMap[p] === planId);
  if (!plan || !subscriptionPrices[plan]) {
    logger.warn('Plan not found', { planId });
    return ctx.reply('❌ Plan not found. Please select again.');
  }

  ctx.session.subPlan = plan;
  ctx.session.subAmount = subscriptionPrices[plan] + 200;
  ctx.session.step = 'enterSlot';
  logger.info('Plan selected', { telegramId: ctx.from.id, plan, subAmount: ctx.session.subAmount });

  const safePlan = escapeMarkdownV2(plan);
  return ctx.reply(
    `You have selected *${safePlan}*\nEnter number of available slots \\(e\\.g\\. 1, 2, 3\\.\\.\\.\\):`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.action('SHARE_LOGIN', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SHARE_LOGIN', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  ctx.session.shareType = 'login';
  ctx.session.step = 'enterEmail';
  logger.info('Set shareType to login', { telegramId: ctx.from.id });
  return ctx.reply('Enter Subscription Login Email:');
});

bot.action('SHARE_OTP', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SHARE_OTP', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  ctx.session.shareType = 'otp';
  ctx.session.step = 'enterWhatsApp';
  logger.info('Set shareType to otp', { telegramId: ctx.from.id });
  return ctx.reply('Enter your WhatsApp number (with country code):');
});

bot.action(/^DURATION_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in DURATION', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  const duration = parseInt(ctx.match[1]);
  if (duration < 1 || duration > 12) {
    logger.warn('Invalid duration selected via button', { telegramId: ctx.from.id, duration });
    return ctx.reply('❌ Invalid duration. Please select a duration between 1 and 12 months.');
  }
  ctx.session.subDuration = duration;
  ctx.session.subId = await generateShortSubId(); // Generate short subId
  ctx.session.step = 'confirmSubscription';
  logger.info('Set duration and subId via button', { telegramId: ctx.from.id, subDuration: duration, subId: ctx.session.subId });

  const safe = (value) => (value ? value.toString().replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;') : 'N/A');
  const htmlMsg =
    `<b>Confirm Subscription:</b>\n\n` +
    `<b>Subscription:</b> ${safe(ctx.session.subPlan)}\n` +
    `<b>Slots:</b> ${safe(ctx.session.subSlot)}\n` +
    `<b>Duration:</b> ${safe(ctx.session.subDuration)} month(s)\n` +
    `<b>Category:</b> ${safe(ctx.session.subCat)}\n` +
    `<b>Subcategory:</b> ${safe(ctx.session.subSubCat)}\n` +
    `<b>Monthly Amount:</b> ₦${safe(ctx.session.subAmount)}\n` +
    `<b>Share Type:</b> ${safe(ctx.session.shareType)}\n` +
    `<b>Login Email/WhatsApp:</b> ${safe(ctx.session.subEmail)}\n` +
    `<b>Password:</b> ${safe(ctx.session.subPassword ? ctx.session.subPassword.slice(0, 3) + '****' : 'N/A')}\n`;

  return ctx.reply(
    htmlMsg,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('Confirm', 'CONFIRM_SUBSCRIPTION')],
          [Markup.button.callback('Cancel', 'CANCEL_SUBSCRIPTION')],
        ],
      },
    }
  );
});

bot.action('RETURN_TO_CATEGORY', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in RETURN_TO_CATEGORY', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  return addSubscriptionWorkflow(ctx);
});

bot.action('RETURN_TO_MAIN_MENU', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in RETURN_TO_MAIN_MENU', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return showMainMenu(ctx);
});

bot.action('MAIN_MENU', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in MAIN_MENU', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return showMainMenu(ctx);
});

bot.action('CONFIRM_SUBSCRIPTION', async (ctx) => {
  const prisma = getPrisma();
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in CONFIRM_SUBSCRIPTION', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  try {
    await prisma.subscription.create({
      data: {
        userId: ctx.session.userId,
        subPlan: ctx.session.subPlan,
        subSlot: parseInt(ctx.session.subSlot),
        subDuration: ctx.session.subDuration.toString(),
        subAmount: ctx.session.subAmount.toString(),
        subEmail: ctx.session.subEmail,
        subPassword: ctx.session.subPassword || '',
        status: 'live',
        subId: ctx.session.subId,
        subCategory: ctx.session.subCat,
        subSubCategory: ctx.session.subSubCat,
        subRemSlot: parseInt(ctx.session.subSlot),
        crew: [],
        shareType: ctx.session.shareType || 'login',
      },
    });
    logger.info(`Subscription ${ctx.session.subId} created for user ${ctx.session.userId}`);
  } catch (err) {
    logger.error('Failed to save subscription', { error: err.message, stack: err.stack });
    await ctx.reply('❌ Error saving subscription. Please try again.');
    clearListingSession(ctx);
    return showMainMenu(ctx);
  }

  clearListingSession(ctx);
  await ctx.reply('✅ Subscription successfully listed and is now live!');
  return showMainMenu(ctx);
});

bot.action('CANCEL_SUBSCRIPTION', ensureRegistered, async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  await ctx.reply('❌ Listing cancelled.');
  return showMainMenu(ctx);
});

bot.action('SUPPORT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in SUPPORT', { error: err.message });
  }
  return showSupportMenu(ctx);
});

bot.action('FAQS', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session.faqPage = 0; // Reset to first page
    return showFaqs(ctx, true);
  } catch (err) {
    logger.error('Failed to answer/handle FAQS action', { error: err.message });
  }
});

bot.action('LIVE_SUPPORT', async (ctx) => {
  try {
    return handleLiveSupport(ctx);
  } catch (err) {
    logger.error('Failed to handle LIVE_SUPPORT action', { error: err.message });
  }
});

bot.action(/^FAQ_Q_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const faqId = ctx.match[1];
    return showFaqAnswer(ctx, faqId);
  } catch (err) {
    logger.error('Failed to handle FAQ_Q action', { error: err.message });
  }
});

bot.action('BACK_TO_FAQS', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    return showFaqs(ctx, true);
  } catch (err) {
    logger.error('Failed to handle BACK_TO_FAQS action', { error: err.message });
  }
});

bot.action('FAQ_PREV', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session.faqPage = Math.max(0, (ctx.session.faqPage || 0) - 1);
    return showFaqs(ctx, true);
  } catch (err) {
    logger.error('Failed to handle FAQ_PREV action', { error: err.message });
  }
});

bot.action('FAQ_NEXT', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session.faqPage = (ctx.session.faqPage || 0) + 1;
    return showFaqs(ctx, true);
  } catch (err) {
    logger.error('Failed to handle FAQ_NEXT action', { error: err.message });
  }
});

bot.action('PROFILE', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in PROFILE', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  return ctx.reply(
    'Profile / Settings:',
    Markup.inlineKeyboard([
      [Markup.button.callback('View Personal Info', 'VIEW_PERSONAL_INFO')],
      [Markup.button.callback('My Subscriptions', 'MY_SUBS')],
      [Markup.button.callback('Request Subscription', 'REQUEST_SUB')],
      [Markup.button.callback('Wallet / Payments', 'WALLET')],
      [Markup.button.callback('Back to Main Menu', 'MAIN_MENU')],
    ])
  );
});

bot.action('ADMIN_CITY', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in ADMIN_CITY', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});
  if (ctx.session.admin !== 'true') {
    return ctx.reply('❌ Access restricted to admins only.');
  }
  return ctx.reply(
    'Welcome to Admin City!',
    Markup.inlineKeyboard([
      [Markup.button.callback('Add Subscription', 'ADD_SUB')],
      [Markup.button.callback('Back to Main Menu', 'MAIN_MENU')],
    ])
  );
});

bot.action('WALLET', ensureRegistered, async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply(
    'Wallet / Payments:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Payment History', 'PAYMENT_HISTORY')],
      [Markup.button.callback('Back to Profile', 'PROFILE')],
    ])
  );
});

bot.action('PAYMENT_HISTORY', ensureRegistered, async (ctx) => {
  const prisma = getPrisma();
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in PAYMENT_HISTORY', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});

  try {
    const payments = await prisma.payment.findMany({
      where: { userId: ctx.session.userId },
      orderBy: { createdAt: 'desc' },
      take: 10, // Limit to the last 10 payments for now
    });

    if (payments.length === 0) {
      return ctx.reply(
        'You have no payment history.',
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'WALLET')]])
      );
    }

    let historyMessage = '<b>Your Recent Payments:</b>\n\n';
    payments.forEach((p) => {
      historyMessage +=
        `<b>Plan:</b> ${p.subPlan}\n` +
        `<b>Amount:</b> ₦${p.amount}\n` +
        `<b>Date:</b> ${p.createdAt.toLocaleDateString()}\n` +
        `<b>Ref:</b> ${p.reference}\n\n`;
    });

    await ctx.reply(historyMessage, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'WALLET')]]),
    });
  } catch (error) {
    logger.error('Error fetching payment history', { error: error.message, stack: error.stack });
    await ctx.reply('❌ An error occurred while fetching your payment history.');
  }
});

bot.action('WALLET', ensureRegistered, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in WALLET', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});

  await ctx.reply(
    'Wallet / Payments:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Payment History', 'PAYMENT_HISTORY')],
      [Markup.button.callback('Back to Profile', 'PROFILE')],
    ])
  );
});

bot.action('PAYMENT_HISTORY', ensureRegistered, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in PAYMENT_HISTORY', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});

  try {
    const payments = await prisma.payment.findMany({
      where: { userId: ctx.session.userId },
      orderBy: { createdAt: 'desc' },
      take: 10, // Limit to the last 10 payments for now
    });

    if (payments.length === 0) {
      return ctx.reply(
        'You have no payment history.',
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'WALLET')]])
      );
    }

    let historyMessage = '<b>Your Recent Payments:</b>\n\n';
    payments.forEach((p) => {
      historyMessage +=
        `<b>Plan:</b> ${p.subPlan}\n` +
        `<b>Amount:</b> ₦${p.amount}\n` +
        `<b>Status:</b> ${p.status.charAt(0).toUpperCase() + p.status.slice(1).replace(/_/g, ' ')}\n` + // Format status
        `<b>Date:</b> ${p.createdAt.toLocaleDateString()}\n` +
        `<b>Ref:</b> ${p.reference}\n\n`;
    });

    await ctx.reply(historyMessage, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'WALLET')]]),
    });
  } catch (error) {
    logger.error('Error fetching payment history', { error: error.message, stack: error.stack });
    await ctx.reply('❌ An error occurred while fetching your payment history.');
  }
});

bot.action('VIEW_PERSONAL_INFO', async (ctx) => {
  const prisma = getPrisma();
  try { // ensureRegistered is applied to this
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in VIEW_PERSONAL_INFO', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});

  try {
    const user = await prisma.users.findUnique({
      where: { userId: ctx.session.userId },
    });

    if (!user) {
      return ctx.reply('❌ Could not find your information. Please try registering again by typing /start.');
    }

    const userInfo =
      `<b>Your Personal Information:</b>\n\n` +
      `<b>Full Name:</b> ${user.fullName}\n` +
      `<b>Email:</b> ${user.email}\n` +
      `<b>User ID:</b> ${user.userId}\n` +
      `<b>Platform:</b> ${user.platform}\n` +
      `<b>Registered on:</b> ${user.createdAt.toDateString()}`;

    await ctx.reply(userInfo, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('Edit Name', 'EDIT_NAME'),
          Markup.button.callback('Edit Email', 'EDIT_EMAIL'),
        ],
        [Markup.button.callback('Back', 'PROFILE')]
      ]),
    });
  } catch (error) {
    logger.error('Error fetching user info in VIEW_PERSONAL_INFO', { error: error.message, stack: error.stack });
    await ctx.reply('❌ An error occurred while fetching your information.');
  }
});

bot.action('EDIT_NAME', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in EDIT_NAME', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});

  ctx.session.step = 'editFullName';
  await ctx.reply('Please enter your new full name:', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'VIEW_PERSONAL_INFO')]]).reply_markup
  });
});

bot.action('EDIT_EMAIL', async (ctx) => {
  try { // ensureRegistered is applied to this
    await ctx.answerCbQuery();
  } catch (err) {
    logger.error('Failed to answer callback query in EDIT_EMAIL', { error: err.message });
  }
  await ctx.deleteMessage().catch(() => {});

  ctx.session.step = 'editEmail';
  await ctx.reply('Please enter your new email address:', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'VIEW_PERSONAL_INFO')]])
      .reply_markup,
  });
});

// Apply the middleware to all callback query actions that require registration
bot.on('callback_query', async (ctx, next) => {
  // Answer the callback query to remove the loading state on the button
  try {
    await ctx.answerCbQuery();
  } catch (err) {
    logger.warn('Failed to answer callback query in middleware', { error: err.message });
  }
  return await ensureRegistered(ctx, next);
});

async function startBot() {
  // Always set up Express middleware and health check
  app.use(express.json());
  app.use(bodyParser.json());

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Add this with your other Express routes
  app.get('/api/test-db', async (req, res) => {
    try {
      const prisma = getPrisma();
      // Simple query to test connection
      const result = await prisma.$queryRaw`SELECT 1 as test`;
      res.json({
        status: 'success',
        database: 'connected',
        result
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        database: 'failed',
        error: error.message
      });
    }
  });

  app.get('/api/debug', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: {
        VERCEL: process.env.VERCEL,
        NODE_ENV: process.env.NODE_ENV,
        HAS_BOT_TOKEN: !!process.env.BOT_TOKEN,
        HAS_DATABASE_URL: !!process.env.DATABASE_URL,
        DATABASE_URL_LENGTH: process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0
      }
    });
  });

  const isVercel = process.env.VERCEL === '1';

  if (isVercel) {
    // Serverless mode for Vercel
    const domain = process.env.VERCEL_URL;

    if (!domain) {
      logger.error('VERCEL_URL environment variable is not set');
      process.exit(1);
    }

    // Remove protocol if present
    const cleanDomain = domain.replace(/^https?:\/\//, '');
    const webhookPath = `/webhook`;
    const webhookUrl = `https://${cleanDomain}${webhookPath}`;

    // Set up webhook middleware
    app.use(webhookPath, (req, res, next) => {
      // Log webhook requests for debugging
      logger.info('Webhook received', {
        path: req.path,
        method: req.method,
        body: req.body
      });
      next();
    });

    app.use(webhookPath, bot.webhookCallback(webhookPath, { secretToken: process.env.SECRET_TOKEN }));

    // Endpoint to set the webhook
    app.get('/api/set-webhook', async (req, res) => {
      try {
        logger.info('Setting webhook', { url: webhookUrl });
        const result = await bot.telegram.setWebhook(webhookUrl, { secret_token: process.env.SECRET_TOKEN });
        logger.info('Webhook set successfully', { result });
        res.status(200).json({
          success: true,
          message: 'Webhook set successfully!',
          webhookUrl
        });
      } catch (error) {
        logger.error('Failed to set webhook', { error: error.message, stack: error.stack });
        res.status(500).json({
          success: false,
          message: 'Failed to set webhook',
          error: error.message
        });
      }
    });

    // Endpoint to get webhook info
    app.get('/api/webhook-info', async (req, res) => {
      try {
        const info = await bot.telegram.getWebhookInfo();
        res.status(200).json({ success: true, webhookInfo: info });
      } catch (error) {
        logger.error('Failed to get webhook info', { error: error.message });
        res.status(500).json({
          success: false,
          message: 'Failed to get webhook info',
          error: error.message
        });
      }
    });

    // Delete webhook endpoint (for debugging)
    app.get('/api/delete-webhook', async (req, res) => {
      try {
        const result = await bot.telegram.deleteWebhook();
        res.status(200).json({ success: true, message: 'Webhook deleted', result });
      } catch (error) {
        logger.error('Failed to delete webhook', { error: error.message });
        res.status(500).json({
          success: false,
          message: 'Failed to delete webhook',
          error: error.message
        });
      }
    });

    // A simple landing page for the bot's URL
    app.get('/', (req, res) => {
      res.send(`
        <html>
          <head><title>Q Bot</title></head>
          <body>
            <h1>Hello! I am the Q Bot.</h1>
            <p>Find me on Telegram.</p>
            <ul>
              <li><a href="/health">Health Check</a></li>
              <li><a href="/api/set-webhook">Set Webhook</a></li>
              <li><a href="/api/webhook-info">Webhook Info</a></li>
            </ul>
          </body>
        </html>
      `);
    });

    logger.info(`Bot configured for Vercel. Webhook URL: ${webhookUrl}`);

    // Set webhook on startup
    try {
      logger.info('Attempting to set webhook on startup...');
      await bot.telegram.setWebhook(webhookUrl, { secret_token: process.env.SECRET_TOKEN });
      logger.info('Webhook set successfully on startup');
    } catch (error) {
      logger.error('Failed to set webhook on startup', { error: error.message });
    }
  } else {
    // Development mode (long polling)
    logger.info('Starting bot in long-polling mode...');
    await bot.launch();
    logger.info('Bot started successfully in development mode.');
  }
}

startBot().catch((err) => logger.error('Failed to start bot', { error: err.message, stack: err.stack }));

// Export the app for serverless environments
export default app;