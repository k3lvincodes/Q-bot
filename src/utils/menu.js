import { Markup } from 'telegraf';

export function showMainMenu(ctx) {
  const menuButtons = [
    [Markup.button.callback('Join a Subscription', 'BROWSE')],
    [Markup.button.callback('Profile / Settings', 'PROFILE')],
    [Markup.button.callback('Support & FAQs', 'SUPPORT')],
  ];

  if (ctx.session.admin === true || ctx.session.admin === 'true') {
    menuButtons.push([Markup.button.callback('Admin City', 'ADMIN_CITY')]);
  }

  return ctx.reply(
    `Here's what you can do:`,
    Markup.inlineKeyboard(menuButtons)
  );
}

/**
 * Shows the support menu with options for Live Support and FAQs.
 * It's good practice to provide a "Back" button to return to the main menu.
 *
 * @param {import('telegraf').Context} ctx The Telegraf context object.
 */
export function showSupportMenu(ctx) {
  const supportMenuButtons = [
    [Markup.button.callback('Live Support', 'LIVE_SUPPORT')],
    [Markup.button.callback('FAQs', 'FAQS')],
    [Markup.button.callback('⬅️ Back to Main Menu', 'MAIN_MENU')],
  ];

  const message = 'Please choose one of the following support options:';

  return ctx.editMessageText(message, Markup.inlineKeyboard(supportMenuButtons));
}