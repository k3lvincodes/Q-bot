// src/bot/index.js
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import safeSession from '../middlewares/session.js';
import { prisma } from '../db/client.js';
import { showMainMenu } from '../utils/menu.js';
import axios from 'axios';
import fetch from 'node-fetch';
import {
  addSubscriptionWorkflow,
  handleSubCategorySelection,
  handlePlanSelection
} from './workflows/add-subscription.js';
import subscriptionPrices, { planIdMap } from '../utils/subscription-prices.js';

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
      if (i === retries - 1) throw err;
      console.warn(`Retry ${i + 1}/${retries} for ${url}:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function escapeMarkdownV2(text) {
  if (!text) return 'N/A';
  return text
    .toString()
    .replace(/([_\*\[\]\(\)\~`>\#\+\-\=\|\{\}\.\!\\])/g, '\\$1');
}

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(safeSession());

// Inactivity middleware
bot.use(async (ctx, next) => {
  const now = Date.now();
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
}

bot.on('text', async (ctx, next) => {
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;
  const text = ctx.message.text;

  if (text === 'List Another Subscription') {
    clearListingSession(ctx);
    return addSubscriptionWorkflow(ctx);
  }

  if (text === 'Go to Main Menu') {
    clearListingSession(ctx);
    return showMainMenu(ctx);
  }

  if (!ctx.session.email) {
    const user = await prisma.users.findUnique({ where: { userId: telegramId } });
    if (user) {
      ctx.session.persistentUser = 'yes';
      ctx.session.email = user.email;
      ctx.session.firstName = user.fullName?.split(' ')[0] || '';
      ctx.session.admin = user.admin ? 'yes' : 'no';
      await ctx.reply(`Welcome back to Q by Cratebux ${ctx.session.firstName}!`);
      return showMainMenu(ctx);
    } else {
      ctx.session.persistentUser = 'no';
      ctx.session.platform = 'telegram';
      await ctx.reply(`Welcome to Q! Please enter your full name:`);
      ctx.session.step = 'collectFullName';
      return;
    }
  }

  if (ctx.session.step === 'collectFullName') {
    if (!text.trim().includes(' ')) return ctx.reply('Please enter your full name (first and last).');
    ctx.session.fullName = text.trim();
    ctx.session.firstName = text.trim().split(' ')[0];
    ctx.session.step = 'collectEmail';
    return ctx.reply('Great! Now enter your email:');
  }

  if (ctx.session.step === 'collectEmail') {
    const email = text.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return ctx.reply('❌ Invalid email. Try again:');
    const existing = await prisma.users.findFirst({ where: { email } });
    if (existing) return ctx.reply('❌ Email already used. Enter another one:');
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
    } catch (e) {
      console.error('Email webhook failed:', e.message);
      await ctx.reply('❌ Failed to send verification email. Please try again.');
      return showMainMenu(ctx);
    }
    return ctx.reply('✅ Enter the code sent to your email:');
  }

  if (ctx.session.step === 'verifyCode') {
    if (text.trim() !== ctx.session.verificationCode) {
      return ctx.reply('❌ Incorrect code. Please try again:');
    }
    await prisma.users.create({
      data: {
        userId: ctx.session.userId,
        fullName: ctx.session.fullName,
        email: ctx.session.email,
        platform: ctx.session.platform,
        admin: false,
      },
    });
    ctx.session.step = null;
    await ctx.reply("✅ You're now registered!");
    return showMainMenu(ctx);
  }

  if (ctx.session.step === 'enterSlot') {
    const slot = parseInt(text.trim());
    if (isNaN(slot) || slot <= 0) return ctx.reply('❌ Enter a valid number of slots.');
    ctx.session.subSlot = slot;
    ctx.session.step = 'shareType';
    return ctx.reply('How will you share access?', Markup.keyboard(['Login Details', 'OTP (User contacts you on WhatsApp)']).oneTime().resize());
  }

  if (ctx.session.step === 'shareType') {
    const type = text.trim();
    if (type === 'Login Details') {
      ctx.session.shareType = 'login';
      ctx.session.step = 'enterEmail';
      return ctx.reply('Enter Subscription Login Email:');
    } else if (type === 'OTP (User contacts you on WhatsApp)') {
      ctx.session.shareType = 'otp';
      ctx.session.step = 'enterWhatsApp';
      return ctx.reply('Enter your WhatsApp number (with country code):');
    } else {
      return ctx.reply('❌ Invalid choice.');
    }
  }

  if (ctx.session.step === 'enterEmail') {
    ctx.session.subEmail = text.trim();
    ctx.session.step = 'enterPassword';
    return ctx.reply('Enter Subscription Login Password:');
  }

  if (ctx.session.step === 'enterPassword') {
    ctx.session.subPassword = text.trim();
    ctx.session.step = 'selectDuration';
    return ctx.reply('Enter listing monthly duration (1–12):', Markup.keyboard([...Array(12)].map((_, i) => `${i + 1}`)).oneTime().resize());
  }

  if (ctx.session.step === 'enterWhatsApp') {
    const number = text.trim();
    const phoneRegex = /^\+\d{10,15}$/;
    if (!phoneRegex.test(number)) return ctx.reply('❌ Invalid WhatsApp number (e.g., +1234567890). Try again:');
    ctx.session.subEmail = number;
    ctx.session.subPassword = number;
    ctx.session.whatsappNo = number;
    ctx.session.step = 'selectDuration';
    return ctx.reply('Enter listing monthly duration (1–12):', Markup.keyboard([...Array(12)].map((_, i) => `${i + 1}`)).oneTime().resize());
  }

  if (ctx.session.step === 'selectDuration') {
    const months = parseInt(text.trim());
    if (isNaN(months) || months < 1 || months > 12) return ctx.reply('❌ Choose between 1–12 months.');
    ctx.session.subDuration = months;

    const generateRandomCode = () => {
      return 'Q_' + Math.random().toString(36).substring(2, 7).toUpperCase();
    };

    let subId;
    let existing;
    do {
      subId = generateRandomCode();
      existing = await prisma.subscription.findMany({ where: { subId } });
    } while (existing.length > 0);

    ctx.session.subId = subId;

    const escape = escapeMarkdownV2;
    const safe = (value) => escape(value?.toString()); // Ensure string conversion
    // Log session data for debugging
    console.log('Session data for confirmation:', {
      subId: ctx.session.subId,
      subPlan: ctx.session.subPlan,
      subSlot: ctx.session.subSlot,
      subDuration: ctx.session.subDuration,
      subCat: ctx.session.subCat,
      subSubCat: ctx.session.subSubCat,
      subAmount: ctx.session.subAmount,
      subEmail: ctx.session.subEmail,
      subPassword: ctx.session.subPassword,
      whatsappNo: ctx.session.whatsAppNo,
      shareType: ctx.session.shareType
    });

    const msg =
      `*Confirm Your Subscription Details:*\n\n` +
      `**Subscription ID:** ${safe(ctx.session.subId)}\n` +
      `**Subscription Name:** ${safe(ctx.session.subPlan)}\n` +
      `**Slots:** ${safe(ctx.session.subSlot)}\n` +
      `**Duration:** ${safe(ctx.session.subDuration)} month(s)\n` +
      `**Category:** ${safe(ctx.session.subCat)}\n` +
      `**Subcategory:** ${safe(ctx.session.subSubCat)}\n` +
      `**Monthly Amount:** ₦${safe(ctx.session.subAmount)}\n` +
      `**Login Email/WhatsApp:** ${safe(ctx.session.subEmail)}\n` +
      `**Password:** ${safe(ctx.session.subPassword)}\n` +
      (ctx.session.shareType === 'otp' ? `**WhatsApp Number:** ${safe(ctx.session.whatsappNo)}\n` : '') +
      `Please review and confirm or cancel.`;

    ctx.session.step = 'confirmSubscription';
    try {
      await ctx.reply(msg, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Confirm', 'CONFIRM_SUBSCRIPTION')],
          [Markup.button.callback('Cancel', 'CANCEL_SUB')]
        ])
      });
    } catch (err) {
      console.error('Failed to send confirmation message:', err.message, 'Message:', msg);
      // Fallback to plain text
      const plainMsg =
        `Confirm Your Subscription Details:\n\n` +
        `Subscription ID: ${ctx.session.subId}\n` +
        `Subscription Name: ${ctx.session.subPlan}\n` +
        `Slots: ${ctx.session.subSlot}\n` +
        `Duration: ${ctx.session.subDuration} month(s)\n` +
        `Category: ${ctx.session.subCat}\n` +
        `Subcategory: ${ctx.session.subSubCat}\n` +
        `Monthly Amount: ₦${ctx.session.subAmount}\n` +
        `Login Email/WhatsApp: ${ctx.session.subEmail}\n` +
        `Password: ${ctx.session.subPassword}\n` +
        (ctx.session.shareType === 'otp' ? `WhatsApp Number: ${ctx.session.whatsappNo}\n` : '') +
        `Please review and confirm or cancel.`;
      await ctx.reply(plainMsg, Markup.inlineKeyboard([
        [Markup.button.callback('Confirm', 'CONFIRM_SUBSCRIPTION')],
        [Markup.button.callback('Cancel', 'CANCEL_SUB')]
      ]));
    }
  }

  if (next) return next();
});

