// Your Supabase project, filled in during setup (see the README). Public by design: the key alone
// reads nothing. Row level security in scripts/schema.sql lets only the notes account in, and
// each device signs in to it once with the password.
window.NOTES_CONFIG = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  key: 'sb_publishable_YOUR_PUBLISHABLE_KEY',
  email: 'notes@example.invalid',
};
