import assert from "node:assert/strict";
import test from "node:test";
import { decryptJson, encryptJson, generateMasterKey, parseRecoveryKeyInput } from "../public/js/crypto.js";

test("a note round-trips and is bound to its id", async () => {
  const { key, recoveryKey } = await generateMasterKey();
  const payload = { date: "2026-09-26", text: "Early pickup", tag: "Kids", important: true };
  const packed = await encryptJson(key, payload, "note-1");
  assert.deepEqual(await decryptJson(key, packed, "note-1"), payload);
  await assert.rejects(() => decryptJson(key, packed, "note-2"));
  const other = await generateMasterKey();
  await assert.rejects(() => decryptJson(other.key, packed, "note-1"));
  const raw = parseRecoveryKeyInput(recoveryKey);
  assert.equal(raw.length, 32);
});

test("recovery key paste accepts spaces and a QR link", async () => {
  const { recoveryKey } = await generateMasterKey();
  const grouped = recoveryKey.replace(/(.{4})/g, "$1 ").trim();
  assert.deepEqual(parseRecoveryKeyInput(grouped), parseRecoveryKeyInput(recoveryKey));
  const link = `https://logbook.pages.dev/#k=${recoveryKey}`;
  assert.deepEqual(parseRecoveryKeyInput(link), parseRecoveryKeyInput(recoveryKey));
  assert.throws(() => parseRecoveryKeyInput("not a key"));
});
