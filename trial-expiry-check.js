// netlify/functions/trial-expiry-check.js
//
// Runs on a schedule (see netlify.toml) instead of being called from the browser,
// because nobody's browser is open 3 days after they register — this is the only
// reliable way to catch "trial just ended" and send that email.
//
// What it does each run:
//   1. Finds users whose trial_end is in the past, who haven't been emailed yet
//      (trial_ended_email_sent = false), and who have no approved payment.
//   2. Sends each of them the "Your free trial has ended" email via Brevo.
//   3. Marks trial_ended_email_sent = true so they're never emailed twice.
//
// Required Netlify environment variables (Site settings → Environment variables):
//   SUPABASE_URL              — same value used elsewhere in the app
//   SUPABASE_SERVICE_ROLE_KEY — service role key (Supabase → Project Settings → API)
//                               NOT the anon key — this needs to read/write across
//                               all users, bypassing row-level security.
//   BREVO_API_KEY              — same key used by netlify/functions/brevo-proxy.js

const SENDER_EMAIL = 'talkdoc26@gmail.com';
const SENDER_NAME = 'TalkDoc';

exports.handler = async function () {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !BREVO_API_KEY) {
    console.log('Missing required env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BREVO_API_KEY)');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  const nowISO = new Date().toISOString();

  // 1. Find users whose trial just expired, unpaid, not yet emailed about it.
  //    (approved-payment filter is done in JS below since PostgREST can't easily
  //    express "not exists in another table" through a simple query string.)
  const usersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?select=id,name,email,trial_end&trial_end=lt.${nowISO}&trial_ended_email_sent=eq.false`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  if (!usersRes.ok) {
    const t = await usersRes.text();
    console.log('Could not fetch expired-trial users:', t);
    return { statusCode: 500, body: 'Failed to query users' };
  }
  const candidates = await usersRes.json();
  if (!candidates.length) return { statusCode: 200, body: 'No expired trials to process' };

  let sent = 0, skipped = 0, failed = 0;

  for (const u of candidates) {
    try {
      // Skip anyone who has since paid — don't tell a paying customer their trial ended.
      const payRes = await fetch(
        `${SUPABASE_URL}/rest/v1/payments?select=id&user_id=eq.${u.id}&status=eq.approved&limit=1`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      );
      const payments = payRes.ok ? await payRes.json() : [];
      if (payments.length) { skipped++; continue; }

      const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': BREVO_API_KEY,
        },
        body: JSON.stringify({
          sender: { name: SENDER_NAME, email: SENDER_EMAIL },
          to: [{ email: u.email, name: u.name }],
          subject: 'Your TalkDoc Free Trial Has Ended',
          htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#008181">Your Free Trial Has Ended</h1>
            <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${u.name.split(' ')[0]}, your 3-day free trial on TalkDoc has come to an end. To keep consulting our doctors without interruption, subscribe to one of our plans below.</p>
            <div style="background:#fef3c7;border-radius:12px;padding:20px;margin:20px 0">
              <p style="color:#92400e;font-weight:700;margin:0">⏳ Subscribe now to reactivate your access</p>
            </div>
            <ul style="color:#4a5568;font-size:14px;line-height:1.9;padding-left:20px">
              <li><strong>Monthly Plan</strong> — ₦10,000/month (unlimited consultations)</li>
              <li><strong>Pay Per Consultation</strong> — ₦5,000 (single consultation, no commitment)</li>
            </ul>
            <div style="text-align:center;margin:28px 0">
              <a href="https://talkdoc.ng" style="background:#008181;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">Subscribe Now →</a>
            </div>
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e8ecef;font-size:12px;color:#b0bec5">
              TalkDoc · talkdoc26@gmail.com
            </div>
          </div>`,
        }),
      });

      if (!emailRes.ok) {
        console.log('Brevo send failed for', u.email, await emailRes.text());
        failed++;
        continue;
      }

      // Mark as emailed so this user is never processed again.
      await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${u.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'content-type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ trial_ended_email_sent: true }),
      });
      sent++;
    } catch (e) {
      console.log('Error processing user', u.id, e.message);
      failed++;
    }
  }

  const summary = `Trial-ended emails — sent: ${sent}, skipped (already paid): ${skipped}, failed: ${failed}`;
  console.log(summary);
  return { statusCode: 200, body: summary };
};
