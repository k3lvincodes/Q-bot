import { Markup } from 'telegraf';
import subscriptionPlansMap from '../../utils/subscription-prices.js';

function escapeMarkdownV2(text) {
  return (text || '')
    .toString()
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export const addSubscriptionWorkflow = async (ctx) => {
  ctx.session.step = null;
  ctx.session.subCat = null;
  ctx.session.subSubCat = null;
  ctx.session.subPlan = null;
  ctx.session.subAmount = null;

  const categories = [
    'Streaming (Movies/TV)',
    'Music',
    'Education and Online Learning',
    'Fitness and Wellness',
    'Gaming',
    'Cloud Storage and Productivity Tools',
    'News and Magazines',
    'Books and Audiobooks',
    'Software and Design Tools',
    'Kids and Family',
    'Return to Main Menu'
  ];

  await ctx.reply('🎬 Welcome to Add My Subscription!\n\nPlease select a category:', Markup.inlineKeyboard(
    categories.map((c) => [Markup.button.callback(c, `CATEGORY_${c.replace(/ /g, '_')}`)])
  ));
};

export const handleSubCategorySelection = async (ctx, category) => {
  ctx.session.subCat = category;
  ctx.session.subSubCat = null;
  ctx.session.subPlan = null;
  ctx.session.subAmount = null;

  const subcategoriesMap = {
    'Streaming (Movies/TV)': ['Netflix', 'Hulu', 'Disney+', 'Amazon Prime Video', 'HBO Max', 'Apple TV+', 'Paramount+', 'Peacock', 'Crunchyroll', 'Sling TV', 'YouTube Premium'],
    'Music': ['Spotify', 'Apple Music', 'Amazon Music', 'YouTube Music', 'Tidal', 'Deezer', 'Pandora'],
    'Education and Online Learning': ['LinkedIn Learning', 'Skillshare'],
    'Fitness and Wellness': ['Peloton', 'Calm', 'Headspace', 'Apple Fitness+'],
    'Gaming': ['Xbox', 'PlayStation Plus', 'Nintendo Switch Online'],
    'Cloud Storage and Productivity Tools': ['Google One', 'Microsoft 365', 'Dropbox', 'iCloud+'],
    'News and Magazines': ['The New York Times'],
    'Books and Audiobooks': ['Audible', 'Scribd', 'Kindle Unlimited'],
    'Software and Design Tools': ['Canva', 'Adobe Creative Cloud'],
    'Kids and Family': ['ABCmouse', 'Epic!']
  };

  const options = subcategoriesMap[category] || [];
  options.push('Return to Category');

  const escapedCat = escapeMarkdownV2(category); // ✅ Corrected from subSubCat to category
  await ctx.editMessageText(`📂 You selected: *${escapedCat}*\n\nNow choose a subcategory:`, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(
      options.map((sub) => [
        Markup.button.callback(sub, sub === 'Return to Category' ? 'RETURN_TO_CATEGORY' : `SUBCATEGORY_${sub.replace(/ /g, '_')}`)
      ])
    )
  });
};

export const handlePlanSelection = async (ctx, subSubCat) => {
  ctx.session.subSubCat = subSubCat;
  ctx.session.subPlan = null;
  ctx.session.subAmount = null;

  const plans = Object.keys(subscriptionPlansMap).filter((plan) => plan.toLowerCase().includes(subSubCat.toLowerCase()));

  if (plans.length === 0) {
    await ctx.reply('❌ No plans available for this selection.');
    return addSubscriptionWorkflow(ctx);
  }

  const buttons = plans.map((plan) => [
    Markup.button.callback(plan, `PLAN_ID_${Buffer.from(plan).toString('base64')}`)
  ]);
  buttons.push([Markup.button.callback('Return to Category', 'RETURN_TO_CATEGORY')]);

  await ctx.editMessageText(
    `📺 You selected: *${escapeMarkdownV2(subSubCat)}*\n\nNow choose a plan:`, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons)
    }
  );
};