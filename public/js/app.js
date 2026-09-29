import { renderSVG } from "../vendor/uqr.mjs";
import { decryptJson, encodeRecoveryKey, encryptJson, formatRecoveryKey, generateMasterKey, importMasterKey, parseRecoveryKeyInput } from "./crypto.js";
import {
  SEED_TAGS,
  MAX_TEXT,
  RETENTION_DAYS,
  IMPORTANT_LABEL,
  calendarDay,
  canonicalTag,
  filterNotes,
  formatDayLabel,
  formatTime,
  groupByDate,
  isNotePayload,
  isPinned,
  isWithinRetention,
  mergeExtraTags,
  normalizeMark,
  notesToCsv,
  partitionThreads,
  retentionDeletes,
  retentionStart,
  sortNotes,
  tagsInOrder,
  threadView,
  toggleMark,
  validateExtraTag,
  validateNoteInput,
  validateReplyInput,
} from "./domain.js";

const KEY_STORAGE = "passdown.masterKey.v1";
const PENDING_KEY = "passdown.pendingKey";
const root = document.querySelector("#app");

const state = {
  screen: "loading",
  renderedScreen: "",
  config: null,
  user: null,
  key: null,
  recoveryKey: "",
  extraTags: [],
  catalogUpdatedAt: null,
  notes: [],
  marks: [],
  flags: [],
  openThreads: new Set(),
  locked: 0,
  tag: "All",
  importantOnly: false,
  logExists: false,
  error: "",
  banner: "",
  draft: null,
  replyDraft: null,
};

captureHashKey();
boot();

function captureHashKey() {
  if (!location.hash.includes("k=")) return;
  const key = new URLSearchParams(location.hash.slice(1)).get("k");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (!key) return;
  try {
    parseRecoveryKeyInput(key);
    sessionStorage.setItem(PENDING_KEY, key);
  } catch {
    sessionStorage.removeItem(PENDING_KEY);
  }
}

async function boot() {
  state.screen = "loading";
  state.error = "";
  render({ force: true });
  try {
    const configResponse = await fetch("/api/config");
    if (!configResponse.ok) throw new Error("You need a connection to open the log.");
    state.config = await configResponse.json();
    const me = await fetch("/api/me");
    if (me.ok) {
      state.user = (await me.json()).user;
      await enterAfterAuth();
      return;
    }
    state.screen = "signedOut";
    render({ force: true });
  } catch (error) {
    if (state.screen === "signedOut") return;
    state.screen = "offline";
    state.error = error.message || "You need a connection to open the log.";
    render({ force: true });
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("content-type", "application/json");
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("You need a connection to open the log.");
  }
  if (response.status === 401) {
    state.user = null;
    state.screen = "signedOut";
    state.error = "Sign in required.";
    render({ force: true });
    throw new Error("Sign in required.");
  }
  return response;
}

async function enterAfterAuth() {
  const stored = localStorage.getItem(KEY_STORAGE) || "";
  const pending = sessionStorage.getItem(PENDING_KEY) || "";
  const candidate = stored || pending;
  if (candidate) {
    try {
      const raw = parseRecoveryKeyInput(candidate);
      state.key = await importMasterKey(raw);
      state.recoveryKey = encodeRecoveryKey(raw);
      const opened = await openCatalog();
      if (opened === "ok") {
        localStorage.setItem(KEY_STORAGE, state.recoveryKey);
        sessionStorage.removeItem(PENDING_KEY);
        await refreshNotes();
        state.screen = "app";
        state.error = "";
        render({ force: true });
        return;
      }
      if (opened === "empty" && stored) {
        await saveExtraTags([], null);
        await refreshNotes();
        state.screen = "app";
        render({ force: true });
        return;
      }
      if (opened === "empty") {
        state.error = "The log isn't ready yet. Ask the other person to finish setup, then try again.";
      } else if (opened === "mismatch") {
        state.error = "That key doesn't open this log.";
      } else {
        state.error = "You need a connection to open the log.";
      }
      state.screen = stored ? "join" : "join";
      render({ force: true });
      return;
    } catch (error) {
      state.error = error.message;
    }
  }
  const response = await api("/api/catalog");
  const body = await response.json();
  state.logExists = Boolean(body.ciphertext);
  state.screen = "choose";
  render({ force: true });
}

async function openCatalog() {
  const response = await api("/api/catalog");
  if (!response.ok) return "error";
  const body = await response.json();
  if (!body.ciphertext) return "empty";
  try {
    const data = await decryptJson(state.key, body.ciphertext, "catalog");
    state.extraTags = mergeExtraTags(data.extraTags || [], []);
    state.catalogUpdatedAt = body.updatedAt;
    return "ok";
  } catch {
    return "mismatch";
  }
}

async function saveExtraTags(extraTags, baseUpdatedAt, attempt = 0) {
  const ciphertext = await encryptJson(state.key, { extraTags }, "catalog");
  const response = await api("/api/catalog", {
    method: "PUT",
    body: JSON.stringify({ ciphertext, baseUpdatedAt }),
  });
  if (response.status === 409 && attempt < 3) {
    const current = await response.json();
    const data = await decryptJson(state.key, current.ciphertext, "catalog");
    const serverTags = mergeExtraTags(data.extraTags || [], []);
    const merged = mergeExtraTags(serverTags, extraTags);
    state.extraTags = merged;
    state.catalogUpdatedAt = current.updatedAt;
    const same = merged.length === serverTags.length && merged.every((tag, index) => tag === serverTags[index]);
    if (same) return;
    return saveExtraTags(merged, current.updatedAt, attempt + 1);
  }
  if (!response.ok) throw new Error("Could not save tags.");
  const body = await response.json();
  state.extraTags = extraTags;
  state.catalogUpdatedAt = body.updatedAt;
}

