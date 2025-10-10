// Deno standard library for serving HTTP requests
import { serve } from 'std/http/server.ts'
// Telegraf library for creating Telegram bots
import { Composer, Context, Markup, session, Telegraf } from 'telegraf'
// Supabase client library for Deno/Edge Functions
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// --- WORKFLOWS & UTILS ---
// NOTE: In a real-world scenario, these would be in separate files.
// For this single-file function, they are included here.
import {
  addSubscriptionWorkflow,
  handleSubCategorySelection,
  handlePlanSelection,
} from './workflows/add-subscription.ts'
import {
  browseSubscriptionsWorkflow,
  handleBrowseCategorySelection,
  handleBrowseSubcategorySelection,
  handleSubscriptionSelection,
  initiatePayment,
  verifyPayment,
  cancelPayment,
} from './workflows/browse-subscriptions.ts'

// --- ENVIRONMENT VARIABLE VALIDATION ---
// Fail fast if any required environment variables are missing.
const requiredEnv = ['BOT_TOKEN', 'TELEGRAM_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const envVar of requiredEnv) {
  if (!Deno.env.get(envVar) && !Deno.env.get(`SUPABASE_AUTH_${envVar}`)) { // Support for local dev
    throw new Error(`${envVar} is not set in environment variables.`);
  }
}

const BOT_TOKEN = Deno.env.get('BOT_TOKEN')!;
const TELEGRAM_SECRET = Deno.env.get('TELEGRAM_SECRET')!;

// --- SUPABASE CLIENT INITIALIZATION ---
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const bot = new Telegraf(BOT_TOKEN)
// --- SESSION MANAGEMENT ---

/**
 * A custom session store for Telegraf that uses a Supabase table.
 */
class SupabaseSessionStore<T> {
  constructor(private readonly supabase: SupabaseClient) {}

  async get(name: string): Promise<T | undefined> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select('session_data')
      .eq('session_key', name)
      .single();

    if (error && error.code !== 'PGRST116') { // 'PGRST116' is "exact one row not found"
      console.error('SupabaseSessionStore get error:', error);
    }
    return data?.session_data as T | undefined;
  }

  async set(name: string, value: T): Promise<void> {
    const { error } = await this.supabase
      .from('sessions')
      .upsert({ session_key: name, session_data: value }, { onConflict: 'session_key' });

    if (error) {
      console.error('SupabaseSessionStore set error:', error);
    }
  }

  async delete(name: string): Promise<void> {
    const { error } = await this.supabase
      .from('sessions')
      .delete()
      .eq('session_key', name);

    if (error) {
      console.error('SupabaseSessionStore delete error:', error);
    }
  }
}

interface SessionData {
  // Registration
  step?: string | null;
  fullName?: string;
  email?: string;
  verificationCode?: string;
  persistentUser?: 'yes' | 'no';
  platform?: string;
  userId?: string;
  firstName?: string;
  admin?: 'true' | 'false';

  // Subscription Listing
  subCat?: string | null;
  subSubCat?: string | null;
  subPlan?: string | null;
  subAmount?: number | null;
  subSlot?: number | null;
  subDuration?: number | null;
  subEmail?: string | null;
  subPassword?: string | null;
  shareType?: 'login' | 'otp' | null;
  whatsappNo?: string | null;
  subId?: string | null;

  // Browsing
  browseCategory?: string | null;
  browseSubcategory?: string | null;
  browsePage?: number;
  browseSort?: 'newest' | 'oldest';
  selectedSubId?: string | null;
  authUrl?: string | null;

  // Other workflows can be added here
}

interface CustomContext extends Context {
  session: SessionData;
}

const store = new SupabaseSessionStore<SessionData>(supabaseAdmin);
bot.use(session({ store, defaultSession: () => ({}) }));

// --- MIDDLEWARE to check registration ---

/**
 * Clears all workflow-related data from the session.
 * A direct port from the original `clearListingSession` function.
 */
function clearListingSession(ctx: CustomContext) {
  ctx.session.step = null;
  ctx.session.subCat = null;
  ctx.session.subSubCat = null;
  ctx.session.subPlan = null;
  ctx.session.subAmount = null;
  ctx.session.subSlot = null;
  ctx.session.subDuration = null;
  ctx.session.subEmail = null;
  ctx.session.subPassword = null;
  ctx.session.shareType = null;
  ctx.session.whatsappNo = null;
  ctx.session.subId = null;
  ctx.session.browseCategory = null;
  ctx.session.browseSubcategory = null;
  ctx.session.browsePage = 0;
  ctx.session.browseSort = 'newest';
  ctx.session.selectedSubId = null;
  ctx.session.authUrl = null;
  // Other session properties from different workflows would be cleared here too
}

const ensureRegistered = async (ctx: CustomContext, next: () => Promise<void>) => {
  if (!ctx.from) return;
  ctx.session.userId = String(ctx.from.id);

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('userId, email, fullName, admin')
    .eq('userId', String(ctx.from.id))
    .single();

  if (user) {
    // User is registered, proceed to the actual command/handler
    return next();
  }
  // User not found, start registration
  ctx.session.persistentUser = 'no';
  ctx.session.platform = 'telegram';
  ctx.session.step = 'collectFullName';
  await ctx.reply('Welcome to Q! To get started, please enter your full name:');

  // If it's a callback query, answer it to remove the loading state
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(e => console.warn('Failed to answer CB query in ensureRegistered', e.message));
  }
};

