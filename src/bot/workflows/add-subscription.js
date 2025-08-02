import { Markup } from 'telegraf';
import subscriptionPrices, { planIdMap } from '../../utils/subscription-prices.js';
import logger from '../../utils/logger.js';

export const subcategoriesMap = {
  'Streaming (Movies/TV)': ['Netflix', 'Hulu', 'Disney+', 'Amazon Prime Video', 'HBO Max', 'Apple TV+', 'Paramount+', 'Peacock', 'Crunchyroll', 'Sling TV', 'YouTube Premium'],
  'Music': ['Spotify', 'Apple Music', 'Amazon Music', 'YouTube Music', 'Tidal', 'Deezer', 'Pandora'],
  'Education and Online Learning': ['LinkedIn Learning', 'Skillshare'],
  'Fitness and Wellness': ['Peloton', 'Calm', 'Headspace', 'Apple Fitness+'],
  'Gaming': ['Xbox', 'PlayStation Plus', 'Nintendo Switch Online'],
  'Cloud Storage and Productivity Tools': ['Google One', 'Microsoft 365', 'Dropbox', 'iCloud+'],
  'News and Magazines': ['The New York Times'],
  'Books and Audiobooks': ['Audible', 'Scribd', 'Kindle Unlimited'],
  'Software and Design Tools': ['Canva', 'Adobe Creative Cloud'],
  'Kids and Family': ['ABCmouse', 'Epic!'],
};

