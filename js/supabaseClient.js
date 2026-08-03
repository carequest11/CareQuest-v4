// Shared Supabase client for every CareQuest page.
// Loaded after the Supabase JS CDN script:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@^2.49.4/dist/umd/supabase.js"></script>
//   <script src="js/supabaseClient.js"></script>
//
// SUPABASE_URL and the publishable key are meant to be public — they are
// only ever paired with Row-Level Security, never with elevated access.
//
// This project uses Supabase's newer "publishable" key format
// (sb_publishable_...) rather than the legacy anon JWT key. supabase-js
// only added support for that format in v2.49.4+, which is why the CDN
// script tag above is pinned to "@^2.49.4" instead of a bare "@2" — an
// older cached 2.x build would silently send this key in a way the
// Supabase API doesn't recognize.
const SUPABASE_URL = "https://flvwmvnfdwndettogakv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_jXv2tmgIkk5T5_xxTKYwxg_lWWEgmvP";

const cq = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