// --- REGISTRATION WORKFLOW ---

async function handleRegistration(ctx: CustomContext) {
  const text = (ctx.message as any)?.text?.trim();
  if (!text) return;

  switch (ctx.session.step) {
    case 'collectFullName': {
      if (!text.trim()) {
        return await ctx.reply('Please enter a valid full name.');
      }
      ctx.session.fullName = text;
      ctx.session.firstName = text.trim().split(' ')[0] || text.trim();
      ctx.session.step = 'collectEmail';
      await handleFullNameInput(ctx, text);
      break;
    }

    case 'collectEmail': {
      const email = text.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return await ctx.reply('❌ That doesn\'t look like a valid email. Please try again.');
      }

      const { data: existingUser } = await supabaseAdmin.from('users').select('userId').eq('email', email).single();
      if (existingUser) {
        return await ctx.reply('❌ This email is already registered. Please use a different one.');
      }

      ctx.session.email = email;
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      ctx.session.verificationCode = verificationCode;
      ctx.session.step = 'verifyCode';

      const payload = {
        name: ctx.session.firstName,
        email: ctx.session.email,
        verification: ctx.session.verificationCode,
      };

      try {
        // Ported from original bot: send verification code via Make.com webhook
        await fetch('https://hook.eu2.make.com/1rzify472wbi8lzbkazby3yyb7ot9rhp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        console.info('Verification email webhook sent', { userId: ctx.session.userId, email: ctx.session.email });
      } catch (e) {
        console.error('Email webhook failed', { error: e.message, userId: ctx.session.userId });
        await ctx.reply('❌ Failed to send verification email. Please try again.');
        ctx.session.step = null; // Reset step
        // Here you would show the main menu
        return;
      }

      await ctx.reply('✅ Enter the code sent to your email:');
      break;
    }

    case 'verifyCode': {
      if (text !== ctx.session.verificationCode) {
        return await ctx.reply('❌ Invalid verification code. Please try again.');
      }

      try {
        // Capture the response from the insert operation
        const { error: insertError } = await supabaseAdmin.from('users').insert({
          userId: ctx.session.userId,
          fullName: ctx.session.fullName,
          email: ctx.session.email,
          platform: ctx.session.platform,
          admin: false,
          verified: false, // As per original bot logic
        });

        // Explicitly check for a database error and throw it if it exists
        if (insertError) throw insertError;

        ctx.session.step = null;
        ctx.session.persistentUser = 'yes';
        await ctx.reply("✅ You're now registered!");
        // The menu will be shown on the user's next interaction via the main text handler.
      } catch (err) {
        console.error('Failed to register user', { error: err.message, userId: ctx.session.userId });
        ctx.session.step = null;
        await ctx.reply('❌ Error registering user. Please start over.');
      }
      break;
    }
  }
}

// --- MENU ---

function showMainMenu(ctx: CustomContext) {
  const menuButtons = [
    [Markup.button.callback('Join a Subscription', 'BROWSE')],
    [Markup.button.callback('Profile / Settings', 'PROFILE')],
    [Markup.button.callback('Support & FAQs', 'SUPPORT')],
  ];

  if (ctx.session.admin === 'true') {
    menuButtons.push([Markup.button.callback('Admin City', 'ADMIN_CITY')]);
  }

  return ctx.reply(`Here's what you can do:`, Markup.inlineKeyboard(menuButtons));
}


// --- COMMANDS & MESSAGE HANDLERS ---

bot.start(async (ctx: CustomContext, next) => {
  if (!ctx.from) return;
  const telegramId = String(ctx.from.id);
  ctx.session = { userId: telegramId }; // Full reset
  clearListingSession(ctx); // Reset any existing workflow

  const { data: user } = await supabaseAdmin.from('users').select('fullName').eq('userId', telegramId).single();

  if (user) {
    ctx.session.persistentUser = 'yes';
    ctx.session.firstName = user.fullName?.split(' ')[0] || '';
    ctx.session.fullName = user.fullName;
    await ctx.reply(`Welcome back to Q, ${ctx.session.firstName}!`);
    await showMainMenu(ctx);
  } else {
    ctx.session.step = 'collectFullName';
    await ctx.reply('Welcome to Q! To get started, please enter your full name:');
  }
});

bot.command('profile', ensureRegistered, async (ctx: CustomContext) => {
  // This code only runs for registered users
  const { data: user } = await supabaseAdmin.from('users').select('*').eq('userId', String(ctx.from?.id)).single();
  if (!user) return; // Should not happen due to middleware

  const profileMessage = `👤 *Your Profile*\n\n*Name:* ${user.fullName}\n*Email:* ${user.email}\n*Member Since:* ${new Date(user.createdAt).toLocaleDateString()}`;
  await ctx.replyWithMarkdown(profileMessage);
});

