export const TIME_ZONE = "America/Los_Angeles";
export const SEED_TAGS = ["F", "House", "Ops", "Errands", "Reminders"];
export const MAX_TEXT = 400;
export const MAX_EXTRA_TAGS = 24;
export const RETENTION_DAYS = 7;
export const IMPORTANT_LABEL = "IMPORTANT";

const RESERVED = new Set(["all", "impt", "important", "new", "new tag"]);
const LEGACY_TAGS = new Map([["kids", "F"]]);

export function calendarDay(date, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addCalendarDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function isRealDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function formatDayLabel(isoDate, today) {
  if (isoDate === today) return "Today";
  if (isoDate === addCalendarDays(today, -1)) return "Yesterday";
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatTime(isoTimestamp, timeZone = TIME_ZONE) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

export function normalizeTag(input) {
  return String(input || "").trim().replace(/\s+/g, " ");
}

export function canonicalTag(input) {
  const tag = normalizeTag(input);
  return LEGACY_TAGS.get(tag.toLowerCase()) || tag;
}

export function retentionStart(today) {
  return addCalendarDays(today, 1 - RETENTION_DAYS);
}

export function isWithinRetention(isoDate, today) {
  return isRealDate(isoDate) && isRealDate(today) && isoDate >= retentionStart(today);
}

export function isValidTagShape(tag) {
  return tag.length > 0 && tag.length <= 20 && /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u.test(tag);
}

export function validateExtraTag(input, existingTags) {
  const tag = canonicalTag(input);
  if (!tag) return { ok: false, error: "Enter a tag name." };
  if (tag.length > 20) return { ok: false, error: "Keep the tag under 20 characters." };
  if (!isValidTagShape(tag)) return { ok: false, error: "Use letters, numbers, and spaces." };
  if (RESERVED.has(tag.toLowerCase())) return { ok: false, error: "That name is reserved." };
  const taken = [...SEED_TAGS, ...existingTags].some((item) => item.toLowerCase() === tag.toLowerCase());
  if (taken) return { ok: false, error: "That tag already exists." };
  if (existingTags.length >= MAX_EXTRA_TAGS) return { ok: false, error: "The tag list is full." };
  return { ok: true, tag };
}

export function mergeExtraTags(current, incoming) {
  const result = [];
  const seen = new Set(SEED_TAGS.map((tag) => tag.toLowerCase()));
  for (const raw of [...current, ...incoming]) {
    if (typeof raw !== "string") continue;
    const tag = canonicalTag(raw);
    const key = tag.toLowerCase();
    if (!isValidTagShape(tag) || RESERVED.has(key) || seen.has(key)) continue;
    if (result.length >= MAX_EXTRA_TAGS) break;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

export function tagsInOrder(extraTags, notes = []) {
  const seen = new Set(SEED_TAGS.map((tag) => tag.toLowerCase()));
  const extras = [];
  const found = [];
  for (const raw of extraTags || []) {
    if (typeof raw !== "string") continue;
    const tag = canonicalTag(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    extras.push(tag);
  }
  extras.sort((a, b) => a.localeCompare(b));
  for (const note of notes) {
    if (typeof note?.tag !== "string") continue;
    const tag = canonicalTag(note.tag);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    found.push(tag);
  }
  found.sort((a, b) => a.localeCompare(b));
  return [...SEED_TAGS, ...extras, ...found];
}

function tagRank(tag, order) {
  const index = order.findIndex((item) => item.toLowerCase() === String(tag).toLowerCase());
  return index === -1 ? order.length : index;
}

export function sortNotes(notes, extraTags = []) {
  const order = tagsInOrder(extraTags, notes);
  return [...notes].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const byTag = tagRank(canonicalTag(a.tag), order) - tagRank(canonicalTag(b.tag), order);
    if (byTag !== 0) return byTag;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function filterNotes(notes, { tag = "All", importantOnly = false } = {}) {
  return notes.filter((note) => {
    if (tag !== "All" && canonicalTag(note.tag) !== canonicalTag(tag)) return false;
    if (importantOnly && !note.important) return false;
    return true;
  });
}

export function groupByDate(sortedNotes) {
  const groups = [];
  for (const note of sortedNotes) {
    const last = groups.at(-1);
    if (!last || last.date !== note.date) groups.push({ date: note.date, notes: [note] });
    else last.notes.push(note);
  }
  return groups;
}

export function validateNoteInput({ date, text, tag, allowedTags, today }) {
  if (!isRealDate(date)) return { ok: false, error: "Choose a date." };
  if (today && !isWithinRetention(date, today)) return { ok: false, error: "That date is older than 7 days." };
  const body = String(text || "").trim();
  if (!body) return { ok: false, error: "Write a short note." };
  if (body.length > MAX_TEXT) return { ok: false, error: "Keep the note under 400 characters." };
  const canonical = canonicalTag(tag);
  if (!allowedTags.some((item) => canonicalTag(item).toLowerCase() === canonical.toLowerCase())) {
    return { ok: false, error: "Choose a tag." };
  }
  return { ok: true, date, text: body, tag: canonical };
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (safe !== raw || /[",\n\r]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}

export function notesToCsv(notes) {
  const lines = ["date,tag,important,author,text,created"];
  for (const note of notes) {
    lines.push([
      note.date,
      canonicalTag(note.tag),
      note.important ? "yes" : "no",
      note.authorName || "",
      note.text || "",
      note.createdAt || "",
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function isNotePayload(value) {
  return Boolean(value)
    && typeof value === "object"
    && isRealDate(value.date)
    && typeof value.text === "string"
    && typeof value.tag === "string"
    && typeof value.createdAt === "string";
}