async function refreshNotes() {
  const response = await api("/api/notes");
  if (!response.ok) throw new Error("The log could not be opened.");
  const body = await response.json();
  if (!Array.isArray(body.notes)) throw new Error("The log could not be opened.");
  const decrypted = [];
  const rewrites = [];
  let locked = 0;
  const today = calendarDay(new Date());
  for (const row of body.notes) {
    try {
      const payload = await decryptJson(state.key, row.ciphertext, row.id);
      if (!isNotePayload(payload)) {
        locked += 1;
        continue;
      }
      const tag = canonicalTag(payload.tag);
      const note = {
        ...payload,
        tag,
        important: Boolean(payload.important),
        parentId: typeof payload.parentId === "string" ? payload.parentId : "",
        id: row.id,
        ownerSub: row.ownerSub,
        serverCreatedAt: row.createdAt,
        serverUpdatedAt: row.updatedAt,
      };
      decrypted.push(note);
      if (tag !== payload.tag && note.ownerSub === state.user?.sub) {
        rewrites.push({ id: note.id, payload: { ...payload, tag, important: note.important } });
      }
    } catch {
      locked += 1;
    }
  }
  const marks = [];
  for (const row of Array.isArray(body.marks) ? body.marks : []) {
    try {
      const payload = await decryptJson(state.key, row.ciphertext, `${row.noteId}\n${row.ownerSub}`);
      const kind = normalizeMark(payload?.kind);
      if (!kind) continue;
      marks.push({
        noteId: row.noteId,
        ownerSub: row.ownerSub,
        kind,
        name: typeof payload?.name === "string" ? payload.name.trim() : "",
        updatedAt: row.updatedAt,
      });
    } catch {
      // Leave the row in place. The next open tries again.
    }
  }
  const flags = [];
  const pinnedIds = [];
  // Missing flags would look like nothing is pinned and could delete kept notes.
  const sweep = Array.isArray(body.flags);
  if (sweep) {
    for (const row of body.flags) {
      try {
        const payload = await decryptJson(state.key, row.ciphertext, `flags:${row.noteId}`);
        const pinned = payload?.pinned === true;
        flags.push({ noteId: row.noteId, pinned, updatedAt: row.updatedAt, unreadable: false });
        if (pinned) pinnedIds.push(row.noteId);
      } catch {
        flags.push({ noteId: row.noteId, pinned: true, updatedAt: row.updatedAt, unreadable: true });
        pinnedIds.push(row.noteId);
      }
    }
  }
  const expired = retentionDeletes({
    notes: decrypted,
    serverIds: body.notes.map((row) => row.id),
    pinnedIds,
    today,
    sweep,
  });
  const expiredSet = new Set(expired);
  const notes = decrypted.filter((note) => !expiredSet.has(note.id));
  state.notes = notes;
  state.marks = marks.filter((mark) => notes.some((note) => note.id === mark.noteId));
  state.flags = flags.filter((flag) => notes.some((note) => note.id === flag.noteId));
  state.locked = locked;
  for (const id of expired) {
    try {
      await api(`/api/notes/${id}`, { method: "DELETE" });
    } catch {
      // Hidden for this visit. The next open tries the delete again.
    }
  }
  for (const item of rewrites) {
    if (expiredSet.has(item.id)) continue;
    try {
      const ciphertext = await encryptJson(state.key, item.payload, item.id);
      await api(`/api/notes/${item.id}`, { method: "PATCH", body: JSON.stringify({ ciphertext }) });
    } catch {
      // The renamed tag still shows. The author's next open saves it.
    }
  }
}

function render({ force = false } = {}) {
  if (force || state.renderedScreen !== state.screen) {
    state.renderedScreen = state.screen;
    root.replaceChildren();
    paintScreen();
  } else if (state.screen === "app") {
    paintChips();
    paintList();
  }
}

function paintScreen() {
  if (state.screen === "loading") {
    root.append(h("main", { class: "shell panel" }, [h("h1", {}, ["Passdown"]), h("p", { class: "lede" }, ["Opening the log…"])]));
    return;
  }
  if (state.screen === "offline") {
    root.append(h("main", { class: "shell panel stack" }, [
      h("h1", {}, ["Passdown"]),
      h("p", { class: "lede" }, [state.error || "You need a connection to open the log."]),
      h("button", { class: "button primary wide", type: "button", click: () => boot() }, ["Try again"]),
    ]));
    return;
  }
  if (state.screen === "signedOut") {
    paintSignedOut();
    return;
  }
  if (state.screen === "choose") {
    paintChoose();
    return;
  }
  if (state.screen === "recovery") {
    paintRecovery();
    return;
  }
  if (state.screen === "join") {
    paintJoin();
    return;
  }
  paintApp();
}

function paintSignedOut() {
  const googleHost = h("div", { id: "google-signin" });
  const devForm = h("form", { class: "stack", submit: onDevSubmit }, [
    h("label", { class: "field" }, [
      h("span", {}, ["Email"]),
      h("input", { name: "email", type: "email", autocomplete: "username", required: "true", value: "astrocheet4h@gmail.com" }),
    ]),
    h("label", { class: "field" }, [
      h("span", {}, ["Name"]),
      h("input", { name: "name", type: "text", autocomplete: "name", value: "Alex" }),
    ]),
    h("button", { class: "button wide", type: "submit" }, ["Local sign-in"]),
  ]);
  const children = [
    h("h1", {}, ["Passdown"]),
    h("p", { class: "lede" }, ["A shared family log. Notes are encrypted on this phone before they are saved."]),
  ];
  if (state.config?.googleClientId) children.push(googleHost);
  else children.push(h("p", { class: "quiet" }, ["Google sign-in appears here after it is configured."]));
  if (state.config?.devLogin) {
    children.push(h("p", { class: "quiet" }, ["On this computer"]));
    children.push(devForm);
  }
  if (state.error) children.push(h("p", { class: "form-error" }, [state.error]));
  root.append(h("main", { class: "shell panel" }, children));
  if (state.config?.googleClientId) mountGoogle(googleHost);
}