bot.hears(/menu/i, ensureRegistered, async (ctx: CustomContext) => {
  console.info('Menu command triggered', { telegramId: ctx.from?.id });
  clearListingSession(ctx);
  return showMainMenu(ctx);
});

bot.on('text', async (ctx: CustomContext) => {
  // If a registration or another multi-step workflow is in progress, handle it.
  if (ctx.session.step) {
    return handleRegistration(ctx);
  }

  // If no workflow is active, ensure the user is registered before proceeding.
  // The `ensureRegistered` middleware will either call `next()` for registered users,
  // or it will start the registration process for new users and stop further execution.
  await ensureRegistered(ctx, async () => {
    // This block will only run for registered users who are not in a workflow.
    // For any text that isn't a command, we show the main menu.
    await showMainMenu(ctx);
  });
});

// --- ACTION HANDLERS (Callback Queries) ---

const registeredComposer = new Composer<CustomContext>();
registeredComposer.use(ensureRegistered);

registeredComposer.action('BROWSE', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return browseSubscriptionsWorkflow(ctx, supabaseAdmin);
});

registeredComposer.action(/^BROWSE_CAT_(.+)$/, async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  const category = ctx.match[1].replace(/_/g, ' ');
  return handleBrowseCategorySelection(ctx, category, supabaseAdmin);
});

registeredComposer.action(/^BROWSE_SUBCAT_(.+)$/, async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  const subcategory = ctx.match[1].replace(/_/g, ' ');
  return handleBrowseSubcategorySelection(ctx, subcategory, supabaseAdmin);
});

registeredComposer.action('BROWSE_BACK', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  return browseSubscriptionsWorkflow(ctx, supabaseAdmin);
});

registeredComposer.action('BROWSE_PREV', async (ctx) => {
  ctx.session.browsePage = Math.max(0, (ctx.session.browsePage || 0) - 1);
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory!, supabaseAdmin);
});

registeredComposer.action('BROWSE_NEXT', async (ctx) => {
  ctx.session.browsePage = (ctx.session.browsePage || 0) + 1;
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory!, supabaseAdmin);
});

registeredComposer.action('SORT_NEWEST', async (ctx) => {
  ctx.session.browseSort = 'newest';
  ctx.session.browsePage = 0;
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory!, supabaseAdmin);
});

registeredComposer.action('SORT_OLDEST', async (ctx) => {
  ctx.session.browseSort = 'oldest';
  ctx.session.browsePage = 0;
  await ctx.deleteMessage().catch(() => {});
  return handleBrowseSubcategorySelection(ctx, ctx.session.browseSubcategory!, supabaseAdmin);
});

registeredComposer.action(/^SELECT_SUB_(.+)$/, async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  const subId = ctx.match[1];
  return handleSubscriptionSelection(ctx, subId, supabaseAdmin);
});

registeredComposer.action('PAY_SUB', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  return initiatePayment(ctx, supabaseAdmin);
});

registeredComposer.action('VERIFY_PAYMENT', async (ctx) => {
  return verifyPayment(ctx, supabaseAdmin);
});

registeredComposer.action('CANCEL_PAYMENT', async (ctx) => {
  return cancelPayment(ctx);
});

registeredComposer.action('PROFILE', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  return ctx.reply(
    'Profile / Settings:',
    Markup.inlineKeyboard([
      // [Markup.button.callback('View Personal Info', 'VIEW_PERSONAL_INFO')],
      [Markup.button.callback('My Subscriptions', 'MY_SUBS')],
      // [Markup.button.callback('Request Subscription', 'REQUEST_SUB')],
      // [Markup.button.callback('Wallet / Payments', 'WALLET')],
      [Markup.button.callback('Back to Main Menu', 'MAIN_MENU')],
    ])
  );
});

registeredComposer.action('MAIN_MENU', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  clearListingSession(ctx);
  return showMainMenu(ctx);
});

registeredComposer.action('ADMIN_CITY', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  if (ctx.session.admin !== 'true') {
    return ctx.reply('❌ Access restricted to admins only.');
  }
  return ctx.reply(
    'Welcome to Admin City!',
    Markup.inlineKeyboard([
      [Markup.button.callback('Add Subscription', 'ADD_SUB')],
      [Markup.button.callback('Back to Main Menu', 'MAIN_MENU')],
    ])
  );
});

// --- Use the composer for all callback queries ---
bot.use(registeredComposer);


// --- EDGE FUNCTION MAIN HANDLER ---
// This function is executed for every incoming request to the function's URL.

serve(async (req) => {
  try {
    // The 'x-telegram-bot-api-secret-token' header is a security measure.
    // It's a secret token you set when you register the webhook.
    if (req.headers.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET) {
      console.warn('Invalid secret token received');
      return new Response('not allowed', { status: 405 });
    }

    const update = await req.json();
    await bot.handleUpdate(update);

    // Answer callback query if not already answered
    if (update.callback_query) {
      await bot.telegram.answerCbQuery(update.callback_query.id).catch(e => console.warn('Failed to answer CB query in main handler', e.message));
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('Error in webhook handler:', err);
    return new Response('Internal Server Error', { status: 500 })
  }
})