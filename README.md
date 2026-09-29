# Passdown

A private log for two people. Each note has a date, a short text, one tag, and an optional IMPORTANT marker. Either person can acknowledge a note or ask for more, pin it so it stays past the 7-day window, or add a short reply. Notes are encrypted in the browser before they are saved, so the host stores only ciphertext. The log keeps the last 7 days in Pacific Time. Older notes are deleted when the log is opened, unless they are pinned. Unpinning a note that is already older than 7 days deletes it.

Sign-in is Google, limited to the addresses in `ALLOWED_EMAILS`. The second address can be added when you have it. Dates use Pacific Time.

## Tags

F, House, Ops, Errands, and Reminders are built in. Notes saved under Kids show as F, and the author’s next visit stores that name. Either person can add a short ad hoc tag. IMPORTANT is a marker on a note, not a tag, and the filter can combine it with a tag.

Only the author can edit a note. Either person can delete any note, including a pinned one. A reply is a short text under that note, up to 400 characters, and it stays only as long as the note does. The list shows the note and the newest reply until the thread is expanded. Export CSV from the menu builds the file on the phone.

## Recovery key

The first person creates the log and saves the recovery key in a password manager. Share that key in person or on Signal, not by email. The other person pastes it, or scans the QR code. If both copies are lost, the notes cannot be read.

On an iPhone, use Add to Home Screen. The key stays in this site's local storage; clearing site data asks for the recovery key again.

## Local preview

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply logbook --local
npm run dev
```

Open http://localhost:8788. Local sign-in is available only on localhost, and only when `ALLOW_DEV_LOGIN=true`. It is rejected on a `pages.dev` host even if that variable is set.

## Deploy on Cloudflare Pages

1. Create a free Cloudflare account and run `npx wrangler login`.
2. Create the database: `npx wrangler d1 create logbook`.
3. Put the printed database id in `wrangler.toml` in place of the placeholder.
4. Apply the migration: `npx wrangler d1 migrations apply logbook --remote`.
5. Generate a long random `SESSION_SECRET` and set it with `npx wrangler pages secret put SESSION_SECRET --project-name logbook`.
6. In Google Cloud, create an OAuth client of type Web application. Add the Pages URL and `http://localhost:8788` as authorized JavaScript origins. The app can stay in testing, with both Gmail addresses listed as test users.
7. Set the client id: `npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name logbook`.
8. Deploy: `npm run deploy`.

The site will be at `https://logbook.pages.dev` (or the project name Pages assigns). Add the second Gmail address to `ALLOWED_EMAILS` in `wrangler.toml` and deploy again when you have it.

Do not set `ALLOW_DEV_LOGIN` on the deployed project.

## What the host can see

Cloudflare can see that a row exists, about how large it is, when it changed, and which Google account owns it. The account id is stored so only the author can edit. Either person can delete a note. The date, text, tag, IMPORTANT marker, author name, marks, pin, and which note a reply belongs to are inside the ciphertext. Deleted rows can be restored from Cloudflare's free point-in-time recovery for 7 days, still encrypted.
