import { Markup } from 'telegraf';

export const addSubscriptionWorkflow = async (ctx) => {
  ctx.session.step = null;
  ctx.session.subPlan = null;
  ctx.session.subSlot = null;
  ctx.session.subDuration = null;
  ctx.session.subAmount = null;
  ctx.session.subCat = null;
  ctx.session.subSubCat = null;
  ctx.session.availablePlans = [];

  await ctx.reply('Welcome to *Add My Subscription*!', { parse_mode: 'Markdown' });
  return ctx.reply('Select a category:', Markup.inlineKeyboard([
    [Markup.button.callback('Streaming (Movies/TV)', 'CATEGORY_Streaming (Movies/TV)')],
    [Markup.button.callback('Music', 'CATEGORY_Music')],
    [Markup.button.callback('Education and Online Learning', 'CATEGORY_Education and Online Learning')],
    [Markup.button.callback('Fitness and Wellness', 'CATEGORY_Fitness and Wellness')],
    [Markup.button.callback('Gaming', 'CATEGORY_Gaming')],
    [Markup.button.callback('Cloud Storage and Productivity Tools', 'CATEGORY_Cloud Storage and Productivity Tools')],
    [Markup.button.callback('News and Magazines', 'CATEGORY_News and Magazines')],
    [Markup.button.callback('Books and Audiobooks', 'CATEGORY_Books and Audiobooks')],
    [Markup.button.callback('Software and Design Tools', 'CATEGORY_Software and Design Tools')],
    [Markup.button.callback('Kids and Family', 'CATEGORY_Kids and Family')],
    [Markup.button.callback('Return to Main Menu', 'RETURN_TO_MAIN_MENU')]
  ]));
};

const categoryMap = {
  'Streaming (Movies/TV)': [
    'Netflix', 'Hulu', 'Disney+', 'Amazon Prime Video', 'HBO Max', 'Apple TV+', 'Paramount+',
    'Peacock', 'Crunchyroll', 'Sling TV', 'YouTube Premium'
  ],
  'Music': [
    'Spotify', 'Apple Music', 'Amazon Music', 'YouTube Music', 'Tidal', 'Deezer', 'Pandora'
  ],
  'Education and Online Learning': [
    'LinkedIn Learning', 'Skillshare'
  ],
  'Fitness and Wellness': [
    'Peloton', 'Calm', 'Headspace', 'Apple Fitness+'
  ],
  'Gaming': [
    'Xbox', 'PlayStation Plus', 'Nintendo Switch Online'
  ],
  'Cloud Storage and Productivity Tools': [
    'Google One', 'Microsoft 365', 'Dropbox', 'iCloud+'
  ],
  'News and Magazines': [
    'The New York Times'
  ],
  'Books and Audiobooks': [
    'Audible', 'Scribd', 'Kindle Unlimited'
  ],
  'Software and Design Tools': [
    'Canva', 'Adobe Creative Cloud'
  ],
  'Kids and Family': [
    'ABCmouse', 'Epic!'
  ]
};

export const handleSubCategorySelection = async (ctx, category) => {
  ctx.session.subCat = category;

  const subcategories = categoryMap[category] || [];
  const buttons = subcategories.map(name =>
    [Markup.button.callback(name, `SUBCATEGORY_${name.replace(/ /g, '_')}`)]
  );

  buttons.push([Markup.button.callback('Return to Category', 'ADD_SUB')]);

  await ctx.answerCbQuery();
  return ctx.editMessageText(`*${category} Subscriptions:*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons),
  });
};

export const handlePlanSelection = async (ctx, subSubCat) => {
  subSubCat = subSubCat.replace(/_/g, ' ');
  ctx.session.subSubCat = subSubCat;

  const planMap = {
    'Netflix': ['Netflix Standard', 'Netflix Premium'],
    'Hulu': ['Hulu + Live TV (2 Users Max)', 'Hulu + Live TV with Unlimited Screens (3+ Users)'],
    'Disney+': ['Disney+ Premium'],
    'Amazon Prime Video': ['Amazon Prime Video Household Sharing'],
    'HBO Max': ['HBO Max Ad-Free'],
    'Apple TV+': ['Apple TV+ Family Sharing'],
    'Paramount+': ['Paramount+ Premium'],
    'Peacock': ['Peacock Premium'],
    'Crunchyroll': ['Crunchyroll Mega Fan', 'Crunchyroll Ultimate Fan'],
    'Sling TV': ['Sling TV Blue', 'Sling Orange & Blue'],
    'YouTube Premium': ['YouTube Premium Family'],
    'Spotify': ['Spotify Duo', 'Spotify Family'],
    'Apple Music': ['Apple Music Family'],
    'Amazon Music': ['Amazon Music Unlimited Family'],
    'YouTube Music': ['YouTube Music Family'],
    'Tidal': ['Tidal HiFi Family'],
    'Deezer': ['Deezer Family'],
    'Pandora': ['Pandora Premium Family'],
    'LinkedIn Learning': ['LinkedIn Learning Teams (multi-user)'],
    'Skillshare': ['Skillshare Teams (multi-user)'],
    'Peloton': ['Peloton All-Access (unlimited household slots)'],
    'Calm': ['Calm Family Plan'],
    'Headspace': ['Headspace Family Plan'],
    'Apple Fitness+': ['Apple Fitness+ Family'],
    'Xbox': ['Xbox Game Pass Friends & Family'],
    'PlayStation Plus': ['PlayStation Plus (Family accounts)'],
    'Nintendo Switch Online': ['Nintendo Switch Online Family'],
    'Google One': ['Google One Family'],
    'Microsoft 365': ['Microsoft 365 Family'],
    'Dropbox': ['Dropbox Family'],
    'iCloud+': ['iCloud+ Family Sharing'],
    'The New York Times': ['NYT Household Sharing'],
    'Audible': ['Audible Household Library'],
    'Scribd': ['Scribd Family'],
    'Kindle Unlimited': ['Kindle Unlimited Household Sharing'],
    'Canva': ['Canva for Teams'],
    'Adobe Creative Cloud': ['Adobe Creative Cloud Teams'],
    'ABCmouse': ['ABCmouse'],
    'Epic!': ['Epic!']
  };

  const plans = planMap[subSubCat] || [];
  plans.push('Return to Category');

  ctx.session.availablePlans = plans;

  await ctx.answerCbQuery();
  return ctx.reply(`Select a plan under *${subSubCat}*:\n(You can type the name or tap below)`, {
    parse_mode: 'Markdown',
    ...Markup.keyboard(plans).oneTime().resize()
  });
};