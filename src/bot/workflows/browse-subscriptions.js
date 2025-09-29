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

    const activeSubscriptions = await prisma.subscription.findMany({
      where: {
        status: 'live',
        subRemSlot: { gt: 0 },
      },
      select: {
        subCategory: true,
      },
      distinct: ['subCategory'],
    });

    const availableCategoryNames = activeSubscriptions.map((s) => s.subCategory);
    const availableCategories = categories.filter((c) => availableCategoryNames.includes(c.name));

    if (availableCategories.length === 0) {
      return ctx.reply(
        'There are currently no subscriptions available. Please check back later.',
        Markup.inlineKeyboard([[Markup.button.callback('Return to Main Menu', 'RETURN_TO_MAIN_MENU')]])
      );
    }

    return ctx.reply(
      'Join subscriptions you like.\n\nSelect a category:',
      Markup.inlineKeyboard([
        ...availableCategories.map((cat) => [
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
    const originalCat = categories.find((c) => c.name === category);
    if (!originalCat) {
      logger.warn('Invalid category selected', { category });
      return ctx.reply('❌ Invalid category.', Markup.inlineKeyboard([[Markup.button.callback('Back', 'BROWSE')]]));
    }

    const activeSubscriptions = await prisma.subscription.findMany({
      where: {
        subCategory: category,
        status: 'live',
        subRemSlot: { gt: 0 },
      },
      select: {
        subSubCategory: true,
      },
      distinct: ['subSubCategory'],
    });

    const availableSubcategories = activeSubscriptions.map((s) => s.subSubCategory);

    ctx.session.browseCategory = category;
    return ctx.reply(
      `Select a subcategory for ${category}:`,
      Markup.inlineKeyboard([
        ...originalCat.subcategories.filter((sub) => availableSubcategories.includes(sub)).map((sub) => [
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
    const { browseSubcategory, browsePage, browseSort } = ctx.session;
    const perPage = 1; // We are showing one at a time
    let orderBy = { createdAt: 'desc' }; // Default: Newest
    if (browseSort === 'oldest') orderBy = { createdAt: 'asc' };

    const where = {
      subSubCategory: browseSubcategory,
      status: 'live',
      subRemSlot: {
        gt: 0,
      },
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

    if (total === 0) {
      return ctx.reply(
        `No available subscriptions found for ${browseSubcategory}.`,
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'BROWSE')]])
      );
    }

    const sub = subscriptions[0]; // We fetch one at a time now
    if (!sub) {
      // If current page is empty, reset to page 0
      ctx.session.browsePage = 0;
      return showSubscriptions(ctx);
    }

    const subDetails =
      `Subscriptions for ${browseSubcategory} (${browsePage + 1}/${total}):\n\n` +
      `Owner: ${sub.user?.fullName || 'Unknown User'}\n` +
      `Plan: ${sub.subPlan}\n` +
      `Duration: ${sub.subDuration} month(s)\n` +
      `Total Slots: ${sub.subSlot}\n` +
      `Available Slots: ${sub.subRemSlot}\n` +
      `Amount: ₦${sub.subAmount}/month\n` +
      `Subscription ID: ${sub.subId}\n`;

    const navButtons = [];
    if (browsePage > 0) navButtons.push(Markup.button.callback('⬅️ Previous', 'BROWSE_PREV'));
    if (browsePage < total - 1) navButtons.push(Markup.button.callback('Next ➡️', 'BROWSE_NEXT'));
    const sortButtons = [
      Markup.button.callback('Newest', 'SORT_NEWEST'),
      Markup.button.callback('Oldest', 'SORT_OLDEST'),
    ];

    return ctx.reply(
      subDetails,
      Markup.inlineKeyboard([
        [Markup.button.callback('Select', `SELECT_SUB_${sub.subId}`)],
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

      // Create a payment history record
      await prisma.payment.create({
        data: {
          userId: user.userId,
          subId: sub.subId,
          subPlan: sub.subPlan,
          amount: parseInt(sub.subAmount),
          reference: transferReference,
          status: 'success',
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
        '✅ Payment complete! You have successfully joined the subscription.\n\nPlease send your email address and payment reference (from your payment history) to our live support to get your login details.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Go to Live Support', 'LIVE_SUPPORT')],
          [Markup.button.callback('Join Another Subscription', 'BROWSE')],
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