# Plan: marks, pins, and threads

These decisions are confirmed and implemented. Each person has one mark at a time. The question mark only asks for more. Both names show. Either person can pin. Unpin deletes a note only after the 7-day window, and Delete still works on a pin. Pinned notes stay on their calendar day. Replies are short text up to 400 characters, one level deep, and they live only with the parent. The thread expands on the card. Marks work on replies. Only the original note can be pinned. The author can keep editing a pinned note after day 7, with its original date.

## What the app does today

Passdown is a two-person log. Each note is encrypted in the browser (`encryptJson` in `public/js/crypto.js`) and stored as ciphertext. The server (`functions/lib/api.js`) only keeps `id`, `owner_sub`, `ciphertext`, `created_at`, and `updated_at` on `notes`. Date, text, tag, IMPORTANT, and author name are inside the ciphertext.

The rolling 7-day window is Pacific Time and uses the note's calendar `date`, not `created_at`. `refreshNotes` in `public/js/app.js` decrypts every row, and any note with `isWithinRetention(note.date, today) === false` is deleted with `DELETE /api/notes/:id`. That sweep runs when the log is opened and when the phone becomes visible again. There is no server cron.

Only the author can `PATCH` a note. Either person can `DELETE` one. The confirm dialog already exists (`askConfirm` / `#confirm`).

That permission split is why these three features cannot be fields on the note payload alone. The other person must be able to mark and pin a note they did not write, and a reply must not require rewriting the parent.

## Defaults this plan will follow

1. Check and question are one choice per person per note. Tapping the active one clears it. Tapping the other switches to it. Both people can mark, including the author. The card shows both names.
2. The question mark is a signal ("please say more"). It does not open the thread. Reply is a separate button.
3. Either person can pin or unpin. Pin only stops the 7-day sweep. The existing Delete button still removes a pinned note after the current confirm.
4. Unpin inside the 7-day window only clears the pin and leaves the note. Unpin after the window shows a confirm dialog, and confirming deletes the note for both people.
5. Pinned notes stay in date order. An older pinned note sits on its own day, below newer days. It does not jump to the top.
6. A thread is one level deep, like Slack. Replies are short text only: no date, tag, or IMPORTANT of their own. They are shown under the parent and are not separate rows in the main list.
7. Replies live and die with the parent. A pinned parent keeps its replies. Deleting the parent deletes the replies. A reply has no pin of its own.
8. Collapsed card shows the parent and the newest reply. Earlier replies are behind an expand control on the same card. Reply writing uses a small sheet.
9. Marks work on the parent and on each reply. Pin is only on the parent.
10. The author can still edit a pinned note after day 7. The original date stays. The date field cannot be moved outside the window to dodge retention.
11. Mark kind, pin state, and parent id stay inside ciphertext. Cloudflare does not learn them.

## Decisions

Confirmed before implementation:

1. Can one person put both a check and a question on the same note, or only one?
2. Is the question mark only a request for the other person to say more, or should it also open the thread?
3. Should the card show who marked it, or only your own buttons?
4. Can either person pin, or only the author?
5. Inside the 7-day window, should unpin leave the note in place? The warning-and-delete path would then run only once the note is already past day 7.
6. Should Delete still work on a pinned note, or should pin block manual delete too?
7. Should older pinned notes stay on their calendar day, or float to the top of the log?
8. Are replies short messages, or full notes with their own date, tag, and IMPORTANT marker?
9. Do replies expire on their own 7-day clock, or only when the parent expires or is deleted?
10. Is a thread one level deep, or can a reply have its own replies?
11. Should the full thread expand on the card, or open its own screen?
12. Do replies get the check and question buttons? Can a reply be pinned on its own?
13. After day 7, can the author still edit the text of a pinned note?

## Storage

Add `migrations/0002_marks_and_flags.sql`. Do not rely on foreign-key cascade. D1 does not promise that, and `test/d1.js` would have to enable it. The note `DELETE` handler removes child rows itself.

