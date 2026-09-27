import assert from "node:assert/strict";
import test from "node:test";
import {
  SEED_TAGS,
  addCalendarDays,
  calendarDay,
  canonicalTag,
  filterNotes,
  formatDayLabel,
  isRealDate,
  isWithinRetention,
  mergeExtraTags,
  notesToCsv,
  retentionStart,
  sortNotes,
  tagsInOrder,
  validateExtraTag,
  validateNoteInput,
} from "../public/js/domain.js";

test("seed tags are the family list without Money", () => {
  assert.deepEqual(SEED_TAGS, ["F", "House", "Ops", "Errands", "Reminders"]);
  assert.equal(SEED_TAGS.some((tag) => tag.toLowerCase() === "money"), false);
  assert.equal(canonicalTag("Kids"), "F");
  assert.equal(canonicalTag("kids"), "F");
});

test("calendar day follows Pacific Time across daylight saving", () => {
  assert.equal(calendarDay(new Date("2026-09-26T06:59:00Z")), "2026-09-25");
  assert.equal(calendarDay(new Date("2026-09-26T07:00:00Z")), "2026-09-26");
  assert.equal(calendarDay(new Date("2026-01-15T07:59:00Z")), "2026-01-14");
  assert.equal(calendarDay(new Date("2026-01-15T08:00:00Z")), "2026-01-15");
  assert.equal(addCalendarDays("2026-03-08", -1), "2026-03-07");
  assert.equal(addCalendarDays("2026-03-08", 1), "2026-03-09");
});

test("day labels use the calendar date", () => {
  assert.equal(formatDayLabel("2026-09-26", "2026-09-26"), "Today");
  assert.equal(formatDayLabel("2026-09-25", "2026-09-26"), "Yesterday");
  assert.match(formatDayLabel("2026-09-24", "2026-09-26"), /Sep 24/);
  assert.equal(isRealDate("2026-02-29"), false);
  assert.equal(isRealDate("2024-02-29"), true);
});

test("notes sort by date, then tag order, then newest first", () => {
  const sorted = sortNotes([
    { id: "ops", date: "2026-09-26", tag: "Ops", createdAt: "2026-09-26T01:00:00.000Z" },
    { id: "kids-old", date: "2026-09-26", tag: "Kids", createdAt: "2026-09-26T02:00:00.000Z" },
    { id: "older-day", date: "2026-09-25", tag: "Reminders", createdAt: "2026-09-25T01:00:00.000Z" },
    { id: "kids-new", date: "2026-09-26", tag: "Kids", createdAt: "2026-09-26T03:00:00.000Z" },
  ], ["Pets"]);
  assert.deepEqual(sorted.map((note) => note.id), ["kids-new", "kids-old", "ops", "older-day"]);
});

test("the log keeps a rolling 7 day window", () => {
  assert.equal(retentionStart("2026-09-27"), "2026-09-21");
  assert.equal(isWithinRetention("2026-09-21", "2026-09-27"), true);
  assert.equal(isWithinRetention("2026-09-20", "2026-09-27"), false);
  assert.equal(isWithinRetention("2026-10-01", "2026-09-27"), true);
  const old = validateNoteInput({
    date: "2026-09-20",
    text: "Old",
    tag: "F",
    allowedTags: SEED_TAGS,
    today: "2026-09-27",
  });
  assert.equal(old.ok, false);
  const kept = validateNoteInput({
    date: "2026-09-21",
    text: "Keep",
    tag: "Kids",
    allowedTags: SEED_TAGS,
    today: "2026-09-27",
  });
  assert.equal(kept.tag, "F");
});

test("filters combine a tag and IMPORTANT", () => {
  const notes = [
    { tag: "Kids", important: true },
    { tag: "F", important: false },
    { tag: "Ops", important: true },
  ];
  assert.equal(filterNotes(notes, { tag: "F", importantOnly: true }).length, 1);
  assert.equal(filterNotes(notes, { tag: "Kids", importantOnly: true }).length, 1);
  assert.equal(filterNotes(notes, { tag: "All", importantOnly: true }).length, 2);
  assert.equal(filterNotes(notes, { tag: "Ops" }).length, 1);
});

test("tag order keeps the fixed list ahead of ad hoc tags", () => {
  assert.deepEqual(tagsInOrder(["Pets", "Kids", "Guests"], [{ tag: "School" }, { tag: "Kids" }]), [
    "F", "House", "Ops", "Errands", "Reminders", "Guests", "Pets", "School",
  ]);
});

test("ad hoc tags reject reserved names and Money is not special-cased as allowed", () => {
  assert.equal(validateExtraTag("IMPT", []).ok, false);
  assert.equal(validateExtraTag("IMPORTANT", []).ok, false);
  assert.equal(validateExtraTag("kids", []).ok, false);
  assert.equal(validateExtraTag("F", []).ok, false);
  assert.equal(validateExtraTag("School run", []).tag, "School run");
  assert.equal(validateExtraTag("Money", []).tag, "Money");
  assert.deepEqual(mergeExtraTags(["Pets", "Kids"], ["pets", "Travel"]), ["Pets", "Travel"]);
});

test("note text is required and csv escapes formulas", () => {
  assert.equal(validateNoteInput({ date: "2026-09-26", text: "  ", tag: "F", allowedTags: SEED_TAGS }).ok, false);
  const csv = notesToCsv([{
    date: "2026-09-26",
    tag: "Kids",
    important: true,
    authorName: "Alex",
    text: '=HYPERLINK("http://example")',
    createdAt: "2026-09-26T15:00:00.000Z",
  }]);
  assert.match(csv, /date,tag,important,author,text,created/);
  assert.match(csv, /"'=HYPERLINK/);
});
