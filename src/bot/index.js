import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import safeSession from '../middlewares/session.js';
import { prisma } from '../db/client.js';
import { showMainMenu } from '../utils/menu.js';
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
import subscriptionPrices, { planIdMap } from '../utils/subscription-prices.js';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// Middleware to check for missing headers
app.use((req, res, next) => {
  if (!req.headers['content-type'] && !req.headers['transfer-encoding']) {
    logger.warn('Missing content-type or transfer-encoding', { url: req.url });
    return res.status(400).send('Bad Request: Missing content-type or transfer-encoding');
  }
  next();
});

// Use body-parser with error handling
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString());
    } catch (e) {
      logger.error('Invalid JSON in request', { error: e.message });
      res.status(400).send('Invalid JSON');
      throw e;
    }
  }
}));

// Telegraf webhook
app.use(bot.webhookCallback('/'));

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error', { error: err.message, stack: err.stack });
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

bot.use(safeSession());
startCronJobs();

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
    await ctx.reply('⏳ You were inactive for a while. Back to Main Menu.');
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
  if (!text) return 'N/A';
  return text
    .toString()
    .replace(/([_\*\[\]\(\)\~`>\#\+\-\=\|\{\}\.\!\\])/g, '\\$1');
}

async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }
      return response;
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
async function ensureRegistered(ctx, callback) {
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;

  if (ctx.session.persistentUser === 'yes' && ctx.session.email) {
    return callback();
  }

  const user = await prisma.users.findUnique({ where: { userId: telegramId } });
  if (user) {
    ctx.session.persistentUser = 'yes';
    ctx.session.email = user.email;
    ctx.session.firstName = user.fullName?.split(' ')[0] || '';
    ctx.session.admin = user.admin ? 'true' : 'false';
    logger.info('User found in database', { telegramId, email: user.email });
    return callback();
  }

  ctx.session.persistentUser = 'no';
  ctx.session.platform = 'telegram';
  ctx.session.step = 'collectFullName';
  logger.info('Initialized new user session for action', { telegramId, session: { ...ctx.session } });
  await ctx.reply('Welcome to Q! Please enter your full name to register:');
  await ctx.answerCbQuery();
}

// Handle /start to reset session and initiate registration
bot.command('start', async (ctx) => {
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
    ctx.session.firstName = user.fullName?.split(' ')[0] || '';
    ctx.session.admin = user.admin ? 'true' : 'false';
    logger.info('User found in database', { telegramId, email: user.email });
    await ctx.reply(`Welcome back to Q, ${ctx.session.firstName}!`);
    return showMainMenu(ctx);
  }

  ctx.session.step = 'collectFullName';
  logger.info('Initialized new user session', { telegramId, session: { ...ctx.session } });
  await ctx.reply(`Welcome to Q! Please enter your full name:`);
});

bot.on('text', async (ctx, next) => {
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;
  const text = ctx.message.text;
  logger.info('Received text input', { telegramId, text, step: ctx.session.step, session: { ...ctx.session } });

  // Handle registration steps
  if (ctx.session.step === 'collectFullName') {
    if (!text.trim()) {
      logger.warn('Empty full name input', { telegramId });
      return ctx.reply('Please enter a valid full name.');
    }
    ctx.session.fullName = text.trim();
    ctx.session.firstName = text.trim().split(' ')[0] || text.trim();
    ctx.session.step = 'collectEmail';
    logger.info('Advancing to collectEmail', { telegramId, fullName: ctx.session.fullName, session: { ...ctx.session } });
    return ctx.reply('Great! Now enter your email:');
  }

  if (ctx.session.step === 'collectEmail') {
    const email = text.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      logger.warn('Invalid email input', { telegramId, email });
      return ctx.reply('❌ Invalid email. Try again:');
    }
    const existing = await prisma.users.findFirst({ where: { email } });
    if (existing) {
      logger.warn('Email already used', { telegramId, email });
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
      logger.info('Verification email sent', { telegramId, email });
    } catch (e) {
      logger.error('Email webhook failed', { error: e.message, telegramId });
      await ctx.reply('❌ Failed to send verification email. Please try again.');
      ctx.session.step = null;
      return showMainMenu(ctx);
    }
    return ctx.reply('✅ Enter the code sent to your email:');
  }

  if (ctx.session.step === 'verifyCode') {
    if (text.trim() !== ctx.session.verificationCode) {
      logger.warn('Incorrect verification code', { telegramId, input: text.trim() });
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
          verified: false, // Set verified to false for new users
        },
      });
      ctx.session.step = null;
      ctx.session.persistentUser = 'yes'; // Mark user as registered
      logger.info('User registered', { telegramId, email: ctx.session.email });
      await ctx.reply("✅ You're now registered!");
      return showMainMenu(ctx);
    } catch (err) {
      logger.error('Failed to register user', { error: err.message, stack: err.stack, telegramId });
      ctx.session.step = null;
      await ctx.reply('❌ Error registering user. Please start over.');
      return showMainMenu(ctx);
    }
  }

  // Check registration status before handling menu options
  if (!ctx.session.step && !ctx.session.email) {
    const user = await prisma.users.findUnique({ where: { userId: telegramId } });
    if (user) {
      ctx.session.persistentUser = 'yes';
      ctx.session.email = user.email;
      ctx.session.firstName = user.fullName?.split(' ')[0] || '';
      ctx.session.admin = user.admin ? 'true' : 'false';
      logger.info('User found in database', { telegramId, email: user.email });
      await ctx.reply(`Welcome back to Q, ${ctx.session.firstName}!`);
      return showMainMenu(ctx);
    } else {
      ctx.session.persistentUser = 'no';
      ctx.session.platform = 'telegram';
      ctx.session.step = 'collectFullName';
      logger.info('Initialized new user session', { telegramId, session: { ...ctx.session } });
      await ctx.reply(`Welcome to Q! Please enter your full name:`);
      return;
    }
  }

  // Handle menu options only for registered users
  if (ctx.session.persistentUser === 'yes' && ['Browse Subscriptions', 'My Subscriptions', 'Add My Subscription', 'Wallet / Payments', 'Support & FAQs', 'Profile / Settings', 'Admin City (Admins only)'].includes(text)) {
    clearListingSession(ctx);
    switch (text) {
      case 'Browse Subscriptions':
        return browseSubscriptionsWorkflow(ctx);
      case 'My Subscriptions':
        return mySubscriptionsWorkflow(ctx);
      case 'Add My Subscription':
        return addSubscriptionWorkflow(ctx);
      case 'Wallet / Payments':
        return ctx.reply('Wallet / Payments: Under construction.');
      case 'Support & FAQs':
        return ctx.reply('Support & FAQs: Under construction.');
      case 'Profile / Settings':
        return ctx.reply('Profile / Settings: Under construction.');
      case 'Admin City (Admins only)':
        if (ctx.session.admin !== 'true') {
          return ctx.reply('❌ Access restricted to admins only.');
        }
        return ctx.reply('Admin City: Under construction.');
    }
  }

  // Handle subscription-related steps
  if (ctx.session.step === 'enterSlot') {
    const slot = parseInt(text.trim());
    if (isNaN(slot) || slot <= 0) {
      logger.warn('Invalid slot input', { telegramId, input: text });
      return ctx.reply('❌ Enter a valid number of slots.');
    }
    ctx.session.subSlot = slot;
    ctx.session.step = 'shareType';
    logger.info('Set shareType step', { telegramId, subSlot: slot });
    return ctx.reply(
      'How will you share access?',
      Markup.inlineKeyboard([
        [Markup.button.callback('Login Details', 'SHARE_LOGIN')],
        [Markup.button.callback('OTP (User contacts you on WhatsApp)', 'SHARE_OTP')],
      ])
    );
  }

  if (ctx.session.step === 'enterEmail') {
    ctx.session.subEmail = text.trim();
    ctx.session.step = 'enterPassword';
    logger.info('Set subEmail', { telegramId, subEmail: text.trim() });
    return ctx.reply('Enter Subscription Login Password:');
  }

  if (ctx.session.step === 'enterPassword') {
    ctx.session.subPassword = text.trim();
    ctx.session.step = 'selectDuration';
    logger.info('Set subPassword', { telegramId });
    return ctx.reply(
      'Enter listing monthly duration (1–12):',
      Markup.inlineKeyboard(
        [...Array(12)].map((_, i) => [Markup.button.callback(`${i + 1}`, `DURATION_${i + 1}`)])
      )
    );
  }

  if (ctx.session.step === 'enterWhatsApp') {
    const number = text.trim();
    if (!/^\+\d{10,15}$/.test(number)) {
      logger.warn('Invalid WhatsApp number', { telegramId, input: number });
      return ctx.reply('❌ Invalid WhatsApp number (e.g., +1234567890). Try again:');
    }
    ctx.session.subEmail = number;
    ctx.session.subPassword = '';
    ctx.session.whatsappNo = number;
    ctx.session.step = 'selectDuration';
    logger.info('Set WhatsApp number', { telegramId, whatsappNo: number });
    return ctx.reply(
      'Enter duration (1–12):',
      Markup.inlineKeyboard(
        [...Array(12)].map((_, i) => [Markup.button.callback(`${i + 1}`, `DURATION_${i + 1}`)])
      )
    );
  }

  if (ctx.session.step === 'updateSlots') {
    return handleUpdateSlots(ctx, text);
  }

  if (ctx.session.step === 'updateDuration') {
    return handleUpdateDuration(ctx, text);
  }

  if (next) return next();
});

bot.action('BROWSE', async (ctx) => {
  await ensureRegistered(ctx, async () => {
    clearListingSession(ctx);
    return browseSubscriptionsWorkflow(ctx);
  });
});

bot.action(/^BROWSE_CAT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleBrowseCategorySelection(ctx, category);
});

bot.action(/^BROWSE_SUBCAT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subcategory = ctx.match[1].replace(/_/g, ' ');
  return handleBrowseSubcategorySelection(ctx, subcategory);
});

bot.action('BROWSE_BACK', async (ctx) => {
  await ctx.answerCbQuery();
  return browseSubscriptionsWorkflow(ctx);
});

bot.action('BROWSE_PREV', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.browsePage = Math.max(0, ctx.session.browsePage - 1);
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('BROWSE_NEXT', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.browsePage += 1;
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('SORT_NEWEST', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.browseSort = 'newest';
  ctx.session.browsePage = 0;
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('SORT_OLDEST', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.browseSort = 'oldest';
  ctx.session.browsePage = 0;
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action('SORT_VERIFIED', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.browseSort = 'verified';
  ctx.session.browsePage = 0;
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory);
});

bot.action(/^SELECT_SUB_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return handleSubscriptionSelection(ctx, subId);
});

bot.action('PAY_SUB', async (ctx) => {
  await ctx.answerCbQuery();
  return initiatePayment(ctx);
});

bot.action('VERIFY_PAYMENT', async (ctx) => {
  await ctx.answerCbQuery();
  return verifyPayment(ctx);
});

bot.action('CANCEL_PAYMENT', async (ctx) => {
  await ctx.answerCbQuery();
  return cancelPayment(ctx);
});

bot.action('BROWSE_SUBS', async (ctx) => {
  await ensureRegistered(ctx, async () => {
    return browseSubscriptionsWorkflow(ctx);
  });
});

bot.action('MY_SUBS', async (ctx) => {
  await ctx.answerCbQuery();
  clearListingSession(ctx);
  return mySubscriptionsWorkflow(ctx);
});

bot.action('LISTED_SUBS', async (ctx) => {
  await ctx.answerCbQuery();
  return showListedSubscriptions(ctx);
});

bot.action('JOINED_SUBS', async (ctx) => {
  await ctx.answerCbQuery();
  return showJoinedSubscriptions(ctx);
});

bot.action(/^UNLIST_SUB_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return unlistSubscription(ctx, subId);
});

bot.action(/^UPDATE_SUB_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return updateSubscription(ctx, subId);
});

bot.action(/^RENEW_SUB_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return renewSubscription(ctx, subId);
});

bot.action(/^LEAVE_SUB_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return leaveSubscription(ctx, subId);
});

bot.action(/^CONFIRM_LEAVE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return leaveSubscription(ctx, subId, true);
});

bot.action(/^CANCEL_LEAVE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const subId = ctx.match[1];
  return cancelLeaveRequest(ctx, subId);
});

bot.action('ADD_SUB', async (ctx) => {
  await ensureRegistered(ctx, async () => {
    clearListingSession(ctx);
    return addSubscriptionWorkflow(ctx);
  });
});

bot.action(/^CATEGORY_(.+)$/, async (ctx) => {
  await ensureRegistered(ctx, async () => {
    const category = ctx.match[1].replace(/_/g, ' ');
    return handleSubCategorySelection(ctx, category);
  });
});

bot.action(/^SUBCATEGORY_(.+)$/, async (ctx) => {
  await ensureRegistered(ctx, async () => {
    const sub = ctx.match[1].replace(/_/g, ' ');
    return handlePlanSelection(ctx, sub);
  });
});

bot.action(/^PLAN_ID_(.+)$/, async (ctx) => {
  await ensureRegistered(ctx, async () => {
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
});

bot.action('SHARE_LOGIN', async (ctx) => {
  await ensureRegistered(ctx, async () => {
    ctx.session.shareType = 'login';
    ctx.session.step = 'enterEmail';
    logger.info('Set shareType to login', { telegramId: ctx.from.id });
    return ctx.reply('Enter Subscription Login Email:');
  });
});

bot.action('SHARE_OTP', async (ctx) => {
  await ensureRegistered(ctx, async () => {
    ctx.session.shareType = 'otp';
    ctx.session.step = 'enterWhatsApp';
    logger.info('Set shareType to otp', { telegramId: ctx.from.id });
    return ctx.reply('Enter your WhatsApp number (with country code):');
  });
});

bot.action('RETURN_TO_CATEGORY', async (ctx) => {
  await ctx.answerCbQuery();
  return addSubscriptionWorkflow(ctx);
});

bot.action('RETURN_TO_MAIN_MENU', async (ctx) => {
  await ctx.answerCbQuery();
  clearListingSession(ctx);
  return showMainMenu(ctx);
});

bot.action('CONFIRM_SUBSCRIPTION', async (ctx) => {
  await ensureRegistered(ctx, async () => {
    const escape = escapeMarkdownV2;
    const safe = (value) => escape(value?.toString());

    const markdownMsg =
      `*New Subscription Request:*\n\n` +
      `**Subscription ID:** ${safe(ctx.session.subId)}\n` +
      `**User ID:** ${safe(ctx.session.userId)}\n` +
      `**Subscription:** ${safe(ctx.session.subPlan)}\n` +
      `**Slots:** ${safe(ctx.session.subSlot)}\n` +
      `**Duration:** ${safe(ctx.session.subDuration)}\n` +
      `**Category:** ${safe(ctx.session.subCat)}\n` +
      `**Subcategory:** ${safe(ctx.session.subSubCat)}\n` +
      `**Monthly Amount:** ₦${safe(ctx.session.subAmount)}\n` +
      `**Login Email/WhatsApp:** ${safe(ctx.session.subEmail)}\n` +
      `**Password:** ${safe(ctx.session.subPassword ? ctx.session.subPassword.slice(0, 3) + '****' : 'N/A')}\n` +
      `**Time:** ${safe(new Date().toISOString())}\n`;

    const htmlMsg =
      `<b>New Subscription Request:</b>\n\n` +
      `<b>Subscription ID:</b> ${ctx.session.subId || 'N/A'}\n` +
      `<b>User ID:</b> ${ctx.session.userId || 'N/A'}\n` +
      `<b>Subscription:</b> ${ctx.session.subPlan || 'N/A'}\n` +
      `<b>Slots:</b> ${ctx.session.subSlot || 'N/A'}\n` +
      `<b>Duration:</b> ${ctx.session.subDuration || 'N/A'} month(s)\n` +
      `<b>Category:</b> ${ctx.session.subCat || 'N/A'}\n` +
      `<b>Subcategory:</b> ${ctx.session.subSubCat || 'N/A'}\n` +
      `<b>Monthly Amount:</b> ₦${ctx.session.subAmount || 'N/A'}\n` +
      `<b>Login Email/WhatsApp:</b> ${ctx.session.subEmail || 'N/A'}\n` +
      `<b>Password:</b> ${ctx.session.subPassword ? ctx.session.subPassword.slice(0, 3) + '****' : 'N/A'}\n` +
      `<b>Time:</b> ${new Date().toISOString()}\n`;

    const apiUrl = `https://api.telegram.org/bot${process.env.PREVIEW_BOT_TOKEN}/sendMessage`;
    const chatId = process.env.ADMIN_CHAT_ID || '6632021617';
    let notificationFailed = false;

    try {
      await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: markdownMsg, parse_mode: 'MarkdownV2' }),
      });
    } catch (err) {
      logger.error(`Failed to send MarkdownV2 to chat ID ${chatId}`, { error: err.message, message: markdownMsg });
      try {
        await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: htmlMsg, parse_mode: 'HTML' }),
        });
      } catch (htmlErr) {
        logger.error(`Failed to send HTML to chat ID ${chatId}`, { error: htmlErr.message, message: htmlMsg });
        notificationFailed = true;
      }
    }

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
          status: 'pending',
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
    if (!notificationFailed) {
      await ctx.reply('✅ Subscription sent to Q!');
    } else {
      await ctx.reply('✅ Subscription saved, but listing notification failed.');
    }
    return showMainMenu(ctx);
  });
});

