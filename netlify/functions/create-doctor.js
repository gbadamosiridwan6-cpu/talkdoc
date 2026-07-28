// netlify/functions/create-doctor.js
//
// Creates a doctor in BOTH places at once, so nobody ever has to touch
// Supabase's dashboard by hand again:
//   1. A real Supabase Auth user (email confirmed, app_metadata.role = "doctor")
//   2. The matching row in the public "doctors" table (same id as the auth user)
//
// This function uses the SERVICE ROLE key, which must NEVER be exposed to the
// browser. It only ever runs here, server-side, on Netlify.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://kghlrhcpaexfwefaeuzt.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SERVICE_ROLE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing SUPABASE_SERVICE_ROLE_KEY. Set it in Netlify → Site configuration → Environment variables.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { name, email, password, specialty, license } = body;
  if (!name || !email || !password || !specialty) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (password.length < 6) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) };
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    // 1. Create the real Auth user, pre-confirmed, tagged as a doctor
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      app_metadata: { role: 'doctor' }
    });

    if (authError) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not create login: ' + authError.message }) };
    }

    const newUserId = authData.user.id;

    // 2. Insert the matching row in the public doctors table, using the SAME id
    //    as the auth user so the two records are always in sync.
    const { data: doctorRow, error: doctorError } = await supabaseAdmin
      .from('doctors')
      .insert({
        id: newUserId,
        name,
        email: email.toLowerCase().trim(),
        specialty,
        status: 'active',
        license: license || null
      })
      .select()
      .single();

    if (doctorError) {
      // Roll back the auth user so we don't end up with a login that has no profile
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not save doctor profile: ' + doctorError.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ doctor: doctorRow }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected server error: ' + e.message }) };
  }
};