async function mountGoogle(container) {
  try {
    await loadScript("https://accounts.google.com/gsi/client");
    globalThis.google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      callback: onGoogleCredential,
      auto_select: false,
    });
    globalThis.google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      width: Math.min(320, Math.max(240, container.clientWidth || 280)),
      text: "continue_with",
    });
  } catch (error) {
    container.replaceChildren(h("p", { class: "form-error" }, [error.message]));
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in didn't load."));
    document.head.append(script);
  });
}

async function onGoogleCredential(response) {
  try {
    const res = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ idToken: response.credential }),
    });
    const body = await res.json();
    if (!res.ok) {
      state.error = body.error || "Sign-in failed.";
      render({ force: true });
      return;
    }
    state.user = body.user;
    state.error = "";
    await enterAfterAuth();
  } catch (error) {
    state.error = error.message;
    render({ force: true });
  }
}

async function onDevSubmit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const res = await api("/api/session/dev", {
      method: "POST",
      body: JSON.stringify({ email: data.get("email"), name: data.get("name") }),
    });
    const body = await res.json();
    if (!res.ok) {
      state.error = body.error || "Sign-in failed.";
      render({ force: true });
      return;
    }
    state.user = body.user;
    state.error = "";
    await enterAfterAuth();
  } catch (error) {
    state.error = error.message;
    render({ force: true });
  }
}

function paintChoose() {
  const children = [
    h("h1", {}, ["Set up this phone"]),
    h("p", { class: "lede" }, [state.logExists
      ? "This log is already set up. Enter the recovery key from the other phone."
      : "Create the log if you are first. If you already have a recovery key, use that instead."]),
  ];
  if (!state.logExists) {
    children.push(h("button", { class: "button primary wide", type: "button", click: startCreate }, ["Create the log"]));
  }
  children.push(h("button", { class: state.logExists ? "button primary wide" : "button wide", type: "button", click: () => { state.screen = "join"; state.error = ""; render({ force: true }); } }, ["I have the recovery key"]));
  children.push(h("button", { class: "text-button", type: "button", click: signOut }, ["Sign out"]));
  if (state.error) children.push(h("p", { class: "form-error" }, [state.error]));
  root.append(h("main", { class: "shell panel stack" }, children));
}

async function startCreate() {
  let response;
  try {
    response = await api("/api/catalog");
  } catch (error) {
    state.error = error.message;
    render({ force: true });
    return;
  }
  const existing = await response.json();
  if (existing.ciphertext) {
    state.logExists = true;
    state.error = "This log already exists. Enter the recovery key.";
    state.screen = "choose";
    render({ force: true });
    return;
  }
  const generated = await generateMasterKey();
  state.key = generated.key;
  state.recoveryKey = generated.recoveryKey;
  state.error = "";
  state.screen = "recovery";
  render({ force: true });
}

function paintRecovery() {
  const checkbox = h("input", { type: "checkbox", id: "saved-key" });
  const cont = h("button", { class: "button primary wide", type: "button", disabled: true }, ["Continue"]);
  checkbox.addEventListener("change", () => { cont.disabled = !checkbox.checked; });
  cont.addEventListener("click", acknowledgeKey);
  const keyField = h("textarea", { class: "key-box", readonly: "true", rows: "3" }, [formatRecoveryKey(state.recoveryKey)]);
  const qr = h("div", { class: "qr", role: "img", "aria-label": "QR code for the recovery key" });
  qr.innerHTML = renderSVG(recoveryUrl(), { ecc: "M", border: 2, pixelSize: 8, blackColor: "#221e1a", whiteColor: "#ffffff" });
  root.append(h("main", { class: "shell" }, [
    h("h1", {}, ["Save the recovery key"]),
    h("p", { class: "lede" }, ["This key is the only way to read the log. Save it in a password manager. Share it in person or on Signal, not by email. If both copies are lost, the notes cannot be read."]),
    qr,
    keyField,
    h("button", { class: "button wide", type: "button", click: (event) => copyKey(keyField, event.currentTarget) }, ["Copy key"]),
    h("div", { class: "setup-actions" }, [
      h("label", { class: "check" }, [checkbox, "I saved this key"]),
      cont,
    ]),
    state.error ? h("p", { class: "form-error" }, [state.error]) : null,
  ]));
}

function recoveryUrl() {
  return `${location.origin}${location.pathname}#k=${state.recoveryKey}`;
}

async function copyKey(field, button) {
  try {
    await navigator.clipboard.writeText(state.recoveryKey);
    if (button) {
      const previous = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = previous; }, 1500);
    }
  } catch {
    field.focus();
    field.select();
  }
}

async function acknowledgeKey() {
  localStorage.setItem(KEY_STORAGE, state.recoveryKey);
  try {
    await saveExtraTags([], null);
    await refreshNotes();
    state.screen = "app";
    state.error = "";
    render({ force: true });
  } catch (error) {
    state.error = error.message;
    render({ force: true });
  }
}

