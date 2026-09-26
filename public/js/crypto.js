import { base64UrlToBytes, bytesToBase64Url } from "./bytes.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeRecoveryKey(rawBytes) {
  return bytesToBase64Url(rawBytes);
}

export function formatRecoveryKey(recoveryKey) {
  return recoveryKey.replace(/(.{4})/g, "$1 ").trim();
}

export function parseRecoveryKeyInput(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("Enter the recovery key.");
  let keyText = trimmed;
  if (trimmed.includes("://") || trimmed.startsWith("#")) {
    const url = trimmed.startsWith("#") ? new URL(trimmed, "https://logbook.local") : new URL(trimmed);
    const fromHash = new URLSearchParams(url.hash.replace(/^#/, "")).get("k");
    if (!fromHash) throw new Error("That key doesn't look right.");
    keyText = fromHash;
  }
  keyText = keyText.replace(/^logbook:/i, "").replace(/\s+/g, "");
  let raw;
  try {
    raw = base64UrlToBytes(keyText);
  } catch {
    throw new Error("That key doesn't look right.");
  }
  if (raw.length !== 32) throw new Error("That key doesn't look right.");
  return raw;
}

export async function importMasterKey(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length !== 32) {
    throw new Error("That key doesn't look right.");
  }
  return crypto.subtle.importKey("raw", rawBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function generateMasterKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await importMasterKey(raw);
  return { raw, key, recoveryKey: encodeRecoveryKey(raw) };
}

export async function encryptJson(key, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textEncoder.encode(aad) },
    key,
    textEncoder.encode(JSON.stringify(value)),
  ));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return bytesToBase64Url(packed);
}

export async function decryptJson(key, packedText, aad) {
  const packed = base64UrlToBytes(packedText);
  if (packed.length < 12 + 16) throw new Error("Couldn't open this note.");
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: textEncoder.encode(aad) },
    key,
    ciphertext,
  );
  return JSON.parse(textDecoder.decode(plain));
}
