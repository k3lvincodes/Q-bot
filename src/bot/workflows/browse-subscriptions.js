import { Markup } from 'telegraf';
import { prisma } from '../../db/client.js';
import { subcategoriesMap } from './add-subscription.js';
import logger from '../../utils/logger.js';
import { fetchWithRetry } from '../index.js';

// Define categories from subcategoriesMap for consistency
const categories = Object.keys(subcategoriesMap).map((name) => ({
  name,
  subcategories: subcategoriesMap[name],
}));

export async function browseSubscriptionsWorkflow(ctx) {
  try {
    ctx.session.step = 'browseSubscriptions';
    ctx.session.browsePage = 0;
    ctx.session.browseSort = 'newest';
    return ctx.reply(
      'Browse and join subscriptions you like.\n\nSelect a category:',
      Markup.inlineKeyboard([
        ...categories.map((cat) => [
          Markup.button.callback(cat.name, `BROWSE_CAT_${cat.name.replace(/ /g, '_')}`),
        ]),
        [Markup.button.callback('Return to Main Menu', 'RETURN_TO_MAIN_MENU')],
      ])
    );
  } catch (err) {
    logger.error('Error in browseSubscriptionsWorkflow', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error starting browse workflow. Please try again.');
  }
}

export async function handleBrowseCategorySelection(ctx, category) {
  try {
    const cat = categories.find((c) => c.name === category);
    if (!cat) {
      logger.warn('Invalid category selected', { category });
      return ctx.reply('❌ Invalid category.', Markup.inlineKeyboard([[Markup.button.callback('Back', 'BROWSE')]]));
    }
    ctx.session.browseCategory = category;
    return ctx.reply(
      `Select a subcategory for ${category}:`,
      Markup.inlineKeyboard([
        ...cat.subcategories.map((sub) => [
          Markup.button.callback(sub, `BROWSE_SUBCAT_${sub.replace(/ /g, '_')}`),
        ]),
        [Markup.button.callback('Back', 'BROWSE')],
      ])
    );
  } catch (err) {
    logger.error('Error in handleBrowseCategorySelection', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error selecting category. Please try again.');
  }
}

export async function handleBrowseSubcategorySelection(ctx, subcategory) {
  try {
    ctx.session.browseSubcategory = subcategory;
    ctx.session.browsePage = ctx.session.browsePage || 0;
    return await showSubscriptions(ctx);
  } catch (err) {
    logger.error('Error in handleBrowseSubcategorySelection', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error selecting subcategory. Please try again.');
  }
}

async function showSubscriptions(ctx) {
  try {
    const { browseSubcategory, browsePage, browseSort, fullName } = ctx.session;
    const perPage = 10;
    let orderBy = { createdAt: 'desc' }; // Default: Newest
    if (browseSort === 'oldest') orderBy = { createdAt: 'asc' };
    // 'verified' sort will also be newest first among verified users
    if (browseSort === 'verified') {
      orderBy = { user: { verified: 'desc' }, createdAt: 'desc' };
    }

    const conditions = [
      { subSubCategory: browseSubcategory },
      { status: 'live' },
      { subRemSlot: { gt: 0 } },
    ];

    if (browseSubcategory) {
      conditions.push({ subSubCategory: browseSubcategory });
    }
    if (browseSort === 'verified') {
      conditions.push({ user: { verified: true } });
    }
    if (fullName) {
      conditions.push({ NOT: { crew: { has: fullName } } });
    }

    const where = {
      AND: conditions,
    };

    const subscriptions = await prisma.subscription.findMany({
      where,
      orderBy,
      skip: browsePage * perPage,
      take: perPage,
      include: { user: true },
    });

    const total = await prisma.subscription.count({ where });
    const totalPages = Math.ceil(total / perPage);

    if (subscriptions.length === 0) {
      return ctx.reply(
        `No available subscriptions for ${browseSubcategory}.`,
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'BROWSE')]])
      );
    }

    const subList = subscriptions
      .map((record) => {
        return `Owner: ${record.user?.fullName || 'Unknown User'}\n` +
               `Plan: ${record.subPlan}\n` +
               `Duration: ${record.subDuration} month(s)\n` +
               `Total Slots: ${record.subSlot}\n` +
               `Available Slots: ${record.subRemSlot}\n` +
               `Amount: ₦${record.subAmount}/month\n` +
               `Subscription ID: ${record.subId}\n`;
      })
      .join('\n\n');

    const buttons = subscriptions.map((sub) => [
      Markup.button.callback('Select', `SELECT_SUB_${sub.subId}`),
    ]);
    const navButtons = [];
    if (browsePage > 0) navButtons.push(Markup.button.callback('Previous', 'BROWSE_PREV'));
    if (browsePage < totalPages - 1) navButtons.push(Markup.button.callback('Next', 'BROWSE_NEXT'));
    const sortButtons = [
      Markup.button.callback('Newest', 'SORT_NEWEST'),
      Markup.button.callback('Oldest', 'SORT_OLDEST'),
      Markup.button.callback('Verified Listers', 'SORT_VERIFIED'),
    ];

    await ctx.deleteMessage().catch(() => {}); // Prevent ERR_HTTP_HEADERS_SENT
    return ctx.reply(
      `Subscriptions for ${browseSubcategory}:\n\n${subList}`,
      Markup.inlineKeyboard([
        ...buttons,
        navButtons.length > 0 ? navButtons : [],
        sortButtons,
        [Markup.button.callback('Back', 'BROWSE')],
      ])
    );
  } catch (err) {
    logger.error('Error in showSubscriptions', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error fetching subscriptions. Please try again.');
  }
}