function paintJoin() {
  const field = h("textarea", {
    class: "key-box",
    rows: "4",
    placeholder: "Paste the recovery key",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  const form = h("form", { class: "stack", submit: async (event) => {
    event.preventDefault();
    await joinWithKey(field.value);
  } }, [
    field,
    h("button", { class: "button primary wide", type: "submit" }, ["Open the log"]),
  ]);
  root.append(h("main", { class: "shell panel" }, [
    h("h1", {}, ["Enter the recovery key"]),
    h("p", { class: "lede" }, ["Paste the key from the other phone, or open this phone's camera on their QR code."]),
    form,
    state.error ? h("p", { class: "form-error" }, [state.error]) : null,
    h("button", { class: "text-button", type: "button", click: () => { state.error = ""; state.screen = "choose"; render({ force: true }); } }, ["Back"]),
  ]));
}

async function joinWithKey(text) {
  try {
    const raw = parseRecoveryKeyInput(text);
    state.key = await importMasterKey(raw);
    state.recoveryKey = encodeRecoveryKey(raw);
    const opened = await openCatalog();
    if (opened === "empty") {
      state.error = "The log isn't ready yet. Ask the other person to finish setup, then try again.";
      render({ force: true });
      return;
    }
    if (opened !== "ok") {
      state.error = "That key doesn't open this log.";
      render({ force: true });
      return;
    }
    localStorage.setItem(KEY_STORAGE, state.recoveryKey);
    sessionStorage.removeItem(PENDING_KEY);
    await refreshNotes();
    state.error = "";
    state.screen = "app";
    render({ force: true });
  } catch (error) {
    state.error = error.message;
    render({ force: true });
  }
}

function paintApp() {
  const shell = h("main", { class: "shell" }, [
    h("header", { class: "top" }, [
      h("div", {}, [
        h("h1", {}, ["Passdown"]),
        h("p", { class: "eyebrow" }, ["Encrypted on this phone"]),
        h("p", { class: "eyebrow" }, [`Kept for ${RETENTION_DAYS} days`]),
      ]),
      h("button", { class: "button", type: "button", click: openMenu }, ["Menu"]),
    ]),
    h("div", { class: "filters" }, [
      h("div", { class: "chips", id: "chips" }),
      h("button", {
        class: "impt-filter",
        type: "button",
        id: "impt-filter",
        "aria-pressed": String(state.importantOnly),
        click: () => {
          state.importantOnly = !state.importantOnly;
          paintChips();
          paintList();
        },
      }, [IMPORTANT_LABEL]),
    ]),
    h("p", { class: "banner", id: "banner" }),
    h("div", { id: "log" }),
    h("button", { class: "add-note", type: "button", click: () => openComposer(null) }, ["Add note"]),
  ]);
  root.append(shell);
  root.append(composerDialog());
  root.append(replyDialog());
  root.append(tagDialog());
  root.append(menuDialog());
  root.append(keyDialog());
  root.append(confirmDialog());
  paintChips();
  paintList();
}

function onVisible() {
  if (document.visibilityState === "visible" && state.screen === "app") {
    refreshFromServer();
  }
}

async function refreshFromServer() {
  try {
    await openCatalog();
    await refreshNotes();
    state.banner = "";
    paintChips();
    paintList();
  } catch (error) {
    if (state.screen === "app") {
      state.banner = error.message;
      paintList();
    }
  }
}

function paintChips() {
  const host = document.querySelector("#chips");
  if (!host) return;
  const tags = tagsInOrder(state.extraTags, state.notes);
  if (state.tag !== "All" && !tags.includes(state.tag)) state.tag = "All";
  host.replaceChildren();
  for (const tag of ["All", ...tags]) {
    host.append(h("button", {
      class: "chip",
      type: "button",
      "aria-pressed": String(state.tag === tag),
      click: () => {
        state.tag = tag;
        paintChips();
        paintList();
      },
    }, [tag]));
  }
  host.append(h("button", { class: "chip", type: "button", click: () => openTagDialog("filter") }, ["New tag"]));
  const impt = document.querySelector("#impt-filter");
  if (impt) impt.setAttribute("aria-pressed", String(state.importantOnly));
}

function paintList() {
  const log = document.querySelector("#log");
  const banner = document.querySelector("#banner");
  if (!log || !banner) return;
  const messages = [];
  if (state.banner) messages.push(state.banner);
  if (state.locked) messages.push(`${state.locked} note${state.locked === 1 ? "" : "s"} couldn't be opened with this key.`);
  banner.textContent = messages.join(" ");
  const today = calendarDay(new Date());
  const { roots, replies } = partitionThreads(state.notes);
  const visible = groupByDate(sortNotes(filterNotes(roots, {
    tag: state.tag,
    importantOnly: state.importantOnly,
  }), state.extraTags));
  log.replaceChildren();
  if (!visible.length) {
    log.append(h("p", { class: "empty" }, [roots.length ? "Nothing with this filter." : `Nothing from the last ${RETENTION_DAYS} days.`]));
    return;
  }
  for (const group of visible) {
    log.append(h("h2", { class: "day" }, [formatDayLabel(group.date, today)]));
    for (const note of group.notes) log.append(noteCard(note, replies));
  }
}

function personLine(note) {
  const mine = note.ownerSub === state.user?.sub;
  const edited = Date.parse(note.serverUpdatedAt) - Date.parse(note.serverCreatedAt) > 2000;
  return `${mine ? "You" : (note.authorName || "Partner")} · ${formatTime(note.createdAt)}${edited ? " · edited" : ""}`;
}

function noteCard(note, replies) {
  const mine = note.ownerSub === state.user?.sub;
  const pinned = isPinned(state.flags, note.id);
  const view = threadView(note, replies.filter((reply) => reply.parentId === note.id));
  const expanded = state.openThreads.has(note.id);
  const card = h("article", { class: "note" }, [
    h("div", { class: "note-meta" }, [
      h("span", { class: "tag" }, [note.tag]),
      h("span", { class: "note-flags" }, [
        pinned ? h("span", { class: "pin-flag" }, ["Pinned"]) : null,
        note.important ? h("span", { class: "impt-flag" }, [IMPORTANT_LABEL]) : null,
      ]),
    ]),
    h("p", { class: "note-text" }, [note.text]),
    h("p", { class: "byline" }, [personLine(note)]),
    markControls(note),
    threadBlock(note, view, expanded),
  ]);
  card.append(h("div", { class: "note-actions" }, [
    h("button", { class: "text-button", type: "button", click: () => openReplyComposer(note) }, ["Reply"]),
    h("button", {
      class: "text-button",
      type: "button",
      "aria-pressed": String(pinned),
      click: () => (pinned ? unpinNote(note) : pinNote(note)),
    }, [pinned ? "Unpin" : "Pin"]),
    mine ? h("button", { class: "text-button", type: "button", click: () => openComposer(note) }, ["Edit"]) : null,
    h("button", { class: "text-button danger", type: "button", click: () => confirmDelete(note) }, ["Delete"]),
  ]));
  return card;
}

function markControls(note) {
  const mine = state.marks.find((mark) => mark.noteId === note.id && mark.ownerSub === state.user?.sub);
  return h("div", { class: "mark-block" }, [
    h("div", { class: "mark-row" }, [
      markButton(note, "ack", "✓ Acknowledged", mine?.kind === "ack"),
      markButton(note, "question", "? More", mine?.kind === "question"),
    ]),
    markSummary(note.id),
  ]);
}

function markButton(note, kind, label, pressed) {
  return h("button", {
    class: "mark-button",
    type: "button",
    "aria-pressed": String(pressed),
    click: () => saveMark(note, kind),
  }, [label]);
}

function markSummary(noteId) {
  const marks = state.marks
    .filter((mark) => mark.noteId === noteId)
    .sort((a, b) => Number(a.ownerSub !== state.user?.sub) - Number(b.ownerSub !== state.user?.sub));
  if (!marks.length) return null;
  const line = marks.map((mark) => {
    const who = mark.ownerSub === state.user?.sub ? "You" : (mark.name || "Partner");
    const action = mark.kind === "ack" ? "acknowledged" : "asked for more";
    return `${who} ${action}`;
  }).join(" · ");
  return h("p", { class: "mark-line" }, [line]);
}

function threadBlock(note, view, expanded) {
  if (!view.replies.length) return null;
  const shown = expanded ? view.replies : [view.latest];
  const toggle = view.replies.length > 1
    ? h("button", {
      class: "text-button thread-toggle",
      type: "button",
      "aria-expanded": String(expanded),
      click: () => {
        if (expanded) state.openThreads.delete(note.id);
        else state.openThreads.add(note.id);
        paintList();
      },
    }, [expanded ? "Hide replies" : `${view.earlierCount} earlier ${view.earlierCount === 1 ? "reply" : "replies"}`])
    : null;
  const items = shown.map((reply) => replyCard(note, reply));
  return h("div", { class: "thread" }, expanded ? [...items, toggle] : [toggle, ...items]);
}

function replyCard(parent, reply) {
  const mine = reply.ownerSub === state.user?.sub;
  return h("div", { class: "reply" }, [
    h("p", { class: "note-text" }, [reply.text]),
    h("p", { class: "byline" }, [personLine(reply)]),
    markControls(reply),
    h("div", { class: "note-actions" }, [
      mine ? h("button", { class: "text-button", type: "button", click: () => openReplyComposer(parent, reply) }, ["Edit"]) : null,
      h("button", { class: "text-button danger", type: "button", click: () => confirmDelete(reply) }, ["Delete"]),
    ]),
  ]);
}

let busy = false;

async function withBusy(work) {
  if (busy) return;
  busy = true;
  try {
    await work();
  } finally {
    busy = false;
  }
}

async function saveMark(note, kind) {
  await withBusy(async () => {
    const mine = state.marks.find((mark) => mark.noteId === note.id && mark.ownerSub === state.user?.sub);
    const next = toggleMark(mine?.kind || "", kind);
    try {
      if (!next) {
        const response = await api(`/api/notes/${note.id}/mark`, { method: "DELETE" });
        if (!response.ok) {
          const body = await response.json();
          state.banner = body.error || "That response could not be saved.";
          paintList();
          return;
        }
      } else {
        const ciphertext = await encryptJson(
          state.key,
          { kind: next, name: String(state.user?.name || "").trim().slice(0, 80) },
          `${note.id}\n${state.user.sub}`,
        );
        const response = await api(`/api/notes/${note.id}/mark`, {
          method: "PUT",
          body: JSON.stringify({ ciphertext }),
        });
        if (!response.ok) {
          const body = await response.json();
          state.banner = body.error || "That response could not be saved.";
          paintList();
          return;
        }
      }
      await refreshNotes();
      state.banner = "";
      paintList();
    } catch (error) {
      state.banner = error.message;
      paintList();
    }
  });
}

async function pinNote(note) {
  await withBusy(async () => {
    try {
      const ciphertext = await encryptJson(state.key, { pinned: true }, `flags:${note.id}`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = state.flags.find((flag) => flag.noteId === note.id && !flag.unreadable);
        const response = await api(`/api/notes/${note.id}/flags`, {
          method: "PUT",
          body: JSON.stringify({ ciphertext, baseUpdatedAt: current?.updatedAt ?? null }),
        });
        if (response.status === 409) {
          const body = await response.json();
          if (!body.ciphertext) {
            state.banner = "Could not pin this note.";
            paintList();
            return;
          }
          try {
            const data = await decryptJson(state.key, body.ciphertext, `flags:${note.id}`);
            if (data?.pinned === true) break;
          } catch {
            break;
          }
          state.flags = state.flags.filter((flag) => flag.noteId !== note.id);
          state.flags.push({ noteId: note.id, pinned: false, updatedAt: body.updatedAt, unreadable: false });
          continue;
        }
        if (!response.ok) {
          const body = await response.json();
          state.banner = body.error || "Could not pin this note.";
          paintList();
          return;
        }
        break;
      }
      await refreshNotes();
      state.banner = "";
      paintList();
    } catch (error) {
      state.banner = error.message;
      paintList();
    }
  });
}

function unpinNote(note) {
  const today = calendarDay(new Date());
  if (!isWithinRetention(note.date, today)) {
    const replies = state.notes.some((item) => item.parentId === note.id);
    const text = replies
      ? "Unpin this note? It is older than 7 days, so unpinning deletes it and its replies for both of you."
      : "Unpin this note? It is older than 7 days, so unpinning deletes it for both of you.";
    askConfirm(text, () => removeNote(note), "Unpin and delete");
    return;
  }
  withBusy(async () => {
    try {
      const response = await api(`/api/notes/${note.id}/flags`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json();
        state.banner = body.error || "Could not unpin this note.";
        paintList();
        return;
      }
      await refreshNotes();
      state.banner = "";
      paintChips();
      paintList();
    } catch (error) {
      state.banner = error.message;
      paintList();
    }
  });
}

function composerDialog() {
  return h("dialog", { class: "sheet", id: "composer" }, [
    h("form", { id: "composer-form", submit: saveComposer }, [
      h("div", { class: "sheet-bar" }, [
        h("button", { class: "text-button", type: "button", click: () => document.querySelector("#composer").close() }, ["Cancel"]),
        h("h2", { id: "composer-title" }, ["New note"]),
        h("button", { class: "text-button end", type: "submit" }, ["Save"]),
      ]),
      h("label", { class: "field" }, [
        h("span", {}, ["Date"]),
        h("input", { name: "date", type: "date", required: "true" }),
      ]),
      h("div", { class: "tag-pick", id: "composer-tags" }),
      h("label", { class: "field" }, [
        h("span", {}, ["New tag"]),
        h("input", { name: "newTag", type: "text", maxlength: "20", placeholder: "Optional, such as Pets" }),
      ]),
      h("label", { class: "switch" }, [
        h("span", {}, [h("strong", {}, [IMPORTANT_LABEL]), "Missing this has a real consequence."]),
        h("input", { name: "important", type: "checkbox" }),
      ]),
      h("label", { class: "field" }, [
        h("span", {}, ["Note"]),
        h("textarea", { name: "text", maxlength: String(MAX_TEXT), required: "true", input: updateCount }),
      ]),
      h("p", { class: "count", id: "count" }, [`0/${MAX_TEXT}`]),
      h("p", { class: "form-error", id: "composer-error" }),
    ]),
  ]);
}

function updateCount(event) {
  const count = document.querySelector("#count");
  if (count) count.textContent = `${event.currentTarget.value.length}/${MAX_TEXT}`;
}

async function openComposer(note) {
  try {
    await openCatalog();
  } catch {
    state.banner = "You need a connection to open the log.";
  }
  state.draft = note ? {
    mode: "edit",
    id: note.id,
    tag: note.tag,
    date: note.date,
    createdAt: note.createdAt,
    authorName: note.authorName,
    authorEmail: note.authorEmail,
  } : {
    mode: "new",
    tag: SEED_TAGS[0],
  };
  const dialog = document.querySelector("#composer");
  const form = document.querySelector("#composer-form");
  document.querySelector("#composer-title").textContent = note ? "Edit note" : "New note";
  const today = calendarDay(new Date());
  const oldest = retentionStart(today);
  const keepDate = note && isPinned(state.flags, note.id) && !isWithinRetention(note.date, today);
  form.date.min = keepDate ? note.date : oldest;
  form.date.value = note?.date || today;
  form.text.value = note?.text || "";
  form.important.checked = Boolean(note?.important);
  document.querySelector("#composer-error").textContent = "";
  document.querySelector("#count").textContent = `${form.text.value.length}/${MAX_TEXT}`;
  paintComposerTags();
  dialog.showModal();
}

function paintComposerTags() {
  const host = document.querySelector("#composer-tags");
  if (!host || !state.draft) return;
  host.replaceChildren();
  for (const tag of tagsInOrder(state.extraTags, state.notes)) {
    host.append(h("button", {
      class: "chip",
      type: "button",
      "aria-pressed": String(state.draft.tag === tag),
      click: () => {
        state.draft.tag = tag;
        paintComposerTags();
      },
    }, [tag]));
  }
}

async function saveComposer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#composer-error");
  if (form.newTag.value.trim()) {
    const tagResult = validateExtraTag(form.newTag.value, state.extraTags);
    if (!tagResult.ok) {
      error.textContent = tagResult.error;
      return;
    }
    try {
      await saveExtraTags([...state.extraTags, tagResult.tag], state.catalogUpdatedAt);
      state.draft.tag = tagResult.tag;
      form.newTag.value = "";
    } catch (err) {
      error.textContent = err.message;
      return;
    }
  }
  const allowed = tagsInOrder(state.extraTags, state.notes);
  const today = calendarDay(new Date());
  const keepDate = state.draft.mode === "edit"
    && isPinned(state.flags, state.draft.id)
    && state.draft.date
    && !isWithinRetention(state.draft.date, today);
  const parsed = validateNoteInput({
    date: form.date.value,
    text: form.text.value,
    tag: state.draft.tag,
    allowedTags: allowed,
    today,
    existingDate: keepDate ? state.draft.date : "",
  });
  if (!parsed.ok) {
    error.textContent = parsed.error;
    return;
  }
  const payload = {
    date: parsed.date,
    text: parsed.text,
    tag: parsed.tag,
    important: form.important.checked,
    authorName: state.draft.authorName || state.user.name,
    authorEmail: state.draft.authorEmail || state.user.email,
    createdAt: state.draft.createdAt || new Date().toISOString(),
  };
  try {
    if (state.draft.mode === "edit") {
      const ciphertext = await encryptJson(state.key, payload, state.draft.id);
      const response = await api(`/api/notes/${state.draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ciphertext }),
      });
      if (!response.ok) {
        const body = await response.json();
        error.textContent = body.error || "That note could not be saved.";
        return;
      }
    } else {
      const id = crypto.randomUUID();
      const ciphertext = await encryptJson(state.key, payload, id);
      const response = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ id, ciphertext }),
      });
      if (!response.ok) {
        const body = await response.json();
        error.textContent = body.error || "That note could not be saved.";
        return;
      }
    }
    await refreshNotes();
    document.querySelector("#composer").close();
    state.banner = "";
    paintChips();
    paintList();
  } catch (err) {
    if (error) error.textContent = err.message;
  }
}

function replyDialog() {
  return h("dialog", { class: "sheet", id: "reply-composer" }, [
    h("form", { id: "reply-form", submit: saveReply }, [
      h("div", { class: "sheet-bar" }, [
        h("button", { class: "text-button", type: "button", click: () => document.querySelector("#reply-composer").close() }, ["Cancel"]),
        h("h2", { id: "reply-title" }, ["Reply"]),
        h("button", { class: "text-button end", type: "submit" }, ["Save"]),
      ]),
      h("label", { class: "field" }, [
        h("span", {}, ["Reply"]),
        h("textarea", { name: "text", maxlength: String(MAX_TEXT), required: "true", input: updateReplyCount }),
      ]),
      h("p", { class: "count", id: "reply-count" }, [`0/${MAX_TEXT}`]),
      h("p", { class: "form-error", id: "reply-error" }),
    ]),
  ]);
}

function updateReplyCount(event) {
  const count = document.querySelector("#reply-count");
  if (count) count.textContent = `${event.currentTarget.value.length}/${MAX_TEXT}`;
}

function openReplyComposer(parent, reply) {
  state.replyDraft = reply ? {
    mode: "edit",
    id: reply.id,
    parentId: parent.id,
    date: reply.date,
    tag: reply.tag,
    createdAt: reply.createdAt,
    authorName: reply.authorName,
    authorEmail: reply.authorEmail,
  } : {
    mode: "new",
    parentId: parent.id,
  };
  const dialog = document.querySelector("#reply-composer");
  const form = document.querySelector("#reply-form");
  document.querySelector("#reply-title").textContent = reply ? "Edit reply" : "Reply";
  form.text.value = reply?.text || "";
  document.querySelector("#reply-error").textContent = "";
  document.querySelector("#reply-count").textContent = `${form.text.value.length}/${MAX_TEXT}`;
  dialog.showModal();
}

async function saveReply(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = document.querySelector("#reply-error");
  const parent = state.notes.find((note) => note.id === state.replyDraft?.parentId);
  const parsed = validateReplyInput({ text: form.text.value, parent });
  if (!parsed.ok) {
    error.textContent = parsed.error;
    return;
  }
  const editing = state.replyDraft.mode === "edit";
  const payload = {
    date: editing ? state.replyDraft.date : parent.date,
    text: parsed.text,
    tag: editing ? state.replyDraft.tag : parent.tag,
    important: false,
    authorName: editing ? state.replyDraft.authorName : state.user.name,
    authorEmail: editing ? state.replyDraft.authorEmail : state.user.email,
    createdAt: editing ? state.replyDraft.createdAt : new Date().toISOString(),
    parentId: parent.id,
  };
  await withBusy(async () => {
    try {
      if (editing) {
        const ciphertext = await encryptJson(state.key, payload, state.replyDraft.id);
        const response = await api(`/api/notes/${state.replyDraft.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ciphertext }),
        });
        if (!response.ok) {
          const body = await response.json();
          error.textContent = body.error || "That reply could not be saved.";
          return;
        }
      } else {
        const id = crypto.randomUUID();
        const ciphertext = await encryptJson(state.key, payload, id);
        const response = await api("/api/notes", {
          method: "POST",
          body: JSON.stringify({ id, ciphertext }),
        });
        if (!response.ok) {
          const body = await response.json();
          error.textContent = body.error || "That reply could not be saved.";
          return;
        }
      }
      await refreshNotes();
      document.querySelector("#reply-composer").close();
      state.banner = "";
      paintList();
    } catch (err) {
      if (error) error.textContent = err.message;
    }
  });
}

