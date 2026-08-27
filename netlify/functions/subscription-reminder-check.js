// netlify/functions/subscription-reminder-check.js
//
// Runs daily. Two jobs, using columns that already existed in your payments
// table (reminder_sent_at, expiry_email_sent_at) but were never wired up
// until now:
//
//   1. Reminder: finds Monthly Plan payments whose next_payment_date is within
//      the next 3 days (and hasn't passed yet) and reminder_sent_at is still
//      null, and emails them — wording differs for auto-debit vs manual.
//   2. Expired: finds Monthly Plan payments that are NOT auto-debit, whose
//      next_payment_date has already passed, and expiry_email_sent_at is still
//      null, and emails them that their plan has lapsed.
//
// Required Netlify environment variables (same ones trial-expiry-check.js uses):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY

const SENDER_EMAIL = 'noreply@talkdoc.ng';
const SENDER_NAME = 'TalkDoc';
const UNLIMITED_PLANS = ['monthly', 'personal', 'family']; // personal/family = legacy plans, still treated as Monthly-equivalent

async function sendBrevoEmail(BREVO_API_KEY, { email, name, subject, htmlContent }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
    body: JSON.stringify({ sender: { name: SENDER_NAME, email: SENDER_EMAIL }, to: [{ email, name }], subject, htmlContent }),
  });
  if (!res.ok) console.log('Brevo send failed for', email, await res.text());
  return res.ok;
}

exports.handler = async function () {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !BREVO_API_KEY) {
    console.log('Missing required env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BREVO_API_KEY)');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const nowISO = now.toISOString();

  let reminded = 0, expiredNotified = 0, failed = 0;

  // ---- Job 1: renewal reminders (3 days out, not yet reminded) ----
  try {
    const planFilter = UNLIMITED_PLANS.map(p => `plan.eq.${p}`).join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?select=id,user_id,plan,auto_debit,next_payment_date&status=eq.approved&or=(${planFilter})&next_payment_date=lte.${in3Days}&next_payment_date=gte.${nowISO}&reminder_sent_at=is.null`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const rows = res.ok ? await res.json() : [];
    for (const row of rows) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${row.user_id}&select=name,email`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        });
        const users = userRes.ok ? await userRes.json() : [];
        const u = users[0];
        if (!u) continue;

        const autoDebit = !!row.auto_debit;
        const dateStr = new Date(row.next_payment_date).toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const ok = await sendBrevoEmail(BREVO_API_KEY, {
          email: u.email, name: u.name,
          subject: autoDebit ? 'Your TalkDoc Plan Renews Soon' : 'Your TalkDoc Plan Expires Soon — Renew to Keep Access',
          htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#008181">${autoDebit ? 'Your Plan Renews Soon' : 'Your Plan Is About to Expire'}</h1>
            <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${u.name.split(' ')[0]}, your TalkDoc Monthly Plan ${autoDebit ? 'will automatically renew' : 'expires'} on <strong>${dateStr}</strong>.</p>
            ${autoDebit
              ? `<div style="background:#d1fae5;border-radius:12px;padding:20px;margin:20px 0"><p style="color:#065f46;font-weight:700;margin:0">💳 We'll automatically charge your card on file — no action needed.</p></div>`
              : `<div style="background:#fef3c7;border-radius:12px;padding:20px;margin:20px 0"><p style="color:#92400e;font-weight:700;margin:0">⏳ Auto-debit is off for your plan — log in and resubscribe before then to avoid losing access.</p></div>
                 <div style="text-align:center;margin:28px 0"><a href="https://talkdoc.ng" style="background:#008181;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">Renew Now →</a></div>`}
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e8ecef;font-size:12px;color:#b0bec5">TalkDoc · talkdoc26@gmail.com</div>
          </div>`,
        });
        if (ok) {
          await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${row.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ reminder_sent_at: nowISO }),
          });
          reminded++;
        } else failed++;
      } catch (e) { console.log('Reminder error for payment', row.id, e.message); failed++; }
    }
  } catch (e) { console.log('Reminder job failed:', e.message); }

  // ---- Job 2: plan-expired notice (manual only, already past due, not yet notified) ----
  try {
    const planFilter = UNLIMITED_PLANS.map(p => `plan.eq.${p}`).join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?select=id,user_id&status=eq.approved&or=(${planFilter})&auto_debit=eq.false&next_payment_date=lt.${nowISO}&expiry_email_sent_at=is.null`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const rows = res.ok ? await res.json() : [];
    for (const row of rows) {
      try {
        const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${row.user_id}&select=name,email`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        });
        const users = userRes.ok ? await userRes.json() : [];
        const u = users[0];
        if (!u) continue;

        const ok = await sendBrevoEmail(BREVO_API_KEY, {
          email: u.email, name: u.name,
          subject: 'Your TalkDoc Monthly Plan Has Expired',
          htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#008181">Your Monthly Plan Has Expired</h1>
            <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${u.name.split(' ')[0]}, your TalkDoc Monthly Plan has expired since it wasn't set to auto-renew. Resubscribe any time to restore unlimited consultations — or turn on auto-debit next time so this doesn't happen again.</p>
            <div style="text-align:center;margin:28px 0"><a href="https://talkdoc.ng" style="background:#008181;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">Resubscribe Now →</a></div>
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e8ecef;font-size:12px;color:#b0bec5">TalkDoc · talkdoc26@gmail.com</div>
          </div>`,
        });
        if (ok) {
          await fetch(`${SUPABASE_URL}/rest/v1/payments?id=eq.${row.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ expiry_email_sent_at: nowISO }),
          });
          expiredNotified++;
        } else failed++;
      } catch (e) { console.log('Expiry notice error for payment', row.id, e.message); failed++; }
    }
  } catch (e) { console.log('Expiry job failed:', e.message); }

  const summary = `Reminders sent: ${reminded}, expiry notices sent: ${expiredNotified}, failed: ${failed}`;
  console.log(summary);
  return { statusCode: 200, body: summary };
};