bot.action('CANCEL_SUBSCRIPTION', async (ctx) => {
  await ctx.answerCbQuery();
  clearListingSession(ctx);
  await ctx.reply('❌ Listing cancelled.');
  return showMainMenu(ctx);
});

bot.action('WALLET', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Wallet / Settings: Under construction!');
});

bot.action('SUPPORT', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Support & FAQs: Under construction!');
});

bot.action('PROFILE', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Profile / Settings: Under construction!');
});

bot.action('ADMIN_CITY', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.session.admin !== 'true') {
    return ctx.reply('❌ Access restricted to admins only.');
  }
  return ctx.reply('Admin City: Under construction.');
});

if (process.env.RENDER === 'true') {
  app.get('/', (req, res) => {
    res.send('🤖');
  });
  const port = parseInt(process.env.PORT) || 3000;
  const webhookUrl = process.env.RENDER_EXTERNAL_URL || 'https://q-bot-01ay.onrender.com';
  if (!webhookUrl.startsWith('https://')) {
    logger.error('Webhook URL must be HTTPS', { webhookUrl });
    process.exit(1);
  }
  app.listen(port, () => {
    logger.info(`✅ Bot running on port ${port}`);
    bot.telegram.setWebhook(webhookUrl).then(() => {
      logger.info(`Webhook set to ${webhookUrl}`);
    }).catch((err) => {
      logger.error('Webhook set failed', { error: err.message });
    });
  });
} else {
  bot.launch();
  logger.info('✅ Bot running locally');
}