export async function handleSubscriptionSelection(ctx, subId) {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { subId },
      include: { user: true },
    });
    if (!sub || sub.status !== 'live' || sub.subRemSlot <= 0) {
      return ctx.reply(
        '❌ Subscription unavailable.',
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'BROWSE')]])
      );
    }

    ctx.session.selectedSubId = subId;
    const details = `Subscription Details:\n\n` +
                    `Owner: ${sub.user?.fullName || 'Unknown User'}\n` +
                    `Plan: ${sub.subPlan}\n` +
                    `Duration: ${sub.subDuration} month(s)\n` +
                    `Available Slots: ${sub.subRemSlot}\n` +
                    `Amount: ₦${sub.subAmount}/month\n` +
                    `Subscription ID: ${subId}\n`;

    return ctx.reply(
      details + '\nWould you like to:',
      Markup.inlineKeyboard([
        [Markup.button.callback('Continue to Payment', 'PAY_SUB')],
        [Markup.button.callback('Back', 'BROWSE')],
      ])
    );
  } catch (err) {
    logger.error('Error in handleSubscriptionSelection', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error selecting subscription. Please try again.');
  }
}

export async function initiatePayment(ctx) {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { subId: ctx.session.selectedSubId },
    });
    const user = await prisma.users.findUnique({
      where: { userId: ctx.session.userId },
    });
    if (!sub || !user) {
      logger.warn('Invalid subscription or user for payment', {
        subId: ctx.session.selectedSubId,
        userId: ctx.session.userId,
      });
      return ctx.reply('❌ Error initiating payment.');
    }

    const amount = parseInt(sub.subAmount);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (isNaN(amount) || amount < 100) {
      logger.error('Invalid amount', { subId: sub.subId, amount });
      return ctx.reply('❌ Invalid subscription amount.');
    }
    if (!emailRegex.test(user.email)) {
      logger.error('Invalid email', { userId: user.userId, email: user.email });
      return ctx.reply('❌ Invalid user email.');
    }

    logger.info('Initiating payment', { subId: sub.subId, userId: user.userId, amount, email: user.email });
    const response = await fetchWithRetry(
      'https://quorix-paystack-backend.vercel.app/api/transfer/initiate-transfer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amount,
          email: user.email,
        }),
      }
    );

    const authUrl = response.authorization_url;
    if (!authUrl) {
      logger.error('No authorization URL in response', { response });
      throw new Error(`No authorization URL received from Paystack. Response: ${JSON.stringify(response)}`);
    }

    ctx.session.authUrl = authUrl;
    ctx.session.transferReference = response.reference || '';
    return ctx.reply(
      `Click the link to complete your bank transfer:\n\n${ctx.session.authUrl}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Completed', 'VERIFY_PAYMENT')],
        [Markup.button.callback('Cancel', 'CANCEL_PAYMENT')],
      ])
    );
  } catch (err) {
    logger.error('Error in initiatePayment', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Failed to initiate payment. Please try again.');
  }
}

export async function verifyPayment(ctx) {
  try {
    const { transferReference, selectedSubId } = ctx.session;
    if (!transferReference || !selectedSubId) {
      logger.warn('Missing transfer reference or subscription ID', {
        transferReference,
        selectedSubId,
      });
      return ctx.reply('❌ Invalid payment verification request.');
    }

    const response = await fetchWithRetry(
      `https://quorix-paystack-backend.vercel.app/api/transfer/verify-transfer?reference=${transferReference}`,
      {
        method: 'GET',
      }
    );
    const transferStatus = response?.status || '';

    if (['pending', 'failed', 'ongoing'].includes(transferStatus)) {
      return ctx.reply(
        `Your payment is still pending. Please complete the transfer to join the subscription.\n\n${ctx.session.authUrl}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Completed', 'VERIFY_PAYMENT')],
          [Markup.button.callback('Cancel', 'CANCEL_PAYMENT')],
        ])
      );
    }

    if (transferStatus === 'success') {
      const sub = await prisma.subscription.findUnique({
        where: { subId: selectedSubId },
      });
      const user = await prisma.users.findUnique({
        where: { userId: ctx.session.userId },
      });
      if (!sub || !user) {
        throw new Error('Subscription or user not found.');
      }

      await prisma.subscription.update({
        where: { subId: selectedSubId },
        data: {
          crew: { push: user.email },
          subRemSlot: { decrement: 1 },
        },
      });

      await prisma.balance.upsert({
        where: { userId: sub.userId },
        update: { balance: { increment: parseInt(sub.subAmount) } },
        create: { userId: sub.userId, balance: parseInt(sub.subAmount) },
      });

      // Notify the subscription owner
      try {
        const ownerId = sub.userId;
        const joiningUserName = user.fullName || 'A new user';
        const notificationMessage = `🎉 Great news! ${joiningUserName} has just joined your "${sub.subPlan}" subscription.`;

        await ctx.telegram.sendMessage(ownerId, notificationMessage);
        logger.info(`Sent new joiner notification to owner ${ownerId} for subscription ${sub.subId}`);
      } catch (notificationError) {
        logger.error('Failed to send new joiner notification to subscription owner', {
          error: notificationError.message,
        });
      }

      ctx.session.step = null;
      ctx.session.authUrl = null;
      ctx.session.transferReference = null;
      ctx.session.selectedSubId = null;

      return ctx.reply(
        '✅ Payment complete! You have successfully joined the subscription.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Join Another Subscription', 'BROWSE_SUBS')],
          [Markup.button.callback('Go to Main Menu', 'MAIN_MENU')],
        ])
      );
    }

    // Handle other statuses or empty status as pending
    logger.warn('Unexpected or empty transfer status, treating as pending.', { transferStatus });
    return ctx.reply(
      `We couldn't confirm your payment status yet. If you have completed the payment, please wait a moment and try again.\n\n${ctx.session.authUrl}`,
      Markup.inlineKeyboard([[Markup.button.callback('Completed', 'VERIFY_PAYMENT')], [Markup.button.callback('Cancel', 'CANCEL_PAYMENT')]])
    );
  } catch (err) {
    logger.error('Error in verifyPayment', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Payment verification failed. Please try again.');
  }
}

export async function cancelPayment(ctx) {
  try {
    ctx.session.step = null;
    ctx.session.authUrl = null;
    ctx.session.transferReference = null;
    ctx.session.selectedSubId = null;
    return ctx.reply(
      'Payment cancelled.',
      Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'RETURN_TO_MAIN_MENU')]])
    );
  } catch (err) {
    logger.error('Error in cancelPayment', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error cancelling payment. Please try again.');
  }
}