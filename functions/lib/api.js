import {
  AuthError,
  cleanName,
  createSessionToken,
  devLoginAllowed,
  isAllowed,
  parseAllowlist,
  readCookie,
  readSessionToken,
  sessionCookie,
  verifyGoogleIdToken,
  fetchGoogleJwks,
} from "./auth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CIPHERTEXT = /^[A-Za-z0-9_-]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

function changes(result) {
  return Number(result?.meta?.changes ?? 0);
}

function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "That request was rejected.");
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 100_000) throw new HttpError(413, "That note is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "That request was rejected.");
  }
}

function requireSecret(env) {
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 16) {
    throw new HttpError(500, "Sign-in isn't configured yet.");
  }
}

function requireDb(env) {
  if (!env.DB) throw new HttpError(500, "The log storage isn't set up yet.");
}

function allowlist(env) {
  return parseAllowlist(env.ALLOWED_EMAILS);
}

async function currentUser(request, env) {
  requireSecret(env);
  const token = readCookie(request, "session");
  const session = await readSessionToken(env.SESSION_SECRET, token);
  if (!session) return null;
  if (!isAllowed(allowlist(env), session.email)) return null;
  return session;
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Sign in required.");
  return user;
}

function cookieHeader(request, token) {
  const secure = new URL(request.url).protocol === "https:";
  return { "set-cookie": sessionCookie(token, { secure, maxAge: token ? undefined : 0 }) };
}

function requireCiphertext(value, max) {
  if (typeof value !== "string" || value.length < 20 || value.length > max || !CIPHERTEXT.test(value)) {
    throw new HttpError(400, "That note could not be saved.");
  }
  return value;
}

async function getCatalog(db) {
  return db.prepare("SELECT ciphertext, updated_at FROM catalog WHERE id = 1").first();
}

function catalogJson(row, status = 200) {
  if (!row) return json({ error: "No log yet." }, 404);
  return json({ ciphertext: row.ciphertext, updatedAt: row.updated_at }, status);
}

async function handleSession(request, env) {
  assertSameOrigin(request);
  requireSecret(env);
  const body = await readJson(request);
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(500, "Google sign-in isn't configured yet.");
  let user;
  try {
    user = await verifyGoogleIdToken(body.idToken, {
      clientId: env.GOOGLE_CLIENT_ID,
      fetchJwks: env.fetchJwks || fetchGoogleJwks,
    });
  } catch (error) {
    if (error instanceof AuthError) throw new HttpError(401, "Sign-in failed.");
    throw error;
  }
  if (!isAllowed(allowlist(env), user.email)) throw new HttpError(403, "This account can't open the log.");
  const token = await createSessionToken(env.SESSION_SECRET, user);
  return json({ user }, 200, cookieHeader(request, token));
}

async function handleDevSession(request, env) {
  if (!devLoginAllowed(request, env)) return json({ error: "Not found." }, 404);
  assertSameOrigin(request);
  requireSecret(env);
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email.");
  if (!isAllowed(allowlist(env), email)) throw new HttpError(403, "This account can't open the log.");
  const user = { sub: `dev:${email}`, email, name: cleanName(body.name || email.split("@")[0]) };
  const token = await createSessionToken(env.SESSION_SECRET, user);
  return json({ user }, 200, cookieHeader(request, token));
}

function handleLogout(request, env) {
  assertSameOrigin(request);
  requireSecret(env);
  const secure = new URL(request.url).protocol === "https:";
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", { secure, maxAge: 0 }) });
}

