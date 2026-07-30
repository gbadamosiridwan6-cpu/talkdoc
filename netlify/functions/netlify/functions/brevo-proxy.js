// netlify/functions/brevo-proxy.js
//
// This runs on Netlify's servers, NOT in the browser. It forwards email
// requests to Brevo using a secret API key stored as an environment
// variable, so the key is never exposed in your site's front-end code
// and the request is server-to-server (no browser CORS issues).
//
// SETUP REQUIRED (one-time):
// 1. In your Netlify site dashboard: Site configuration -> Environment
//    variables -> add a variable named BREVO_API_KEY with your Brevo
//    API key as the value.
// 2. Redeploy the site so the function picks up the new environment
//    variable.
//
// The front-end calls this function at: /.netlify/functions/brevo-proxy
// with a JSON body like: { "endpoint": "smtp/email", "payload": {...} }
// "endpoint" is the Brevo API path after https://api.brevo.com/v3/

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'BREVO_API_KEY environment variable is not set on the server. Add it in Site configuration -> Environment variables, then redeploy.' })
      };
    }

    let endpoint, payload;
    try {
      const body = JSON.parse(event.body || '{}');
      endpoint = body.endpoint;
      payload = body.payload;
      if (!endpoint || !payload) throw new Error('Missing endpoint or payload');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body: ' + e.message }) };
    }

    // Exact matches for simple endpoints, PLUS anything starting with
    // "emailCampaigns/" — that covers sub-actions like
    // "emailCampaigns/{id}/sendNow" used when actually sending a created
    // campaign. Without this, campaigns could be created as drafts but the
    // "send it now" call would get silently rejected here.
    const allowedEndpoints = ['smtp/email', 'contacts', 'emailCampaigns'];
    const isAllowed = allowedEndpoints.includes(endpoint) || endpoint.startsWith('emailCampaigns/');
    if (!isAllowed) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Endpoint not allowed: ' + endpoint }) };
    }

    // Some older Netlify Functions runtimes don't have global fetch — fall
    // back to node-fetch if that's the case, instead of crashing with a
    // generic 500.
    const fetchFn = (typeof fetch !== 'undefined') ? fetch : (await import('node-fetch')).default;

    const res = await fetchFn('https://api.brevo.com/v3/' + endpoint, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { 'content-type': 'application/json' },
      body: text || '{}'
    };
  } catch (e) {
    // Catch-all so you always get a readable message instead of a bare 500
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Function crashed: ' + (e && e.message ? e.message : String(e)) })
    };
  }
};
