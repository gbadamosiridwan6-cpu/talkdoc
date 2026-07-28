// netlify/functions/paystack-webhook.js
//
// Paystack calls this URL directly (not the browser) whenever something happens
// on a recurring subscription — a renewal charge succeeding, one failing, or a
// subscription being cancelled. This is the auto-debit equivalent of
// trial-expiry-check.js: the events happen days/weeks later, with nobody's
// browser open, so Paystack has to reach a server endpoint instead.
//
// SETUP REQUIRED (one-time):
//   1. Deploy this file at netlify/functions/paystack-webhook.js.
//   2. In Netlify → Site settings → Environment variables, make sure these exist:
//        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (same as trial-expiry-check.js)
//        PAYSTACK_SECRET_KEY                       (from Paystack Dashboard → Settings → API Keys)
//        BREVO_API_KEY                              (already set for other emails)
//   3. In Paystack Dashboard → Settings → API Keys & Webhooks, set the
//      "Webhook URL" to: https://YOUR-SITE.netlify.app/.netlify/functions/paystack-webhook
//   4. Create your two recurring Plans in Paystack Dashboard → Payments → Plans
//      (Personal ₦5,000/monthly, Family ₦10,000/monthly) and paste their plan_code
//      values into PAYSTACK_PLAN_CODES in index.html — that's what makes a payment
//      a subscription in the first place.
//
// What it handles:
//   - subscription.create   → backfills subscription_code/customer_code/next_payment_date
//                              on the payment row that was just created client-side.
//   - charge.success        → if this charge isn't already in our payments table
//                              (i.e. it's an automatic renewal, not the original purchase),
//                              inserts a new approved payment row and emails a receipt.
//   - invoice.payment_failed→ emails the patient to update their card; Paystack will
//                              retry automatically a few times before disabling.
//   - subscription.disable  → marks auto_debit off and emails the patient that
//                              auto-renewal has stopped.

const crypto = require('crypto');

const SENDER_EMAIL = 'talkdoc26@gmail.com';
const SENDER_NAME = 'TalkDoc';

async function sbFetch(path, { method = 'GET', body, SUPABASE_URL, SERVICE_KEY } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: method === 'PATCH' || method === 'POST' ? 'return=representation' : undefined,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { console.log(`Supabase ${method} ${path} failed:`, await res.text()); return null; }
  return res.json();
}

async function sendBrevoEmail(BREVO_API_KEY, { email, name, subject, htmlContent }) {
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({ sender: { name: SENDER_NAME, email: SENDER_EMAIL }, to: [{ email, name }], subject, htmlContent }),
    });
  } catch (e) { console.log('Brevo send failed:', e.message); }
}

