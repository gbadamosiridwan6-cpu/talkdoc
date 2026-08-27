// netlify/functions/submit-lead.js
//
// Handles form submissions from ad landing pages (like skin-rash.html).
// Runs server-side so the Brevo API key never has to be exposed to a public
// landing page, and so leads are saved even if something on the client
// fails partway through.
//
// What it does, in order:
//   1. Saves the lead to Supabase (via service role — landing pages have no
//      Supabase session, so this can't go through normal RLS-protected calls).
//   2. Adds them to your main Brevo list (List ID 3 — same one your
//      newsletter signups go to), so they start getting your regular emails
//      as promised on the landing page.
//   3. Emails the LEAD themselves with a link to download the free eBook —
//      this is what the landing page's thank-you message promises, and
//      without this step nothing was actually being sent to them.
//   4. Emails your team so someone can actually follow up and connect them
//      with a doctor.
//
// Required Netlify environment variables (same ones your other functions use):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY
//
// NOTE: EBOOK_URL below assumes your live domain is talkdoc.ng and that
// ebook-common-skin-diseases.pdf sits at the root of your deployed site
// (same level as index.html) — update it if either of those isn't true.

const SENDER_EMAIL = 'noreply@talkdoc.ng';
const SENDER_NAME = 'TalkDoc';
const TEAM_EMAIL = 'talkdoc26@gmail.com'; // where new-lead notifications go
const BREVO_LIST_ID = 3; // same list your newsletter/registration signups already go to
const EBOOK_URL = 'https://talkdoc.ng/ebook-common-skin-diseases.pdf';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: 'ok' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BREVO_API_KEY = process.env.BREVO_API_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is not configured yet.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim();
  const source = (body.source || 'general').trim();

  if (!name || !email || !phone) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please fill in your name, email, and phone number.' }) };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  try {
    // 1. Save the lead
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'content-type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ name, email, phone, source }),
    });
    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.log('Could not save lead:', errText);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not submit right now. Please try again.' }) };
    }

    // 2. Add to your Brevo list (best-effort — don't fail the whole
    // submission just because this part has a hiccup)
    if (BREVO_API_KEY) {
      try {
        await fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
          body: JSON.stringify({
            email,
            attributes: { FIRSTNAME: name.split(' ')[0], LASTNAME: name.split(' ').slice(1).join(' '), SMS: phone },
            listIds: [BREVO_LIST_ID],
            updateEnabled: true,
          }),
        });
      } catch (e) { console.log('Could not add lead to Brevo list:', e.message); }

      // 3. Email the lead their free eBook — this is the part that was
      // missing before. The landing page's thank-you message promises this,
      // so it needs to actually happen.
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
          body: JSON.stringify({
            sender: { name: SENDER_NAME, email: SENDER_EMAIL },
            to: [{ email, name }],
            subject: 'Your Free eBook: Common Skin Diseases 📘',
            htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px">
              <h1 style="color:#008181">Here's Your Free eBook!</h1>
              <p style="color:#4a5568;font-size:15px;line-height:1.75">Hi ${name.split(' ')[0]}, thanks for reaching out to TalkDoc about your skin rash. As promised, here's your free copy of our guide, <strong>Common Skin Diseases: A Home Guide</strong> — covering symptoms, home care tips, and when to see a doctor for six common skin conditions.</p>
              <div style="text-align:center;margin:28px 0">
                <a href="${EBOOK_URL}" style="background:#008181;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">Download Your eBook →</a>
              </div>
              <p style="color:#4a5568;font-size:14px;line-height:1.75">A member of our customer care team will also be in touch shortly to connect you with a doctor about your rash.</p>
              <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e8ecef;font-size:12px;color:#b0bec5">
                TalkDoc · talkdoc26@gmail.com
              </div>
            </div>`,
          }),
        });
      } catch (e) { console.log('Could not send eBook email to lead:', e.message); }

      // 4. Notify the team
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-key': BREVO_API_KEY },
          body: JSON.stringify({
            sender: { name: SENDER_NAME, email: SENDER_EMAIL },
            to: [{ email: TEAM_EMAIL, name: 'TalkDoc Team' }],
            subject: `New Lead (${source}): ${name}`,
            htmlContent: `<div style="font-family:Segoe UI,sans-serif;max-width:500px;margin:0 auto;padding:24px">
              <h2 style="color:#008181">New Lead from ${source}</h2>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Phone:</strong> ${phone}</p>
              <p style="color:#4a5568;font-size:13px;margin-top:20px">Please follow up to connect them with a doctor.</p>
            </div>`,
          }),
        });
      } catch (e) { console.log('Could not send team notification email:', e.message); }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (e) {
    console.log('submit-lead error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not submit right now. Please try again.' }) };
  }
};