function tagDialog() {
  return h("dialog", { class: "card", id: "tag-dialog" }, [
    h("form", { class: "dialog-body stack", submit: saveTag }, [
      h("h2", {}, ["New tag"]),
      h("input", { name: "tag", type: "text", maxlength: "20", placeholder: "Pets", autocapitalize: "words" }),
      h("p", { class: "form-error", id: "tag-error" }),
      h("button", { class: "button primary wide", type: "submit" }, ["Add tag"]),
      h("button", { class: "button wide", type: "button", click: () => document.querySelector("#tag-dialog").close() }, ["Cancel"]),
    ]),
  ]);
}

let tagDestination = "filter";

function openTagDialog(destination) {
  tagDestination = destination;
  const dialog = document.querySelector("#tag-dialog");
  dialog.querySelector("input").value = "";
  document.querySelector("#tag-error").textContent = "";
  dialog.showModal();
}

async function saveTag(event) {
  event.preventDefault();
  const input = event.currentTarget.tag.value;
  const result = validateExtraTag(input, state.extraTags);
  if (!result.ok) {
    document.querySelector("#tag-error").textContent = result.error;
    return;
  }
  try {
    await saveExtraTags([...state.extraTags, result.tag], state.catalogUpdatedAt);
    document.querySelector("#tag-dialog").close();
    if (tagDestination === "composer" && state.draft) {
      state.draft.tag = result.tag;
      paintComposerTags();
    }
    paintChips();
  } catch (error) {
    document.querySelector("#tag-error").textContent = error.message;
  }
}

