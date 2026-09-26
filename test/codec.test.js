import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decodeSave,
  encodeSave,
  parseJson,
  stringifyJson,
  makeNumeric,
} from "../src/codec.js";

// Synthetic records written by Godot 4.7.1 FileAccess.open_encrypted_with_pass,
// using the recovered SaveLoad.gd compression/encryption pipeline. No player data.
test("opens an independently Godot-generated encrypted save", async () => {
  const bytes = new Uint8Array(
    await readFile(new URL("./fixtures/godot4.save", import.meta.url)),
  );
  const lines = await readFile(
    new URL("./fixtures/godot4.jsonl", import.meta.url),
    "utf8",
  );
  const decoded = await decodeSave(bytes);
  assert.equal(decoded.format, "godot4");
  assert.equal(
    stringifyJson(decoded.records),
    stringifyJson(lines.split("\n").map(parseJson)),
  );
});

test("all supported containers preserve numeric lexemes, Unicode, order, and unknown fields", async () => {
  const original =
    '[{"version":"0.85.2.2"},{"save_name":"Future","large":9007199254740993,"small":-0,"exponent":1.2300e+500,"unicode":"船 🚀 café","nested":[true,null,{"future":7}],"__proto__":{"keep":true},"constructor":"keep too"}]';
  const records = parseJson(original);
  for (const format of ["godot4", "godot3", "compressed", "base64", "plain"]) {
    const decoded = await decodeSave(await encodeSave(records, format));
    assert.equal(decoded.format, format);
    assert.equal(stringifyJson(decoded.records), original);
  }
  assert.equal({}.keep, undefined);
});

test("refuses corrupted encryption, gzip checksums, and oversized declared payloads", async () => {
  const records = [{ version: "0.85.2.2" }];
  const encrypted = await encodeSave(records);
  encrypted[4] ^= 1;
  await assert.rejects(decodeSave(encrypted), /checksum/i);
  const oversized = await encodeSave(records);
  new DataView(oversized.buffer).setUint32(24, 1, true);
  await assert.rejects(decodeSave(oversized), /length/i);
  const text = new TextDecoder().decode(
    await encodeSave(records, "compressed"),
  );
  const gzip = Buffer.from(text, "base64");
  gzip[gzip.length - 8] ^= 1;
  await assert.rejects(
    decodeSave(new TextEncoder().encode(gzip.toString("base64"))),
    /checksum/i,
  );
});

test("invalid numbers and malformed record streams never silently change data", async () => {
  for (const text of ["NaN", "Infinity", "01", "1,000", "", "1e"])
    assert.throws(() => makeNumeric(text));
  assert.throws(
    () => stringifyJson({ value: Number.MAX_SAFE_INTEGER + 1 }),
    /unsafe/i,
  );
  assert.throws(
    () => parseJson("[".repeat(300) + "0" + "]".repeat(300)),
    /nesting/i,
  );
  await assert.rejects(
    decodeSave(new TextEncoder().encode('{"save_name":"MissingVersion"}')),
    /version/i,
  );
  await assert.rejects(decodeSave(new Uint8Array()), /empty/i);
  const escaped = parseJson('{"\\u005f_proto__":{"value":2},"_other":3}');
  assert.equal(stringifyJson(escaped), '{"__proto__":{"value":2},"_other":3}');
});
