import { Markup } from 'telegraf';
import { prisma } from '../../db/client.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import { initiatePayment } from './browse-subscriptions.js';

export async function mySubscriptionsWorkflow(ctx) {
  try {
    ctx.session.step = 'mySubscriptions';
    return ctx.reply(
      'View your subscriptions:',
      Markup.inlineKeyboard([
        [Markup.button.callback('Listed', 'LISTED_SUBS')],
        [Markup.button.callback('Joined', 'JOINED_SUBS')],
        [Markup.button.callback('Back to Main Menu', 'MAIN_MENU')],
      ])
    );
  } catch (err) {
    logger.error('Error in mySubscriptionsWorkflow', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error starting my subscriptions. Please try again.');
  }
}

export async function showListedSubscriptions(ctx) {
  try {
    const subscriptions = await prisma.subscription.findMany({
      where: { userId: ctx.session.userId },
      include: { user: true },
    });

    if (subscriptions.length === 0) {
      return ctx.reply(
        'You have no listed subscriptions.',
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'MY_SUBS')]])
      );
    }

    const subList = subscriptions
      .map((sub) => {
        return `Subscription ID: ${sub.subId}\n` +
               `Plan: ${sub.subPlan}\n` +
               `Status: ${sub.status}\n` +
               `Crew: ${sub.crew.length > 0 ? sub.crew.join(', ') : 'None'}\n` +
               `Slots: ${sub.subRemSlot}/${sub.subSlot}\n` +
               `Amount: ₦${sub.subAmount}/month\n`;
      })
      .join('\n');

    const buttons = subscriptions.map((sub) => [
      Markup.button.callback('Unlist', `UNLIST_SUB_${sub.subId}`),
      Markup.button.callback('Update', `UPDATE_SUB_${sub.subId}`),
    ]);

    return ctx.reply(
      `Your Listed Subscriptions:\n\n${subList}`,
      Markup.inlineKeyboard([...buttons, [Markup.button.callback('Back', 'MY_SUBS')]])
    );
  } catch (err) {
    logger.error('Error in showListedSubscriptions', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error fetching listed subscriptions. Please try again.');
  }
}

export async function showJoinedSubscriptions(ctx) {
  try {
    const subscriptions = await prisma.subscription.findMany({
      where: {
        crew: { has: ctx.session.email },
        status: 'live',
      },
      include: { user: true },
    });

    if (subscriptions.length === 0) {
      return ctx.reply(
        'You have not joined any subscriptions.',
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'MY_SUBS')]])
      );
    }

    const subList = subscriptions
      .map((sub) => {
        const created = new Date(sub.createdAt);
        const expires = new Date(created.setMonth(created.getMonth() + parseInt(sub.subDuration)));
        const now = new Date();
        const isExpiring = expires < new Date(now.setDate(now.getDate() + 7));
        const status = isExpiring ? 'Expiring Soon' : expires < now ? 'Expired' : 'Active';
        return `Subscription ID: ${sub.subId}\n` +
               `Plan: ${sub.subPlan}\n` +
               `Owner: ${sub.user?.fullName || 'Unknown User'}\n` +
               `Status: ${status}\n` +
               `Amount: ₦${sub.subAmount}/month\n`;
      })
      .join('\n');

    const buttons = subscriptions.map((sub) => [
      Markup.button.callback('Renew', `RENEW_SUB_${sub.subId}`),
      Markup.button.callback('Leave', `LEAVE_SUB_${sub.subId}`),
    ]);

    return ctx.reply(
      `Your Joined Subscriptions:\n\n${subList}`,
      Markup.inlineKeyboard([...buttons, [Markup.button.callback('Back', 'MY_SUBS')]])
    );
  } catch (err) {
    logger.error('Error in showJoinedSubscriptions', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error fetching joined subscriptions. Please try again.');
  }
}

