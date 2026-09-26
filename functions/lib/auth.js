import { base64UrlToBytes, base64UrlToString, bytesToBase64Url, stringToBase64Url } from "./bytes.js";

const SESSION_SECONDS = 60 * 60 * 24 * 30;

export class AuthError extends Error {
  constructor(message = "Sign-in failed.") {
    super(message);
    this.name = "AuthError";
  }
}

export function parseAllowlist(value) {
  return new Set(String(value || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function isAllowed(allowlist, email) {
  return allowlist.has(String(email || "").trim().toLowerCase());
}

export function cleanName(name) {
  const cleaned = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return cleaned || "Someone";
}

export function isLocalHost(request) {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function devLoginAllowed(request, env) {
  return env.ALLOW_DEV_LOGIN === "true" && isLocalHost(request);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken(secret, user, now = Date.now()) {
  const payload = {
    sub: user.sub,
    email: user.email.toLowerCase(),
    name: cleanName(user.name),
    exp: Math.floor(now / 1000) + SESSION_SECONDS,
  };
  const body = stringToBase64Url(JSON.stringify(payload));
  return `${body}.${await sign(secret, body)}`;
}

export async function readSessionToken(secret, token, now = Date.now()) {
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = await sign(secret, body);
  if (!timingSafeEqual(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlToString(body));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;
  return { sub: payload.sub, email: payload.email, name: cleanName(payload.name) };
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

export function sessionCookie(token, { secure, maxAge = SESSION_SECONDS } = {}) {
  const parts = [`session=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

let jwksCache = { expires: 0, keys: [] };

export async function fetchGoogleJwks() {
  const now = Date.now();
  if (jwksCache.expires > now && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) throw new AuthError("Sign-in failed.");
  const body = await response.json();
  jwksCache = { expires: now + 60 * 60 * 1000, keys: body.keys || [] };
  return jwksCache.keys;
}

export function clearJwksCache() {
  jwksCache = { expires: 0, keys: [] };
}

export async function verifyGoogleIdToken(idToken, { clientId, fetchJwks, now = Date.now() }) {
  if (!clientId || typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8192) {
    throw new AuthError();
  }
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AuthError();
  const [headerPart, payloadPart, signaturePart] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlToString(headerPart));
    payload = JSON.parse(base64UrlToString(payloadPart));
  } catch {
    throw new AuthError();
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError();
  const keys = await fetchJwks(header.kid);
  const jwk = (keys || []).find((key) => key.kid === header.kid);
  if (!jwk) throw new AuthError();
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new AuthError();
  const issuerOk = payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
  const audience = payload.aud;
  const audienceOk = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  const expires = Number(payload.exp);
  if (!issuerOk || !audienceOk || !Number.isFinite(expires) || expires * 1000 < now - 60_000) throw new AuthError();
  if (payload.email_verified !== true || typeof payload.email !== "string" || typeof payload.sub !== "string") {
    throw new AuthError();
  }
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: cleanName(payload.name || payload.email),
  };
}