exports.handler = async function (event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !PAYSTACK_SECRET_KEY) {
    console.log('Missing required env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / PAYSTACK_SECRET_KEY)');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  // Verify this request genuinely came from Paystack (not a spoofed call).
  const signature = event.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(event.body).digest('hex');
  if (!signature || signature !== expected) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const payload = JSON.parse(event.body);
  const { event: eventType, data } = payload;

  try {
    if (eventType === 'subscription.create') {
      // Find the payment row created client-side by its Paystack reference and
      // fill in the subscription/customer codes plus the real next billing date.
      const reference = data.most_recent_invoice?.transaction_reference || data.authorization?.reference;
      if (reference) {
        await sbFetch(`payments?paystack_reference=eq.${reference}`, {
          method: 'PATCH',
          SUPABASE_URL, SERVICE_KEY,
          body: {
            paystack_subscription_code: data.subscription_code,
            paystack_customer_code: data.customer?.customer_code,
            paystack_email_token: data.email_token,
            auto_debit: true,
            next_payment_date: data.next_payment_date,
          },
        });
      }
    }

    else if (eventType === 'charge.success') {
      // Only act on renewal charges — the very first charge is already recorded
      // by the browser flow in onPaystackSuccess(). Skip if we already have this reference.
      const reference = data.reference;
      const existing = await sbFetch(`payments?paystack_reference=eq.${reference}&select=id`, { SUPABASE_URL, SERVICE_KEY });
      if (existing && existing.length) return { statusCode: 200, body: 'Already recorded, skipping' };
      if (!data.plan) return { statusCode: 200, body: 'Not a subscription charge, skipping' }; // one-off payments, e.g. specialist bookings

      const planCode = data.plan.plan_code;
      const planName = data.plan.name?.toLowerCase().includes('family') ? 'family' : 'personal';
      const customerEmail = data.customer?.email;

      // Find the user this subscription belongs to via a prior payment with the same subscription/customer.
      const priorRows = await sbFetch(
        `payments?paystack_customer_code=eq.${data.customer?.customer_code}&select=user_id&order=created_at.desc&limit=1`,
        { SUPABASE_URL, SERVICE_KEY }
      );
      const userId = priorRows && priorRows[0]?.user_id;
      if (!userId) { console.log('Could not match renewal charge to a user:', customerEmail); return { statusCode: 200, body: 'No matching user' }; }

      const nextPaymentDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sbFetch('payments', {
        method: 'POST', SUPABASE_URL, SERVICE_KEY,
        body: {
          user_id: userId, plan: planName, amount: data.amount / 100, method: 'paystack',
          status: 'approved', paystack_reference: reference, auto_debit: true,
          next_payment_date: nextPaymentDate, paystack_customer_code: data.customer?.customer_code,
        },
      });

      const userRows = await sbFetch(`users?id=eq.${userId}&select=name,email`, { SUPABASE_URL, SERVICE_KEY });
      const u = userRows && userRows[0];
      if (u && BREVO_API_KEY) {
        await sendBrevoEmail(BREVO_API_KEY, {
          email: u.email, name: u.name,
          subject: 'TalkDoc Subscription Renewed ✅',
          htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#008181">Subscription Renewed</h1>
            <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${u.name.split(' ')[0]}, your TalkDoc ${planName==='family'?'Family':'Personal'} Plan was automatically renewed. Your card was charged ₦${(data.amount/100).toLocaleString()}.</p>
            <p style="color:#4a5568;font-size:14px;line-height:1.75">Next renewal: ${new Date(nextPaymentDate).toLocaleDateString('en-NG',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}.</p>
          </div>`,
        });
      }
    }

    else if (eventType === 'invoice.payment_failed') {
      const customerEmail = data.customer?.email;
      const name = `${data.customer?.first_name || ''} ${data.customer?.last_name || ''}`.trim() || customerEmail;
      if (customerEmail && BREVO_API_KEY) {
        await sendBrevoEmail(BREVO_API_KEY, {
          email: customerEmail, name,
          subject: 'TalkDoc Auto-Renewal Payment Failed',
          htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#c0392b">We Couldn't Renew Your Subscription</h1>
            <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${name.split(' ')[0]}, we tried to auto-renew your TalkDoc subscription but the charge didn't go through. Please update your card or log in and resubscribe to keep uninterrupted access.</p>
          </div>`,
        });
      }
    }

    else if (eventType === 'subscription.disable') {
      const subscriptionCode = data.subscription_code;
      if (subscriptionCode) {
        await sbFetch(`payments?paystack_subscription_code=eq.${subscriptionCode}`, {
          method: 'PATCH', SUPABASE_URL, SERVICE_KEY, body: { auto_debit: false },
        });
      }
      const customerEmail = data.customer?.email;
      const name = `${data.customer?.first_name || ''} ${data.customer?.last_name || ''}`.trim() || customerEmail;
      if (customerEmail && BREVO_API_KEY) {
        await sendBrevoEmail(BREVO_API_KEY, {
          email: customerEmail, name,
          subject: 'TalkDoc Auto-Renewal Has Stopped',
          htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#008181">Auto-Renewal Stopped</h1>
            <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${name.split(' ')[0]}, auto-renewal for your TalkDoc subscription has been turned off, so your plan will not be charged again automatically. Log in any time to resubscribe.</p>
          </div>`,
        });
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.log('Webhook processing error:', e.message);
    return { statusCode: 500, body: 'Processing error' };
  }
};
