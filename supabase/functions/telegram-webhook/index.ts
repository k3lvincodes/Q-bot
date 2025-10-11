import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

// --- ENVIRONMENT VARIABLE VALIDATION ---
const requiredEnv = ['TELEGRAM_SECRET', 'FORWARD_URL'];
for (const envVar of requiredEnv) {
    if (!Deno.env.get(envVar) && !Deno.env.get(`SUPABASE_AUTH_${envVar}`)) {
        throw new Error(`${envVar} is not set in environment variables.`);
    }
}

const TELEGRAM_SECRET = Deno.env.get('TELEGRAM_SECRET') || Deno.env.get('SUPABASE_AUTH_TELEGRAM_SECRET')!;
const FORWARD_URL = Deno.env.get('FORWARD_URL') || Deno.env.get('SUPABASE_AUTH_FORWARD_URL')!;

serve(async (req) => {
    try {
        // 1. Check HTTP method
        if (req.method !== 'POST') {
            return new Response('Method not allowed', { 
                status: 405,
                headers: { 'Allow': 'POST' }
            });
        }

        // 2. Verify the request is from Telegram
        if (req.headers.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET) {
            console.warn('Invalid secret token received');
            return new Response('not allowed', { status: 403 });
        }

        // 3. Check content type
        const contentType = req.headers.get('content-type');
        if (!contentType?.includes('application/json')) {
            return new Response('Invalid content type', { status: 400 });
        }

        // 4. Get the request body
        const body = await req.json();

        // 5. Forward the request (now with better error handling)
        try {
            const forwardResponse = await fetch(FORWARD_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'User-Agent': 'Telegram-Webhook-Forwarder/1.0'
                },
                body: JSON.stringify(body),
            });

            if (!forwardResponse.ok) {
                console.error(`Forward request failed: ${forwardResponse.status}`);
            }
        } catch (fetchError) {
            console.error('Error forwarding webhook:', fetchError);
            // Continue - we still want to respond to Telegram
        }

        // 6. Respond to Telegram immediately
        return new Response('ok', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
        });

    } catch (err) {
        console.error('Error in webhook handler:', err);
        return new Response('Internal Server Error', { status: 500 });
    }
});