```sql
CREATE TABLE IF NOT EXISTS note_marks (
  note_id TEXT NOT NULL,
  owner_sub TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (note_id, owner_sub)
);

CREATE TABLE IF NOT EXISTS note_flags (
  note_id TEXT NOT NULL PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`note_marks` is one row per person per note. Ciphertext is `{ kind: "ack" | "question" }`, encrypted with AAD `${noteId}\n${ownerSub}`. Clearing a mark deletes that row. The partner's row is never written by the other account.

`note_flags` is one row per note. Ciphertext is `{ pinned: true }`, AAD `flags:${noteId}`. Missing row means unpinned. Either signed-in user may write it. Save with `baseUpdatedAt`, same conflict rule as the tag catalog: a stale write gets 409 and the client retries against the current ciphertext. Two people is a small race; last successful write wins.

Replies stay in `notes`. The parent id is a field inside the reply ciphertext, not a server column, so the host does not learn which rows form a thread. A reply payload:

```json
{
  "date": "2026-09-21",
  "text": "Done, pickup is at 3.",
  "tag": "F",
  "important": false,
  "authorName": "Irina",
  "authorEmail": "irina.b.pdx@gmail.com",
  "createdAt": "2026-09-28T18:04:00.000Z",
  "parentId": "6f1c...."
}
```

`date` and `tag` copy the parent so old helpers keep working. The reply's clock on screen is `createdAt`. `parentId` is optional on `isNotePayload`. Notes already saved, which have no `parentId`, stay valid.

`GET /api/notes` grows two arrays so the client decides retention from one snapshot:

```json
{
  "notes": [],
  "marks": [{ "noteId": "", "ownerSub": "", "ciphertext": "", "updatedAt": "" }],
  "flags": [{ "noteId": "", "ciphertext": "", "updatedAt": "" }]
}
```

New routes, all same-origin and signed-in, matching the style of `handleNote`:

- `PUT /api/notes/:id/mark` with `{ ciphertext }`. Upsert only `owner_sub = current user`. 404 if the note does not exist.
- `DELETE /api/notes/:id/mark`. Deletes only the caller's row.
- `PUT /api/notes/:id/flags` with `{ ciphertext, baseUpdatedAt }`. `baseUpdatedAt: null` inserts. A mismatch returns 409 and the current row, like the catalog.
- `DELETE /api/notes/:id` also deletes that note's marks and flags. It does not know reply ids. The client deletes replies, then the parent.

Ciphertext limits: marks at 2,000 characters, flags at 2,000, notes stay at 20,000. Same alphabet check as `requireCiphertext`.

Update `test/d1.js` so `createTestDb` runs every file in `migrations/` in order. Today it reads only `0001_init.sql`.

## Domain rules

Add these to `public/js/domain.js` and cover them in `test/domain.test.js` before any UI work.

- `MARK_KINDS = ["ack", "question"]`.
- `normalizeMark(kind)` returns the kind or `""`.
- `toggleMark(current, next)` returns `""` when `next` is already current, otherwise `next`. One live kind per person.
- `marksByNote(marks)` groups decrypted marks by note id.
- `isPinned(flags, noteId)`.
- `shouldKeepNote(note, today, pinned)` is true when `pinned` or `isWithinRetention(note.date, today)`.
- `partitionThreads(notes)` splits root notes from replies. A reply whose `parentId` is not in the loaded set is an orphan, not a root.
- `threadView(parent, replies)` sorts replies by `createdAt` ascending, then id. Collapsed preview is the parent plus the last reply. `earlierCount` is `max(0, replies.length - 1)`.
- `validateReplyInput({ text, parent })` trims text, requires 1 to 400 characters, and requires a parent id. It does not apply the 7-day date rule, so a reply can be added to a pinned note from last month.
- `validateNoteInput` grows an option `allowExistingDate`. The composer passes the note's current date when that date is already outside the window and the note is pinned. Any other date still has to fall inside the window.
- `notesToCsv` adds columns `parent`, `pinned`, `ack`, and `question`. `ack` and `question` are the display names of the people who set that mark, joined with `; `. Roots and replies are both exported. Reply rows use the parent id in `parent`.

`sortNotes`, tag filters, and IMPORTANT filters stay on root notes only. A thread is visible when its parent matches the filter. Reply text is not a separate filter hit.

## Retention and unpin

Change the sweep in `refreshNotes`:

1. Load notes, marks, and flags from the one `GET`.
2. If that request fails, leave the previous list alone.
3. Decrypt. If flag decryption fails for a note, treat that note as pinned for this visit and do not delete it. A bad key on the flag must not wipe the note. Show the existing locked-note banner only for note ciphertext that will not open.
4. Delete an orphan reply (parent id set, parent not in the decrypted set).
5. Delete a root when `shouldKeepNote` is false. Delete its replies first, then the root, so a failed root delete does not hide replies that still have a parent.
6. Skip the sweep entirely if `flags` is missing from the response. An old server, or a partial bug, must not look like "nothing is pinned".

Unpin:

- Note still inside the window: `PUT` flags to remove the row (or write a delete). No dialog. The note stays.
- Note outside the window: `askConfirm` with text like "Unpin this note? It is older than 7 days, so unpinning deletes it for both of you." Confirm label `Unpin and delete`. On yes, delete replies, then the note. On cancel, the pin stays.
- Depends on question 5. If unpin should always delete, the in-window branch goes away and every unpin uses this dialog.

The header line stays `Kept for 7 days`. A pinned card shows a `Pinned` label so an old note does not look like a retention bug.

Manual Delete copy, when the note has replies: "Delete this note and its replies? This removes them for both of you."

## Client flow

`state` gains `marks`, `flags`, and `openThreads` (a `Set` of parent ids expanded on this phone). Expansion is local UI state. It is not encrypted and not shared. Depends on question 11 if the thread should be a separate screen instead of `openThreads`.

Saving a mark or a pin does not rewrite the note and does not change `updated_at` on the note, so the byline does not gain "edited".

`noteCard` actions become two rows:

- Mark row: `✓ Acknowledged` and `? More`, each `aria-pressed` for the signed-in user. A second line lists the other person's mark, for example "Irina asked for more". Your own pressed button is the indication for your mark.
- Action row: `Reply`, `Pin` or `Unpin`, `Edit` (author only), `Delete`.

Pressed marks use a small filled style in `public/css/app.css`, not the full-width black chip. Targets stay at least 44px. The log is a phone column (`max-width: 32rem`); the new row has to wrap without covering the fixed Add note button.

Thread chrome on a root card:

- No replies: no stack. `Reply` is still there.
- Collapsed, with replies: the newest reply in a nested block (text, author, time), then a button `N earlier replies` when `earlierCount > 0`.
- Expanded: every reply oldest-first, then `Hide replies`. Each reply has its own mark buttons, Edit for its author, and Delete. No pin on a reply.
- `Reply` opens `#reply-composer`, a dialog sheet with a textarea, the 400-character counter, Cancel, and Save. It reuses `h()` and the sheet styles. It does not reuse the date and tag composer.

