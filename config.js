// The only settings the page has. Both values are public by design: the project address and the
// publishable key only let a browser ask Supabase to sign someone in. What a signed-in person may see is
// decided in the database (schema todo_api, migration 20261019_018_todo_api.sql), never here.
//
// The publishable key comes from the Supabase dashboard: Project Settings, API Keys, "Publishable key"
// (starts sb_publishable_), or the legacy "anon public" key. Paste it between the quotes.
window.LIST_CONFIG = {
  supabaseUrl: 'https://joyriilphiydaattjaga.supabase.co',
  publishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpveXJpaWxwaGl5ZGFhdHRqYWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NTYwNTIsImV4cCI6MjA5MTMzMjA1Mn0.ekXeqM7p0Djo79j0nhbqzjDCX6K3MBqMe4M2ops8TQI',
};
