import { Markup } from 'telegraf';
import { faqs } from '../../utils/faqs.js';
import logger from '../../utils/logger.js';

/**
 * Shows a paginated list of FAQ questions.
 * @param {import('telegraf').Context} ctx The Telegraf context object.
 * @param {boolean} isEdit Whether to edit the existing message.
 */
export async function showFaqs(ctx, isEdit = true) {
  try {
    const page = ctx.session.faqPage || 0;
    const perPage = 3; // Show 3 questions per page

    const paginatedFaqs = faqs.slice(page * perPage, (page + 1) * perPage);

    if (paginatedFaqs.length === 0 && page > 0) {
      // If user is on a page that no longer exists, go back to the first page.
      ctx.session.faqPage = 0;
      return showFaqs(ctx, isEdit);
    }

    const buttons = paginatedFaqs.map((faq) => [
      Markup.button.callback(faq.question, `FAQ_Q_${faq.id}`),
    ]);

    const navButtons = [];
    if (page > 0) {
      navButtons.push(Markup.button.callback('⬅️ Previous', 'FAQ_PREV'));
    }
    if ((page + 1) * perPage < faqs.length) {
      navButtons.push(Markup.button.callback('Next ➡️', 'FAQ_NEXT'));
    }

    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }

    buttons.push([Markup.button.callback('⬅️ Back to Support', 'SUPPORT')]);

    const message = 'Frequently Asked Questions:';
    const keyboard = Markup.inlineKeyboard(buttons);

    if (isEdit) {
      return ctx.editMessageText(message, keyboard);
    }
    return ctx.reply(message, keyboard);
  } catch (err) {
    logger.error('Error in showFaqs', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error displaying FAQs. Please try again.');
  }
}

/**
 * Shows the answer to a specific FAQ question.
 * @param {import('telegraf').Context} ctx The Telegraf context object.
 * @param {string} faqId The ID of the FAQ to show.
 */
export async function showFaqAnswer(ctx, faqId) {
  try {
    const faq = faqs.find((f) => f.id === faqId);
    if (!faq) {
      logger.warn('Invalid FAQ ID', { faqId });
      return ctx.editMessageText(
        '❌ Question not found.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to FAQs', 'BACK_TO_FAQS')]])
      );
    }

    const message = `❓ *${faq.question}*\n\n${faq.answer}`;

    return ctx.editMessageText(
      message,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Back to Questions', 'BACK_TO_FAQS')],
        ]),
      }
    );
  } catch (err) {
    logger.error('Error in showFaqAnswer', { error: err.message, stack: err.stack });
    return ctx.reply('❌ Error displaying the answer. Please try again.');
  }
}

/**
 * Handles the live support action.
 * @param {import('telegraf').Context} ctx The Telegraf context object.
 */
export async function handleLiveSupport(ctx) {
    try {
        await ctx.answerCbQuery('Redirecting to Live Support...');
        const supportUrl = 'https://api.whatsapp.com/message/CI6Z5JXNJ3NVM1?autoload=1&app_absent=0';
        const message = `Please click the button below to start a chat with our live support team on WhatsApp.`;
        
        return ctx.editMessageText(message, Markup.inlineKeyboard([
            [Markup.button.url('Chat with Live Support', supportUrl)],
            [Markup.button.callback('⬅️ Back to Support', 'SUPPORT')]
        ]));
    } catch (err) {
        logger.error('Error in handleLiveSupport', { error: err.message, stack: err.stack });
        return ctx.reply('❌ Could not connect to live support at the moment.');
    }
}