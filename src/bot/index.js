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
import subscriptionAmounts from '../utils/subscription-prices.js';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(safeSession());

// Handle /start
bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const fullName = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
  ctx.session.userId = telegramId;

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
  }
});

// Text listener for form steps
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

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

  // Plan input steps
  if (ctx.session.step === 'selectPlan') {
    const plan = text.trim();
    if (!ctx.session.availablePlans.includes(plan)) return ctx.reply('❌ Invalid choice. Please select a valid plan.');
    if (plan === 'Return to Category') return addSubscriptionWorkflow(ctx);

    ctx.session.subPlan = plan;
    const baseAmount = subscriptionAmounts[plan] || 0;
    ctx.session.subAmount = baseAmount + 200;

    ctx.session.step = 'enterSlot';
    return ctx.reply(`You selected ${plan}. How many available slots (e.g. 1, 2, 3...)?`);
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
      return ctx.reply('Enter subscription login email:');
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
    return ctx.reply('Enter subscription login password:');
  }

  if (ctx.session.step === 'enterPassword') {
    ctx.session.subPassword = text.trim();
    ctx.session.step = 'selectDuration';
    return ctx.reply('Select monthly duration (1–12):', Markup.keyboard([...Array(12)].map((_, i) => `${i + 1}`)).oneTime().resize());
  }

  if (ctx.session.step === 'enterWhatsApp') {
    ctx.session.whatsappNo = text.trim();
    ctx.session.subEmail = ctx.session.whatsappNo;
    ctx.session.subPassword = ctx.session.whatsappNo;
    ctx.session.step = 'selectDuration';
    return ctx.reply('Select monthly duration (1–12):', Markup.keyboard([...Array(12)].map((_, i) => `${i + 1}`)).oneTime().resize());
  }

  if (ctx.session.step === 'selectDuration') {
    const months = parseInt(text.trim());
    if (isNaN(months) || months < 1 || months > 12) return ctx.reply('❌ Choose between 1–12 months.');
    ctx.session.subDuration = months;

    // Generate unique subId
    let subId;
    let existing;
    do {
      subId = 'Q_' + Math.random().toString(36).substring(2, 7).toUpperCase();
      existing = await prisma.subscription.findMany({ where: { subId } });
    } while (existing.length > 0);

    ctx.session.subId = subId;

    // Send Telegram admin notification
    const botToken = process.env.BOT_TOKEN;
    const chatIds = ['6632021617', '7193164208'];
    const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const escape = (t) => (t || 'None').toString().replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    const msg = `
*New Subscription Request:*
*ID:* ${escape(subId)}
*User ID:* ${escape(ctx.session.userId)}
*Plan:* ${escape(ctx.session.subPlan)}
*Slots:* ${escape(ctx.session.subSlot)}
*Duration:* ${escape(ctx.session.subDuration)} month(s)
*Category:* ${escape(ctx.session.subCat)}
*Sub:* ${escape(ctx.session.subSubCat)}
*Monthly Amount:* ₦${escape(ctx.session.subAmount)}
*Login:* ${escape(ctx.session.subEmail)}
*Pass:* ${escape(ctx.session.subPassword)}
*Time:* ${escape(new Date().toISOString())}`;

    for (const chatId of chatIds) {
      await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: 'MarkdownV2',
        }),
      });
    }

    // Save to DB
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
});

// ✅ Add My Subscription button handler
bot.action('ADD_SUB', async (ctx) => {
  await ctx.answerCbQuery();
  return addSubscriptionWorkflow(ctx);
});

// ✅ Handle category clicks
bot.action(/^CATEGORY_(.+)$/, (ctx) => {
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleSubCategorySelection(ctx, category);
});

// ✅ Handle subcategory clicks
bot.action(/^SUBCATEGORY_(.+)$/, (ctx) => {
  const sub = ctx.match[1].replace(/_/g, ' ');
  return handlePlanSelection(ctx, sub);
});

// ✅ Navigation
bot.action('RETURN_TO_CATEGORY', (ctx) => addSubscriptionWorkflow(ctx));
bot.action('RETURN_TO_MAIN_MENU', (ctx) => showMainMenu(ctx));

// ✅ Webhook or Polling
if (process.env.RENDER === 'true') {
  const app = express();
  app.use(bot.webhookCallback('/'));
  app.get('/', (req, res) => res.send('🤖 Q Bot is live on Render'));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`✅ Bot running on port ${port}`));
} else {
  bot.launch();
}

// export { bot };