async function listNotes(db) {
  const { results } = await db.prepare(
    "SELECT id, owner_sub, ciphertext, created_at, updated_at FROM notes ORDER BY created_at ASC, id ASC",
  ).all();
  return (results || []).map((row) => ({
    id: row.id,
    ownerSub: row.owner_sub,
    ciphertext: row.ciphertext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function handleNotes(request, env) {
  requireDb(env);
  const user = await requireUser(request, env);
  if (request.method === "GET") return json({ notes: await listNotes(env.DB) });
  if (request.method !== "POST") throw new HttpError(405, "That request was rejected.");
  assertSameOrigin(request);
  const body = await readJson(request);
  if (typeof body.id !== "string" || !UUID.test(body.id)) throw new HttpError(400, "That note could not be saved.");
  const ciphertext = requireCiphertext(body.ciphertext, 20_000);
  const existing = await env.DB.prepare(
    "SELECT id, owner_sub, ciphertext, created_at, updated_at FROM notes WHERE id = ?",
  ).bind(body.id).first();
  if (existing) {
    if (existing.owner_sub === user.sub && existing.ciphertext === ciphertext) {
      return json({
        note: {
          id: existing.id,
          ownerSub: existing.owner_sub,
          ciphertext: existing.ciphertext,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
        },
      });
    }
    throw new HttpError(409, "That note could not be saved.");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO notes (id, owner_sub, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(body.id, user.sub, ciphertext, now, now).run();
  return json({
    note: { id: body.id, ownerSub: user.sub, ciphertext, createdAt: now, updatedAt: now },
  }, 201);
}

async function handleNote(request, env, id) {
  requireDb(env);
  const user = await requireUser(request, env);
  if (!UUID.test(id)) throw new HttpError(404, "That note is gone.");
  const existing = await env.DB.prepare("SELECT id, owner_sub FROM notes WHERE id = ?").bind(id).first();
  if (!existing) throw new HttpError(404, "That note is gone.");
  if (existing.owner_sub !== user.sub) throw new HttpError(403, "Only the author can change this note.");
  assertSameOrigin(request);
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM notes WHERE id = ? AND owner_sub = ?").bind(id, user.sub).run();
    if (changes(result) !== 1) throw new HttpError(404, "That note is gone.");
    return json({ ok: true });
  }
  if (request.method !== "PATCH") throw new HttpError(405, "That request was rejected.");
  const body = await readJson(request);
  const ciphertext = requireCiphertext(body.ciphertext, 20_000);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE notes SET ciphertext = ?, updated_at = ? WHERE id = ? AND owner_sub = ?",
  ).bind(ciphertext, now, id, user.sub).run();
  if (changes(result) !== 1) throw new HttpError(404, "That note is gone.");
  return json({ note: { id, ownerSub: user.sub, ciphertext, updatedAt: now } });
}

async function handleCatalog(request, env) {
  requireDb(env);
  await requireUser(request, env);
  if (request.method === "GET") {
    const row = await getCatalog(env.DB);
    if (!row) return json({ ciphertext: null, updatedAt: null });
    return catalogJson(row);
  }
  if (request.method !== "PUT") throw new HttpError(405, "That request was rejected.");
  assertSameOrigin(request);
  const body = await readJson(request);
  const ciphertext = requireCiphertext(body.ciphertext, 50_000);
  const baseUpdatedAt = body.baseUpdatedAt ?? null;
  if (baseUpdatedAt !== null && typeof baseUpdatedAt !== "string") {
    throw new HttpError(400, "Could not save tags.");
  }
  const now = new Date().toISOString();
  if (baseUpdatedAt === null) {
    const existing = await getCatalog(env.DB);
    if (existing) return catalogJson(existing, 409);
    try {
      await env.DB.prepare("INSERT INTO catalog (id, ciphertext, updated_at) VALUES (1, ?, ?)").bind(ciphertext, now).run();
    } catch {
      const current = await getCatalog(env.DB);
      if (current) return catalogJson(current, 409);
      throw new HttpError(500, "Could not save tags.");
    }
    return json({ updatedAt: now });
  }
  const result = await env.DB.prepare(
    "UPDATE catalog SET ciphertext = ?, updated_at = ? WHERE id = 1 AND updated_at = ?",
  ).bind(ciphertext, now, baseUpdatedAt).run();
  if (changes(result) !== 1) return catalogJson(await getCatalog(env.DB), 409);
  return json({ updatedAt: now });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return json({ error: "Not found." }, 404);
  try {
    if (parts[1] === "config" && parts.length === 2 && request.method === "GET") {
      return json({
        googleClientId: env.GOOGLE_CLIENT_ID || "",
        devLogin: devLoginAllowed(request, env),
        timeZone: "America/Los_Angeles",
      });
    }
    if (parts[1] === "session" && parts.length === 2 && request.method === "POST") return await handleSession(request, env);
    if (parts[1] === "session" && parts[2] === "dev" && parts.length === 3 && request.method === "POST") {
      return await handleDevSession(request, env);
    }
    if (parts[1] === "session" && parts[2] === "logout" && parts.length === 3 && request.method === "POST") {
      return handleLogout(request, env);
    }
    if (parts[1] === "me" && parts.length === 2 && request.method === "GET") {
      const user = await currentUser(request, env);
      if (!user) return json({ error: "Sign in required." }, 401);
      return json({ user });
    }
    if (parts[1] === "notes" && parts.length === 2) return await handleNotes(request, env);
    if (parts[1] === "notes" && parts.length === 3) return await handleNote(request, env, parts[2]);
    if (parts[1] === "catalog" && parts.length === 2) return await handleCatalog(request, env);
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error("request failed");
    return json({ error: "Something went wrong." }, 500);
  }
}
