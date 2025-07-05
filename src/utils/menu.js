// src/utils/menu.js
import { Markup } from 'telegraf';

export function showMainMenu(ctx) {
  return ctx.reply(
    `Here's what you can do:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Browse Subscriptions', 'BROWSE')],
      [Markup.button.callback('My Subscriptions', 'MY_SUBS')],
      [Markup.button.callback('Add My Subscription', 'ADD_SUB')],
      [Markup.button.callback('Wallet / Payments', 'WALLET')],
      [Markup.button.callback('Support & FAQs', 'SUPPORT')],
      [Markup.button.callback('Profile / Settings', 'PROFILE')],
      [Markup.button.callback('Admin City (Admins only)', 'ADMIN_CITY')],
    ])
  );
}