import assert from "node:assert/strict";
import test from "node:test";
import { createSessionToken, readSessionToken, verifyGoogleIdToken } from "../functions/lib/auth.js";
import { bytesToBase64Url, stringToBase64Url } from "../functions/lib/bytes.js";
import { handleRequest } from "../functions/lib/api.js";
import { createTestDb } from "./d1.js";

const SECRET = "test-session-secret-value";

function env(extra = {}) {
  return {
    DB: createTestDb(),
    SESSION_SECRET: SECRET,
    ALLOWED_EMAILS: "astrocheet4h@gmail.com,second.person@example.com",
    ALLOW_DEV_LOGIN: "true",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    ...extra,
  };
}

async function call(target, path, { method = "GET", body, cookie, host = "localhost" } = {}) {
  const headers = new Headers({ origin: `http://${host}` });
  if (cookie) headers.set("cookie", `session=${cookie}`);
  const request = new Request(`http://${host}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleRequest(request, target);
}

async function login(target, email, name, host = "localhost") {
  const response = await call(target, "/api/session/dev", {
    method: "POST",
    body: { email, name },
    host,
  });
  const cookie = response.headers.get("set-cookie") || "";
  const token = /session=([^;]+)/.exec(cookie)?.[1] || "";
  return { response, token, body: await response.json() };
}

test("config does not reveal the allowlist and local sign-in stays on localhost", async () => {
  const target = env();
  const local = await call(target, "/api/config");
  const localBody = await local.json();
  assert.equal(localBody.devLogin, true);
  assert.equal(JSON.stringify(localBody).includes("astrocheet4h"), false);
  const remote = await call(target, "/api/config", { host: "logbook.pages.dev" });
  assert.equal((await remote.json()).devLogin, false);
  const dev = await login(target, "astrocheet4h@gmail.com", "Alex", "logbook.pages.dev");
  assert.equal(dev.response.status, 404);
});

test("only allowlisted people get a session", async () => {
  const target = env();
  const allowed = await login(target, "astrocheet4h@gmail.com", "Alex");
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.user.email, "astrocheet4h@gmail.com");
  const me = await call(target, "/api/me", { cookie: allowed.token });
  assert.equal((await me.json()).user.name, "Alex");
  const stranger = await login(target, "stranger@gmail.com", "Stranger");
  assert.equal(stranger.response.status, 403);
  const notes = await call(target, "/api/notes");
  assert.equal(notes.status, 401);
});

test("session cookies expire and reject tampering", async () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const token = await createSessionToken(SECRET, {
    sub: "dev:astrocheet4h@gmail.com",
    email: "astrocheet4h@gmail.com",
    name: "Alex",
  }, now);
  assert.equal((await readSessionToken(SECRET, token, now)).email, "astrocheet4h@gmail.com");
  assert.equal(await readSessionToken(SECRET, token, now + 31 * 24 * 60 * 60 * 1000), null);
  const [body, signature] = token.split(".");
  const flipped = `${body}.${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
  assert.equal(await readSessionToken(SECRET, flipped, now), null);
});

test("either person can delete a note and only the author can edit", async () => {
  const target = env();
  const alex = await login(target, "astrocheet4h@gmail.com", "Alex");
  const jordan = await login(target, "second.person@example.com", "Jordan");
  const id = crypto.randomUUID();
  const created = await call(target, "/api/notes", {
    method: "POST",
    cookie: alex.token,
    body: { id, ciphertext: "A".repeat(48) },
  });
  assert.equal(created.status, 201);
  const repeat = await call(target, "/api/notes", {
    method: "POST",
    cookie: alex.token,
    body: { id, ciphertext: "A".repeat(48) },
  });
  assert.equal(repeat.status, 200);
  const listed = await call(target, "/api/notes", { cookie: jordan.token });
  assert.equal((await listed.json()).notes.length, 1);
  const edited = await call(target, `/api/notes/${id}`, {
    method: "PATCH",
    cookie: jordan.token,
    body: { ciphertext: "B".repeat(48) },
  });
  assert.equal(edited.status, 403);
  const ownEdit = await call(target, `/api/notes/${id}`, {
    method: "PATCH",
    cookie: alex.token,
    body: { ciphertext: "C".repeat(48) },
  });
  assert.equal(ownEdit.status, 200);
  const removed = await call(target, `/api/notes/${id}`, { method: "DELETE", cookie: jordan.token });
  assert.equal(removed.status, 200);
  const after = await call(target, "/api/notes", { cookie: alex.token });
  assert.equal((await after.json()).notes.length, 0);
});

test("tag catalog create conflicts instead of overwriting", async () => {
  const target = env();
  const alex = await login(target, "astrocheet4h@gmail.com", "Alex");
  const empty = await call(target, "/api/catalog", { cookie: alex.token });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).ciphertext, null);
  const first = await call(target, "/api/catalog", {
    method: "PUT",
    cookie: alex.token,
    body: { ciphertext: "C".repeat(40), baseUpdatedAt: null },
  });
  assert.equal(first.status, 200);
  const second = await call(target, "/api/catalog", {
    method: "PUT",
    cookie: alex.token,
    body: { ciphertext: "D".repeat(40), baseUpdatedAt: null },
  });
  assert.equal(second.status, 409);
  const current = await second.json();
  assert.equal(current.ciphertext, "C".repeat(40));
  const saved = await call(target, "/api/catalog", {
    method: "PUT",
    cookie: alex.token,
    body: { ciphertext: "E".repeat(40), baseUpdatedAt: current.updatedAt },
  });
  assert.equal(saved.status, 200);
});

test("google sign-in checks the signature, audience, and verified email", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "test-key";
  const header = stringToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
  const payload = stringToBase64Url(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "test-client.apps.googleusercontent.com",
    exp: Math.floor(Date.now() / 1000) + 300,
    email: "astrocheet4h@gmail.com",
    email_verified: true,
    sub: "google-sub-1",
    name: "Alex",
  }));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  ));
  const token = `${header}.${payload}.${bytesToBase64Url(signature)}`;
  const user = await verifyGoogleIdToken(token, {
    clientId: "test-client.apps.googleusercontent.com",
    fetchJwks: async () => [jwk],
  });
  assert.equal(user.email, "astrocheet4h@gmail.com");
  await assert.rejects(() => verifyGoogleIdToken(token, {
    clientId: "other-client.apps.googleusercontent.com",
    fetchJwks: async () => [jwk],
  }));
});