function menuDialog() {
  return h("dialog", { class: "card", id: "menu" }, [
    h("div", { class: "menu-list" }, [
      h("button", { type: "button", click: exportCsv }, ["Export CSV"]),
      h("button", { type: "button", click: () => { document.querySelector("#menu").close(); showRecovery(); } }, ["Recovery key"]),
      h("button", { type: "button", click: signOut }, ["Sign out"]),
      h("button", { class: "danger", type: "button", click: () => askConfirm("Forget the key on this phone? This phone will need the recovery key again.", forgetKey, "Forget key") }, ["Forget key on this phone"]),
      h("button", { type: "button", click: () => document.querySelector("#menu").close() }, ["Close"]),
    ]),
  ]);
}

function openMenu() {
  document.querySelector("#menu").showModal();
}

function keyDialog() {
  return h("dialog", { class: "sheet", id: "key-dialog" }, [
    h("div", { class: "sheet-bar" }, [
      h("button", { class: "text-button", type: "button", click: () => document.querySelector("#key-dialog").close() }, ["Close"]),
      h("h2", {}, ["Recovery key"]),
      h("span"),
    ]),
    h("p", { class: "lede" }, ["Share this in person or on Signal, not by email."]),
    h("div", { class: "qr", id: "saved-qr", role: "img", "aria-label": "QR code for the recovery key" }),
    h("textarea", { class: "key-box", id: "saved-key", readonly: "true", rows: "3" }),
    h("button", { class: "button wide", type: "button", click: (event) => copyKey(document.querySelector("#saved-key"), event.currentTarget) }, ["Copy key"]),
  ]);
}

