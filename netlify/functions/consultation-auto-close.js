// netlify/functions/consultation-auto-close.js
//
// Runs every 6 hours (see netlify.toml) and asks the database to close any
// consultation that's had no message activity in the last 48 hours. The
// actual logic lives in a Postgres function (close_stale_consultations, see
// consultation_flow_migration.sql) since it needs a per-consultation "last
// message time" lookup that's much cheaper to do as one SQL query than by
// fetching everything into this function and looping over it.
//
// Required Netlify environment variables (same ones your other scheduled
// functions already use):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

exports.handler = async function () {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('Missing required env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/close_stale_consultations`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log('close_stale_consultations failed:', errText);
      return { statusCode: 500, body: 'RPC call failed: ' + errText };
    }

    const closedCount = await res.json();
    const summary = `Auto-closed ${closedCount} consultation(s) inactive for 48+ hours`;
    console.log(summary);
    return { statusCode: 200, body: summary };
  } catch (e) {
    console.log('consultation-auto-close error:', e.message);
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