export async function unlistSubscription(ctx, subId) {
  try {
    const sub = await prisma.subscription.findUnique({ where: { subId } });
    if (!sub || sub.userId !== ctx.session.userId) {
      logger.warn('Invalid or unauthorized subscription', { subId, userId: ctx.session.userId });
      return ctx.reply('❌ Invalid subscription.');
    }

    await axios.post(
      `https://api.telegram.org/bot${process.env.PREVIEW_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.ADMIN_CHAT_ID,
        text: `Unlist Request:\nSubscription ID: ${subId}\nUser ID: ${ctx.session.userId}`,
      }
    );
    await prisma.subscription.update({
      where: { subId },
      data: { status: 'pending_unlist' },
    });
    return ctx.reply(
      '✅ Unlist request sent for review.',
      Markup.inlineKeyboard([[Markup.button.callback('Back', 'MY_SUBS')]])
    );
  } catch (err) {
    logger.error('Error in unlistSubscription', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Failed to send unlist request.');
  }
}

export async function updateSubscription(ctx, subId) {
  try {
    const sub = await prisma.subscription.findUnique({ where: { subId } });
    if (!sub || sub.userId !== ctx.session.userId) {
      logger.warn('Invalid or unauthorized subscription', { subId, userId: ctx.session.userId });
      return ctx.reply('❌ Invalid subscription.');
    }

    ctx.session.updateSubId = subId;
    ctx.session.step = 'updateSlots';
    return ctx.reply('Enter new number of slots:');
  } catch (err) {
    logger.error('Error in updateSubscription', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error selecting subscription. Please try again.');
  }
}

export async function handleUpdateSlots(ctx, text) {
  try {
    const slots = parseInt(text.trim());
    if (isNaN(slots) || slots <= 0) {
      logger.warn('Invalid slots input', { text });
      return ctx.reply('❌ Invalid slots.');
    }
    ctx.session.updateSlots = slots;
    ctx.session.step = 'updateDuration';
    return ctx.reply('Enter new duration (1–12 months):');
  } catch (err) {
    logger.error('Error in handleUpdateSlots', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error updating slots. Please try again.');
  }
}

export async function handleUpdateDuration(ctx, text) {
  try {
    const duration = parseInt(text.trim());
    if (isNaN(duration) || duration < 1 || duration > 12) {
      logger.warn('Invalid duration input', { text });
      return ctx.reply('❌ Choose between 1–12 months.');
    }
    await prisma.subscription.update({
      where: { subId: ctx.session.updateSubId },
      data: {
        subSlot: parseInt(ctx.session.updateSlots),
        subRemSlot: parseInt(ctx.session.updateSlots),
        subDuration: duration.toString(),
      },
    });
    ctx.session.step = null;
    return ctx.reply(
      '✅ Subscription updated.',
      Markup.inlineKeyboard([[Markup.button.callback('Back', 'MY_SUBS')]])
    );
  } catch (err) {
    logger.error('Error in handleUpdateDuration', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Update failed.');
  }
}

export async function renewSubscription(ctx, subId) {
  try {
    const sub = await prisma.subscription.findUnique({ where: { subId } });
    if (!sub || !sub.crew.includes(ctx.session.email)) {
      logger.warn('Invalid or unauthorized subscription', { subId, email: ctx.session.email });
      return ctx.reply('❌ Invalid subscription.');
    }

    const created = new Date(sub.createdAt);
    const expires = new Date(created.setMonth(created.getMonth() + parseInt(sub.subDuration)));
    const now = new Date();
    const isExpiring = expires < new Date(now.setDate(now.getDate() + 7)) || expires < now;

    if (!isExpiring) {
      return ctx.reply(
        '✅ Your subscription is still active.',
        Markup.inlineKeyboard([[Markup.button.callback('Back', 'JOINED_SUBS')]])
      );
    }

    ctx.session.selectedSubId = subId;
    return initiatePayment(ctx);
  } catch (err) {
    logger.error('Error in renewSubscription', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error renewing subscription. Please try again.');
  }
}

export async function leaveSubscription(ctx, subId, confirm = false) {
  try {
    const sub = await prisma.subscription.findUnique({ where: { subId } });
    if (!sub || !sub.crew.includes(ctx.session.email)) {
      logger.warn('Invalid or unauthorized subscription', { subId, email: ctx.session.email });
      return ctx.reply('❌ Invalid subscription.');
    }

    if (!confirm) {
      ctx.session.leaveSubId = subId;
      return ctx.reply(
        'Are you sure you want to leave this subscription? This action will take 3 days to complete.',
        Markup.inlineKeyboard([
          [Markup.button.callback('Confirm Leave', `CONFIRM_LEAVE_${subId}`)],
          [Markup.button.callback('Cancel', 'JOINED_SUBS')],
        ])
      );
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3);

    await prisma.leaveRequest.create({
      data: {
        userId: ctx.session.userId,
        subId,
        status: 'pending',
        expiresAt,
      },
    });
    return ctx.reply(
      '✅ Leave request submitted. You have 3 days to cancel this request.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Cancel Leave', `CANCEL_LEAVE_${subId}`)],
        [Markup.button.callback('Back', 'JOINED_SUBS')],
      ])
    );
  } catch (err) {
    logger.error('Error in leaveSubscription', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Failed to submit leave request.');
  }
}

export async function cancelLeaveRequest(ctx, subId) {
  try {
    const leaveRequest = await prisma.leaveRequest.findFirst({
      where: {
        userId: ctx.session.userId,
        subId,
        status: 'pending',
      },
    });

    if (!leaveRequest) {
      return ctx.reply('❌ No pending leave request.');
    }

    await prisma.leaveRequest.update({
      where: { id: leaveRequest.id },
      data: { status: 'cancelled' },
    });

    return ctx.reply(
      '✅ Leave request cancelled.',
      Markup.inlineKeyboard([[Markup.button.callback('Back', 'JOINED_SUBS')]])
    );
  } catch (err) {
    logger.error('Error in cancelLeaveRequest', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error cancelling leave request. Please try again.');
  }
}