function escapeMarkdownV2(text) {
  return (text || '')
    .toString()
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export const addSubscriptionWorkflow = async (ctx) => {
  try {
    ctx.session.step = null;
    ctx.session.subCat = null;
    ctx.session.subSubCat = null;
    ctx.session.subPlan = null;
    ctx.session.subAmount = null;

    const categories = Object.keys(subcategoriesMap);
    const buttons = categories.map((c) => [
      Markup.button.callback(c, `CATEGORY_${c.replace(/ /g, '_')}`)
    ]);
    buttons.push([Markup.button.callback('Return to Main Menu', 'RETURN_TO_MAIN_MENU')]);

    await ctx.reply('🎬 Welcome to Add My Subscription!\n\nPlease select a category:', Markup.inlineKeyboard(buttons));
  } catch (err) {
    logger.error('Error in addSubscriptionWorkflow', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error starting add subscription. Please try again.');
  }
};

export const handleSubCategorySelection = async (ctx, category) => {
  try {
    if (!subcategoriesMap[category]) {
      logger.warn('Invalid category selected', { category });
      return ctx.reply('❌ Invalid category.', Markup.inlineKeyboard([[Markup.button.callback('Back', 'ADD_SUB')]]));
    }
    ctx.session.subCat = category;
    ctx.session.subSubCat = null;
    ctx.session.subPlan = null;
    ctx.session.subAmount = null;

    const options = subcategoriesMap[category];
    options.push('Return to Category');

    const escapedCat = escapeMarkdownV2(category);
    await ctx.editMessageText(`📂 You selected: *${escapedCat}*\n\nNow choose a subcategory:`, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(
        options.map((sub) => [
          Markup.button.callback(sub, sub === 'Return to Category' ? 'RETURN_TO_CATEGORY' : `SUBCATEGORY_${sub.replace(/ /g, '_')}`)
        ])
      )
    });
  } catch (err) {
    logger.error('Error in handleSubCategorySelection', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error selecting category. Please try again.');
  }
};

export const handlePlanSelection = async (ctx, subSubCat) => {
  try {
    ctx.session.subSubCat = subSubCat;
    ctx.session.subPlan = null;
    ctx.session.subAmount = null;

    const plans = Object.keys(subscriptionPrices).filter((plan) =>
      plan.toLowerCase().includes(subSubCat.toLowerCase())
    );

    if (plans.length === 0) {
      logger.warn('No plans available for subcategory', { subSubCat });
      await ctx.reply('❌ No plans available for this selection.');
      return addSubscriptionWorkflow(ctx);
    }

    const buttons = plans.map((plan) => {
      const planId = planIdMap[plan];
      const callbackData = `PLAN_ID_${planId}`;
      if (callbackData.length > 64) {
        logger.error(`Callback data too long for plan "${plan}"`, { callbackData });
        return null;
      }
      return [Markup.button.callback(plan, callbackData)];
    }).filter(Boolean);
    buttons.push([Markup.button.callback('Return to Category', 'RETURN_TO_CATEGORY')]);

    await ctx.editMessageText(
      `📺 You selected: *${escapeMarkdownV2(subSubCat)}*\n\nNow choose a plan:`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(buttons)
      }
    );
  } catch (err) {
    logger.error('Error in handlePlanSelection', { error: err.message, stack: err.stack });
    await ctx.reply('❌ Error loading plans. Please try again.');
    return addSubscriptionWorkflow(ctx);
  }
};

export async function handleDurationSelection(ctx, duration) {
  try {
    const months = parseInt(duration);
    if (isNaN(months) || months < 1 || months > 12) {
      logger.warn('Invalid duration selected', { duration });
      return ctx.reply('❌ Choose between 1–12 months.', Markup.inlineKeyboard([[Markup.button.callback('Back', 'ADD_SUB')]]));
    }
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
    const safe = (value) => escape(value?.toString());

    const markdownMsg =
      `*Confirm Your Subscription Details:*\n\n` +
      `**Subscription ID:** ${safe(ctx.session.subId)}\n` +
      `**Subscription Name:** ${safe(ctx.session.subPlan)}\n` +
      `**Slots:** ${safe(ctx.session.subSlot)}\n` +
      `**Duration:** ${safe(ctx.session.subDuration)} month(s)\n` +
      `**Category:** ${safe(ctx.session.subCat)}\n` +
      `**Subcategory:** ${safe(ctx.session.subSubCat)}\n` +
      `**Monthly Amount:** ₦${safe(ctx.session.subAmount)}\n` +
      `**Login Email/WhatsApp:** ${safe(ctx.session.subEmail)}\n` +
      `**Password:** ${safe(ctx.session.subPassword || 'N/A')}\n` +
      (ctx.session.shareType === 'otp' ? `**WhatsApp Number:** ${safe(ctx.session.whatsappNo)}\n` : '') +
      `Please review and confirm or cancel.`;

    const htmlMsg =
      `<b>Confirm Your Subscription Details:</b>\n\n` +
      `<b>Subscription ID:</b> ${ctx.session.subId || 'N/A'}\n` +
      `<b>Subscription Name:</b> ${ctx.session.subPlan || 'N/A'}\n` +
      `<b>Slots:</b> ${ctx.session.subSlot || 'N/A'}\n` +
      `<b>Duration:</b> ${ctx.session.subDuration || 'N/A'} month(s)\n` +
      `<b>Category:</b> ${ctx.session.subCat || 'N/A'}\n` +
      `<b>Subcategory:</b> ${ctx.session.subSubCat || 'N/A'}\n` +
      `<b>Monthly Amount:</b> ₦${ctx.session.subAmount || 'N/A'}\n` +
      `<b>Login Email/WhatsApp:</b> ${ctx.session.subEmail || 'N/A'}\n` +
      `<b>Password:</b> ${ctx.session.subPassword ? ctx.session.subPassword.slice(0, 3) + '****' : 'N/A'}\n` +
      (ctx.session.shareType === 'otp' ? `<b>WhatsApp Number:</b> ${ctx.session.whatsappNo || 'N/A'}\n` : '') +
      `Please review and confirm or cancel.`;

    ctx.session.step = 'confirmSubscription';
    try {
      await ctx.reply(markdownMsg, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Confirm', 'CONFIRM_SUBSCRIPTION')],
          [Markup.button.callback('Cancel', 'CANCEL_SUBSCRIPTION')],
          [Markup.button.callback('List Another Subscription', 'ADD_SUB')],
        ]),
      });
    } catch (err) {
      logger.error('Failed to send confirmation message', { error: err.message, message: markdownMsg });
      await ctx.reply(htmlMsg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Confirm', 'CONFIRM_SUBSCRIPTION')],
          [Markup.button.callback('Cancel', 'CANCEL_SUBSCRIPTION')],
          [Markup.button.callback('List Another Subscription', 'ADD_SUB')],
        ]),
      });
    }
  } catch (err) {
    logger.error('Error in handleDurationSelection', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error selecting duration. Please try again.');
  }
}