function showRecovery() {
  const dialog = document.querySelector("#key-dialog");
  document.querySelector("#saved-key").value = formatRecoveryKey(state.recoveryKey);
  const qr = document.querySelector("#saved-qr");
  qr.innerHTML = renderSVG(recoveryUrl(), { ecc: "M", border: 2, pixelSize: 8, blackColor: "#221e1a", whiteColor: "#ffffff" });
  dialog.showModal();
}

function exportNotes() {
  const { roots, replies } = partitionThreads(state.notes);
  const rows = [];
  for (const root of sortNotes(roots, state.extraTags)) {
    rows.push(decorateExport(root));
    const view = threadView(root, replies.filter((reply) => reply.parentId === root.id));
    for (const reply of view.replies) rows.push(decorateExport(reply));
  }
  return rows;
}

function decorateExport(note) {
  const marks = state.marks.filter((mark) => mark.noteId === note.id);
  const nameFor = (mark) => (mark.ownerSub === state.user?.sub ? (state.user.name || "You") : (mark.name || "Partner"));
  return {
    ...note,
    pinned: isPinned(state.flags, note.id),
    ack: marks.filter((mark) => mark.kind === "ack").map(nameFor).join("; "),
    question: marks.filter((mark) => mark.kind === "question").map(nameFor).join("; "),
  };
}