After every successful mark, pin, reply, or delete, call the existing refresh path (`refreshNotes` plus `paintList`) so the other phone's latest copy wins on the next open. `visibilitychange` already refreshes.

## Step by step

Work in this order so each step has tests before the screen depends on it.

1. **Migration and test database.** Add `0002_marks_and_flags.sql`. Teach `createTestDb` to apply every migration file. Run `npm test` and confirm the current API tests still pass.
2. **API for marks and flags.** Extend `GET /api/notes`. Add the mark and flag routes. Make note `DELETE` remove marks and flags for that id. Reject a mark or flag write when the note id is missing or not a UUID. Reject a mark write for a note that does not exist. A user cannot replace the other user's mark row. Cover this in `test/api.test.js` beside the existing author-edit test: second person adds an ack, author adds a question, second person cannot overwrite the author's mark, delete note removes the marks, flag insert then stale `baseUpdatedAt` returns 409.
3. **Domain helpers.** Add the functions listed above and the tests: toggle clears and switches, pinned note is kept on day 8, unpinned note is not, orphan reply is not a root, collapsed view is parent plus latest reply, reply text over 400 fails, CSV has the new columns and still prefixes formula text.
4. **Load path.** `refreshNotes` reads marks and flags, decrypts them, and applies the new sweep. Unit-level behavior stays in domain tests. The sweep's "do not delete when flags are absent" is a branch in `app.js`; keep it small and obvious.
5. **Mark buttons.** Wire the two buttons and the partner line. Optimistic paint is unnecessary; wait for the `PUT` or `DELETE`, then refresh. On failure, set `state.banner` the same way delete already does.
6. **Pin button.** Wire pin, the in-window unpin, and the past-window confirm that deletes. Confirm the sweep leaves a decrypted pinned note whose date is `retentionStart(today)` minus one day, and still deletes an unpinned note with that date.
7. **Threads.** Save a reply through `POST /api/notes` with the reply payload. Render collapsed and expanded states. Delete a reply alone. Delete a parent and its replies. Filter chips must not list replies as their own cards.
8. **Edit after day 7.** Composer allows the original date only for a pinned note already outside the window. Saving still goes through the author-only `PATCH`.
9. **Export.** CSV includes parent, pinned, and the two mark columns for the notes currently loaded, including replies.
10. **Copy.** README "What the host can see" stays accurate: still no date, text, tag, author, mark, pin, or thread link in plaintext. Mention marks, pin, and replies in the opening description, and say that unpinning a note older than 7 days deletes it.

## What this will not do

- No third mark, no emoji picker, and no count of strangers. There are two accounts.
- No nested threads, no "also send to the log" toggle, and no reply notifications. The next open, or returning to the phone, loads the new reply the same way a new note appears today.
- No server job that deletes old notes while both phones are closed. The sweep remains on open. A pinned note is simply skipped by that sweep.
- No plaintext `pinned` or `parent_id` column. The server cannot refuse a delete of a pinned note, because it cannot see the pin. Both clients are the two allowlisted people. The guard is the client sweep plus the confirm dialog.
