// POST /api/create-profile
// Inserts a youth_profiles or senior_profiles row right after
// supabase.auth.signUp() on the client. Runs with the Supabase
// service-role key so it works even before the user's email is
// confirmed (RLS would otherwise block the insert until then).
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_FIELDS = {
  youth: ['first_name', 'last_name', 'email', 'phone', 'age', 'interests', 'languages'],
  senior: ['full_name', 'email', 'phone', 'past_career', 'interests', 'languages']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { role, userId, profile } = req.body || {};

    if (role !== 'youth' && role !== 'senior') {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    if (!userId || !profile) {
      res.status(400).json({ error: 'Missing userId or profile' });
      return;
    }

    // Confirm this is a real, just-created Supabase Auth user before
    // writing anything — prevents strangers from POSTing arbitrary rows.
    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (userErr || !userData?.user) {
      res.status(401).json({ error: 'Unknown user' });
      return;
    }

    const table = role === 'youth' ? 'youth_profiles' : 'senior_profiles';
    const allowed = ALLOWED_FIELDS[role];
    const row = { id: userId };
    for (const key of allowed) {
      if (profile[key] !== undefined && profile[key] !== '') row[key] = profile[key];
    }

    const { error: insertErr } = await supabaseAdmin.from(table).insert(row);

    if (insertErr) {
      res.status(400).json({ error: insertErr.message });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error' });
  }
};
