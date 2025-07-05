// src/bot/index.js

import { Telegraf } from 'telegraf';
import session from '../middlewares/session.js';
import { prisma } from '../db/client.js';
import { showMainMenu } from '../utils/menu.js';
import axios from 'axios';

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const fullNameFromTelegram = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');

  ctx.session.userId = telegramId;

  const user = await prisma.users.findUnique({
    where: { userId: telegramId },
  });

  if (user) {
    ctx.session.persistentUser = 'yes';
    ctx.session.email = user.email;
    ctx.session.firstName = user.fullName?.split(' ')[0] || '';
    ctx.session.admin = user.admin ? 'yes' : 'no';

    await ctx.reply(
      `Welcome back to Q by Cratebux @${ctx.session.firstName}! 🎉 Share premium subscriptions like Netflix, Spotify, and more at a fraction of the cost.`
    );

    if (ctx.session.admin === 'yes') {
      return ctx.scene?.enter?.('Admin') || ctx.reply('🔐 Admin workflow not yet set up.');
    } else {
      return showMainMenu(ctx);
    }
  } else {
    ctx.session.persistentUser = 'no';
    ctx.session.platform = 'telegram';

    await ctx.reply(`Welcome to Q! 🎉 To get started, please register:\n\nPlease enter your full name:`);
    ctx.session.step = 'collectFullName';
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  if (ctx.session.step === 'collectFullName') {
    if (!text.trim().includes(' ')) {
      return ctx.reply('Please enter your **full name** (first and last).');
    }

    ctx.session.fullName = text.trim();
    ctx.session.firstName = text.trim().split(' ')[0];
    ctx.session.step = 'collectEmail';
    return ctx.reply('Great! Now enter your email (for verification):');
  }

  if (ctx.session.step === 'collectEmail') {
    const existing = await prisma.users.findFirst({
      where: { email: text.trim().toLowerCase() },
    });

    if (existing) {
      return ctx.reply('This email has already been used. Please enter a different one:');
    }

    ctx.session.email = text.trim().toLowerCase();
    ctx.session.verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    ctx.session.step = 'verifyCode';

    const payload = {
      name: ctx.session.firstName,
      email: ctx.session.email,
      verification: ctx.session.verificationCode,
    };

    const webhookUrl = 'https://hook.eu2.make.com/1rzify472wbi8lzbkazby3yyb7ot9rhp';

    try {
      const response = await axios.post(webhookUrl, payload);
      console.log(response.data);
    } catch (error) {
      console.log('failed');
    }

    return ctx.reply('✅ Enter the verification code sent to your email:');
  }

  if (ctx.session.step === 'verifyCode') {
    if (text.trim() !== ctx.session.verificationCode) {
      return ctx.reply('❌ Incorrect code. Please enter the correct verification code:');
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
    await ctx.reply("Registration successful! 🚀 You're ready to share and save.");
    return showMainMenu(ctx);
  }
});

// Admin City button logic
bot.action('ADMIN_CITY', async (ctx) => {
  if (ctx.session.admin === 'yes') {
    return ctx.scene?.enter?.('Admin') || ctx.reply('🔐 Admin workflow not yet set up.');
  } else {
    return ctx.reply("❌ You are not authorized to access Admin City.");
  }
});

bot.launch();