async function exportCsv() {
  document.querySelector("#menu")?.close();
  const notes = exportNotes();
  const file = new File([notesToCsv(notes)], `passdown-${calendarDay(new Date())}.csv`, { type: "text/csv" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Passdown" });
      state.banner = `Exported ${file.name}`;
      paintList();
      return;
    }
  } catch (error) {
    if (error.name === "AbortError") return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(link.href);
  state.banner = `Exported ${file.name}`;
  paintList();
}

async function signOut() {
  document.querySelector("#menu")?.close();
  await api("/api/session/logout", { method: "POST", body: "{}" });
  state.user = null;
  state.screen = "signedOut";
  state.error = "";
  render({ force: true });
}

function confirmDialog() {
  return h("dialog", { class: "card", id: "confirm" }, [
    h("form", { method: "dialog", class: "dialog-body stack" }, [
      h("p", { id: "confirm-text" }, [""]),
      h("button", { class: "button danger wide", value: "yes" }, ["Continue"]),
      h("button", { class: "button wide", value: "no" }, ["Cancel"]),
    ]),
  ]);
}

let confirmAction = () => {};

function askConfirm(text, action, confirmLabel = "Continue") {
  document.querySelector("#menu")?.close();
  confirmAction = action;
  document.querySelector("#confirm-text").textContent = text;
  document.querySelector("#confirm .danger").textContent = confirmLabel;
  const dialog = document.querySelector("#confirm");
  dialog.showModal();
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "yes") confirmAction();
  }, { once: true });
}

function confirmDelete(note) {
  const replies = state.notes.some((item) => item.parentId === note.id);
  const text = replies
    ? "Delete this note and its replies? This removes them for both of you."
    : note.parentId
      ? "Delete this reply? This removes it for both of you."
      : "Delete this note? This removes it for both of you.";
  askConfirm(text, () => removeNote(note), "Delete");
}

async function removeNote(note) {
  const replies = state.notes.filter((item) => item.parentId === note.id);
  try {
    for (const reply of replies) {
      const response = await api(`/api/notes/${reply.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json();
        state.banner = body.error || "That note could not be deleted.";
        paintList();
        return;
      }
    }
    const response = await api(`/api/notes/${note.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json();
      state.banner = body.error || "That note could not be deleted.";
      paintList();
      return;
    }
    state.openThreads.delete(note.id);
    await refreshNotes();
    state.banner = "";
    paintChips();
    paintList();
  } catch (error) {
    state.banner = error.message;
    paintList();
  }
}

function forgetKey() {
  localStorage.removeItem(KEY_STORAGE);
  sessionStorage.removeItem(PENDING_KEY);
  state.key = null;
  state.recoveryKey = "";
  state.notes = [];
  state.logExists = true;
  state.error = "";
  state.screen = "choose";
  render({ force: true });
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (typeof value === "function") node.addEventListener(key, value);
    else if (key === "disabled" || key === "checked" || key === "value") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

document.addEventListener("visibilitychange", onVisible);
