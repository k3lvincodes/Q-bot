// Deno standard library for serving HTTP requests
import { serve } from 'std/http/server.ts'

// --- ENVIRONMENT VARIABLE VALIDATION ---
// Fail fast if any required environment variables are missing.
const requiredEnv = ['TELEGRAM_SECRET', 'FORWARD_URL'];
for (const envVar of requiredEnv) {
  // Support for local dev using `supabase start` which prefixes secrets
  if (!Deno.env.get(envVar) && !Deno.env.get(`SUPABASE_AUTH_${envVar}`)) {
    throw new Error(`${envVar} is not set in environment variables.`);
  }
}

const TELEGRAM_SECRET = Deno.env.get('TELEGRAM_SECRET') || Deno.env.get('SUPABASE_AUTH_TELEGRAM_SECRET')!;
const FORWARD_URL = Deno.env.get('FORWARD_URL') || Deno.env.get('SUPABASE_AUTH_FORWARD_URL')!;

// --- EDGE FUNCTION MAIN HANDLER ---
// This function is executed for every incoming request to the function's URL.
serve(async (req) => {
  try {
    // 1. Verify the request is from Telegram
    if (req.headers.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET) {
      console.warn('Invalid secret token received');
      return new Response('not allowed', { status: 405 });
    }

    // 2. Get the request body to forward it
    const body = await req.json();

    // 3. Forward the request to the main Node.js bot application
    // We don't `await` this, because Telegram has a short timeout.
    // We will now `await` this to ensure the request is sent before the function terminates.
    // The network call from Supabase to Render should be fast enough to not cause a timeout.
    await fetch(FORWARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err) => {
      // Log any errors from the forwarding request
      console.error('Error forwarding webhook:', err);
    });

    // 4. Respond to Telegram immediately with a 200 OK
    return new Response('ok');
  } catch (err) {
    console.error('Error in webhook handler:', err);
    return new Response('Internal Server Error', { status: 500 })
  }
})