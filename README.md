# list.secretprogress.com

A to-do list and time log for one person, as a static web app: plain HTML, CSS and JavaScript, no build
step. List view, board view (To do, In progress, Done) and a time log. Installable on a Mac Dock and an iPad
home screen.

## How it is private

The page holds only the Supabase project address and its publishable key, both public by design. Everything
else is decided in the database:

- Sign-in is Supabase Auth by emailed link or code. No passwords.
- The page calls only the functions in schema `todo_api` (migration
  `_systemdesign/supabase/migrations/20261019_018_todo_api.sql` in the life repository). Each one checks the
  signed-in token before doing anything: one allowed address (kept in one database row), a session opened by
  an emailed link or code, and a confirmed user that still exists. Anyone else gets "not allowed".
- No table is reachable from the web, and no other function. The schema that holds the data grants nothing
  to the web roles.
- Live updates come as a data-free "changed" signal on a private Realtime topic that only the allowed person
  may receive; the page then re-reads through the same checked functions.
- Proof: `_systemdesign/supabase/test/todo_api_security_test.sql`, run through the Supabase connector.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.css`, `app.js` | The page |
| `config.js` | Supabase project address and publishable key |
| `vendor/supabase-js-2.49.4.js` | Supabase client library, pinned; taken from the npm registry tarball and checked against its published sha512 |
| `manifest.webmanifest`, `icons/`, `sw.js` | Install on Dock and home screen; the service worker keeps only the page's own files and never touches Supabase requests |
| `CNAME`, `.nojekyll` | GitHub Pages custom domain |

## Run it locally

    python3 -m http.server 8771 --bind 127.0.0.1 --directory list-app

then open http://localhost:8771. Signing in locally needs `http://localhost:8771/**` in the Supabase redirect
URLs (step 2 below).

## Going live, in order

1. **Supabase, Data API.** Dashboard, Project Settings, Data API (also under Integrations, Data API):
   add `todo_api` to Exposed schemas and save. Add nothing else; never `life`.
2. **Supabase, redirect URLs.** Authentication, URL Configuration, Redirect URLs: add
   `https://list.secretprogress.com/**` (and `http://localhost:8771/**` for local testing). Leave Site URL as
   it is; another app on this project uses it.
3. **Supabase, sign-in email.** Authentication, Emails, Templates, "Magic Link": keep the existing link and
   add a line with the code, for example `<p>Or type this code: {{ .Token }}</p>`. An app on the Dock or home
   screen keeps its own storage, so a link opened in Mail lands in the browser, not the app; the code is how
   the installed app signs in. The extra line does no harm to other apps on the project.
4. **First sign-in.** Open the page, type the allowed address, press "Send me a link". This creates the user.
   If no email arrives within a few minutes, the project is on Supabase's built-in mail sender, which only
   delivers to members of the project's team; set up your own sender under Authentication, Emails, SMTP
   Settings, then try again.
5. **GitHub repository and Pages.** Public repository (GitHub Pages on a free account needs one; nothing in
   it is secret):

        gh repo create mtumi/list --public --description "list.secretprogress.com"
        tmp=$(mktemp -d) && cp -R /Users/mt/Projects/AI/list-app/. "$tmp"/ && cd "$tmp"
        git init -b main && git add . && git commit -m "list.secretprogress.com"
        git remote add origin https://github.com/mtumi/list.git && git push -u origin main
        gh api -X POST repos/mtumi/list/pages -f 'source[branch]=main' -f 'source[path]=/'
        gh api -X PUT repos/mtumi/list/pages -f cname=list.secretprogress.com

   Later updates: copy `list-app` over the clone again, commit and push.
6. **Verify the domain with GitHub** (stops anyone else's Pages site claiming it): github.com, Settings,
   Pages, "Add a domain", `secretprogress.com`. GitHub shows a TXT record to add at Hostinger.
7. **DNS at Hostinger.** hPanel, Domains, secretprogress.com, DNS / Nameservers, add:

   | Type | Name | Points to | TTL |
   |---|---|---|---|
   | CNAME | `list` | `mtumi.github.io` | 3600 |
   | TXT | as GitHub shows in step 6 | as GitHub shows | 3600 |

8. **HTTPS.** Repository Settings, Pages: once the certificate is issued (minutes to an hour after DNS),
   tick "Enforce HTTPS".
9. **Install.** Mac: open the page in Safari, File, Add to Dock. iPad: Safari, Share, Add to Home Screen.
   Sign in inside the installed app with the code from the email.
