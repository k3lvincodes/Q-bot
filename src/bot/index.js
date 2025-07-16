import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import safeSession from '../middlewares/session.js';
import { prisma } from '../db/client.js';
import { showMainMenu } from '../utils/menu.js';
import axios from 'axios';
import {
  addSubscriptionWorkflow,
  handleSubCategorySelection,
  handlePlanSelection
} from './workflows/add-subscription.js';
import subscriptionPrices from '../utils/subscription-prices.js';

function escapeMarkdownV2(text) {
  return (text || '')
    .toString()
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(safeSession());

bot.use(async (ctx, next) => {
  const now = Date.now();

  // If no previous activity recorded, set it now and proceed
  if (!ctx.session.lastActive) {
    ctx.session.lastActive = now;
    return next();
  }

  const inactiveThreshold = 10 * 60 * 1000; // 10 minutes
  const timeSinceLast = now - ctx.session.lastActive;

  // If user was inactive too long
  if (timeSinceLast > inactiveThreshold) {
    ctx.session.step = null;
    ctx.session.subCat = null;
    ctx.session.subSubCat = null;
    ctx.session.subPlan = null;
    ctx.session.subAmount = null;
    ctx.session.lastActive = now; // Reset timer here so it doesn't loop

    await ctx.reply('⏳ You were inactive for a while. Back to Main Menu.');
    return showMainMenu(ctx);
  }

  // User is still active — update lastActive and continue
  ctx.session.lastActive = now;
  return next();
});

bot.on('text', async (ctx, next) => {
  const telegramId = String(ctx.from.id);
  ctx.session.userId = telegramId;
  const text = ctx.message.text;

  if (text === 'List Another Subscription') {
    ctx.session.step = null;
    return addSubscriptionWorkflow(ctx);
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
      console.log('Email webhook failed');
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

    const escape = (text) => (text || 'None').toString().replace(/([_\*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

    const msg =
      `*New Subscription Request:*\n\n` +
      `*Subscription ID:* ${escape(subId)}\n` +
      `*User ID:* ${escape(ctx.session.userId)}\n` +
      `*Subscription Name:* ${escape(ctx.session.subPlan)}\n` +
      `*Slots:* ${escape(ctx.session.subSlot)}\n` +
      `*Duration:* ${escape(months)} month(s)\n` +
      `*Category:* ${escape(ctx.session.subCat)}\n` +
      `*Subcategory:* ${escape(ctx.session.subSubCat)}\n` +
      `*Monthly Amount:* ₦${escape(ctx.session.subAmount)}\n` +
      `*Login:* ${escape(ctx.session.subEmail)}\n` +
      `*Pass:* ${escape(ctx.session.subPassword)}\n` +
      `*Time:* ${escape(new Date().toISOString())}`;

    const apiUrl = `https://api.telegram.org/bot${process.env.PREVIEW_BOT_TOKEN}/sendMessage`;
    const chatIds = ['6632021617', '7193164208'];
    for (const chatId of chatIds) {
      await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'MarkdownV2' }),
      });
    }

    await prisma.subscription.create({
      data: {
        userId: ctx.session.userId,
        subPlan: ctx.session.subPlan,
        subSlot: ctx.session.subSlot,
        subDuration: ctx.session.subDuration,
        subAmount: ctx.session.subAmount,
        subEmail: ctx.session.subEmail,
        subPassword: ctx.session.subPassword,
        status: 'pending',
        subId: ctx.session.subId,
        subCategory: ctx.session.subCat,
        subSubCategory: ctx.session.subSubCat,
        subRemSlot: ctx.session.subSlot,
        crew: '',
      },
    });

    ctx.session.step = null;
    await ctx.reply('✅ Your listing has been sent to Q Team for confirmation. You will receive an email update.');
    return ctx.reply('What do you want to do next?', Markup.keyboard(['List Another Subscription', 'Go to Main Menu']).oneTime().resize());
  }

  if (next) return next();
});

bot.action('ADD_SUB', async (ctx) => {
  await ctx.answerCbQuery();
  return addSubscriptionWorkflow(ctx);
});

bot.action(/^CATEGORY_(.+)$/, (ctx) => {
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleSubCategorySelection(ctx, category);
});

bot.action(/^SUBCATEGORY_(.+)$/, (ctx) => {
  const sub = ctx.match[1].replace(/_/g, ' ');
  return handlePlanSelection(ctx, sub);
});

bot.action(/^PLAN_ID_(.+)$/, (ctx) => {
  const plan = Buffer.from(ctx.match[1], 'base64').toString('utf-8');
  if (!subscriptionPrices[plan]) {
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

bot.action('RETURN_TO_CATEGORY', (ctx) => addSubscriptionWorkflow(ctx));
bot.action('RETURN_TO_MAIN_MENU', (ctx) => showMainMenu(ctx));

if (process.env.RENDER === 'true') {
  const app = express();
  app.use(bot.webhookCallback('/'));
  app.get('/', (req, res) => res.send('🤖 Q Bot is live on Render'));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`✅ Bot running on port ${port}`));
} else {
  bot.launch();
}