bot.action('ADD_SUB', async (ctx) => {
  await ctx.answerCbQuery();
  return addSubscriptionWorkflow(ctx);
});

bot.action(/^CATEGORY_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleSubCategorySelection(ctx, category);
});

bot.action(/^SUBCATEGORY_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sub = ctx.match[1].replace(/_/g, ' ');
  return handlePlanSelection(ctx, sub);
});

bot.action(/^PLAN_ID_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const planId = ctx.match[1];
  const plan = Object.keys(planIdMap).find((p) => planIdMap[p] === planId);
  if (!plan || !subscriptionPrices[plan]) {
    return ctx.reply('❌ Plan not found. Please select again.');
  }

  ctx.session.subPlan = plan;
  ctx.session.subAmount = subscriptionPrices[plan] + 200;
  ctx.session.step = 'enterSlot';

  const safePlan = escapeMarkdownV2(plan);
  return ctx.reply(
    `You have selected *${safePlan}*\nEnter number of available slots \\(e\\.g\\. 1, 2, 3\\.\\.\\.\\):`,
    { parse_mode: 'MarkdownV2' }
  );
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
  await ctx.answerCbQuery();
  const escape = escapeMarkdownV2;
  const safe = (value) => escape(value?.toString());

  const markdownMsg =
    `*New Subscription Request:*\n\n` +
    `**Subscription ID:** ${safe(ctx.session.subId)}\n` +
    `**User ID:** ${safe(ctx.session.userId)}\n` +
    `**Subscription:** ${safe(ctx.session.subPlan)}\n` +
    `**Slots:** ${safe(ctx.session.subSlot)}\n` +
    `**Duration:** ${safe(ctx.session.subDuration)} month(s)\n` +
    `**Category:** ${safe(ctx.session.subCat)}\n` +
    `**Subcategory:** ${safe(ctx.session.subSubCat)}\n` +
    `**Monthly Amount:** ₦${safe(ctx.session.subAmount)}\n` +
    `**Login Email/WhatsApp:** ${safe(ctx.session.subEmail)}\n` +
    `**Password:** ${safe(ctx.session.subPassword.slice(0, 3) + '****')}\n` +
    `**Time:** ${safe(new Date().toISOString())}\n`;

  const htmlMsg =
    `<b>New Subscription Request:</b><br><br>` +
    `<b>Subscription ID:</b> ${ctx.session.subId || 'N/A'}<br>` +
    `<b>User ID:</b> ${ctx.session.userId || 'N/A'}<br>` +
    `<b>Subscription:</b> ${ctx.session.subPlan || 'N/A'}<br>` +
    `<b>Slots:</b> ${ctx.session.subSlot || 'N/A'}<br>` +
    `<b>Duration:</b> ${ctx.session.subDuration || 'N/A'} month(s)<br>` +
    `<b>Category:</b> ${ctx.session.subCat || 'N/A'}<br>` +
    `<b>Subcategory:</b> ${ctx.session.subSubCat || 'N/A'}<br>` +
    `<b>Monthly Amount:</b> ₦${ctx.session.subAmount || 'N/A'}<br>` +
    `<b>Login Email/WhatsApp:</b> ${ctx.session.subEmail || 'N/A'}<br>` +
    `<b>Password:</b> ${ctx.session.subPassword ? ctx.session.subPassword.slice(0, 3) + '****' : 'N/A'}<br>` +
    `<b>Time:</b> ${new Date().toISOString()}<br>`;

  const apiUrl = `https://api.telegram.org/bot${process.env.PREVIEW_BOT_TOKEN}/sendMessage`;
  const chatIds = process.env.ADMIN_CHAT_IDS ? process.env.ADMIN_CHAT_IDS.split(',') : ['6632021617', '7193164208'];
  let notificationFailed = false;

  for (const chatId of chatIds) {
    try {
      await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: markdownMsg, parse_mode: 'MarkdownV2' }),
      });
    } catch (err) {
      console.error(`Failed to send MarkdownV2 to chat ID ${chatId}:`, err.message, 'Message:', markdownMsg);
      try {
        await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: htmlMsg, parse_mode: 'HTML' }),
        });
      } catch (htmlErr) {
        console.error(`Failed to send HTML to chat ID ${chatId}:`, htmlErr.message, 'Message:', htmlMsg);
        notificationFailed = true;
      }
    }
  }

  try {
    await prisma.subscription.create({
      data: {
        userId: ctx.session.userId,
        subPlan: ctx.session.subPlan,
        subSlot: parseInt(ctx.session.subSlot),
        subDuration: parseInt(ctx.session.subDuration),
        subAmount: parseInt(ctx.session.subAmount),
        subEmail: ctx.session.subEmail,
        subPassword: ctx.session.subPassword,
        status: 'pending',
        subId: ctx.session.subId,
        subCategory: ctx.session.subCat,
        subSubCategory: ctx.session.subSubCat,
        subRemSlot: parseInt(ctx.session.subSlot),
        crew: '',
      },
    });
    console.log(`Subscription ${ctx.session.subId} created for user ${ctx.session.userId}`);
  } catch (err) {
    console.error('Failed to save subscription:', err.message);
    await ctx.reply('❌ Error saving subscription. Please try again.');
    clearListingSession(ctx);
    return showMainMenu(ctx);
  }

  clearListingSession(ctx);
  if (!notificationFailed) {
    await ctx.reply('✅ Subscription sent to Q Team for review! You’ll get an email update.');
  } else {
    await ctx.reply('✅ Subscription saved, but admin notification failed. The team will review soon.');
  }
  return ctx.reply('What do you want to do next?', Markup.keyboard(['List Another Subscription', 'Go to Main Menu']).oneTime().resize());
});

bot.action('CANCEL_SUBSCRIPTION', async (ctx) => {
  await ctx.answerCbQuery();
  clearListingSession(ctx);
  await ctx.reply('❌ Subscription cancelled.');
  return showMainMenu(ctx);
});

if (process.env.RENDER === 'true') {
  const app = express();
  app.use(bot.webhookCallback('/'));
  app.get('/', (req, res) => res.send('🤖 Q Bot is live on Render'));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`✅ Bot running on port ${port}`));
} else {
  bot.launch();
}