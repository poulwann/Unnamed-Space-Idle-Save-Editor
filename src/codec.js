import CryptoJS from "crypto-js";
import { gzipSync, Inflate } from "fflate";
import { LosslessNumber, parse, stringify } from "lossless-json";

// FileAccessEncrypted layouts: Godot 4 uses CFB + IV, Godot 3 uses ECB + mode.
// https://github.com/godotengine/godot/blob/4.4/core/io/file_access_encrypted.cpp
// https://github.com/godotengine/godot/blob/3.5/core/io/file_access_encrypted.cpp
const MAGIC = 0x43454447;
const MAX_CONTAINER = 96 * 1024 * 1024;
const MAX_DECODED = 64 * 1024 * 1024;
const MAX_DEPTH = 256;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const utf8 = new TextEncoder();
const passwordKey = CryptoJS.enc.Utf8.parse(CryptoJS.MD5("usig23").toString());
const formats = new Set(["godot4", "godot3", "compressed", "base64", "plain"]);

export function isNumeric(value) {
  return (
    value instanceof LosslessNumber ||
    typeof value === "number" ||
    typeof value === "bigint"
  );
}

export function numericText(value) {
  if (value instanceof LosslessNumber) {
    if (!NUMBER.test(value.value))
      throw new Error("Invalid lossless JSON number.");
    return value.value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a finite JSON number.");
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(
      "Unsafe JavaScript integer: enter the exact digits as text instead.",
    );
  }
  return Object.is(value, -0) ? "-0" : String(value);
}

export function makeNumeric(text) {
  if (typeof text !== "string")
    throw new Error("Enter numbers as text to preserve every digit.");
  const value = text.trim();
  if (!NUMBER.test(value)) {
    throw new Error(
      "Enter a JSON number, for example -12, 0.25 or 1.23e+100 (no commas, leading zeros, NaN or Infinity).",
    );
  }
  return new LosslessNumber(value);
}

// Prefix keys only when needed to avoid the parser's __proto__ setter. The
// prefix is applied to every key, so even escaped keys cannot collide.
function prepareJson(text, prefixKeys) {
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const opening = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      if (prefixKeys) {
        let next = i + 1;
        while (next < text.length && /[\t\n\r ]/.test(text[next])) next++;
        if (text[next] === ":") {
          parts.push(text.slice(start, opening + 1), "_");
          start = opening + 1;
        }
      }
    } else if (text[i] === "{" || text[i] === "[") {
      if (++depth > MAX_DEPTH)
        throw new Error(`JSON nesting exceeds ${MAX_DEPTH} levels.`);
    } else if (text[i] === "}" || text[i] === "]") {
      depth--;
    }
  }
  if (!prefixKeys) return text;
  parts.push(text.slice(start));
  return parts.join("");
}

function restoreKeys(value) {
  if (!value || typeof value !== "object" || value instanceof LosslessNumber)
    return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = restoreKeys(value[i]);
    return value;
  }
  // A new object avoids collisions between a restored key and an unrestored key.
  const restored = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(restored, key.slice(1), {
      value: restoreKeys(child),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return restored;
}

export function parseJson(text) {
  if (typeof text !== "string") throw new Error("JSON input must be text.");
  if (text.length > MAX_DECODED)
    throw new Error("JSON exceeds the 64 MiB safety limit.");
  const prefixKeys = text.includes("__proto__") || text.includes("\\u");
  const value = parse(prepareJson(text, prefixKeys), undefined, makeNumeric);
  return prefixKeys ? restoreKeys(value) : value;
}

export function stringifyJson(value, space) {
  const indent =
    typeof space === "number"
      ? " ".repeat(Math.max(0, Math.min(10, Math.trunc(space) || 0)))
      : typeof space === "string"
        ? space.slice(0, 10)
        : "";
  if (/[^\t\n\r ]/.test(indent))
    throw new Error("JSON indentation must contain only whitespace.");
  const ancestors = new Set();
  function visit(item, depth) {
    if (depth > MAX_DEPTH)
      throw new Error(`JSON nesting exceeds ${MAX_DEPTH} levels.`);
    if (isNumeric(item)) return numericText(item);
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return stringify(item);
    if (!item || typeof item !== "object")
      throw new Error("Save data contains a value that JSON cannot represent.");
    if (ancestors.has(item))
      throw new Error("Save data contains a circular reference.");
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new Error(
        "Save data must contain only JSON objects, arrays and primitive values.",
      );
    }
    ancestors.add(item);
    const entries = [];
    if (array) {
      for (let i = 0; i < item.length; i++)
        entries.push(visit(item[i], depth + 1));
    } else {
      for (const key of Object.keys(item)) {
        entries.push(
          `${stringify(key)}:${indent ? " " : ""}${visit(item[key], depth + 1)}`,
        );
      }
    }
    ancestors.delete(item);
    const open = array ? "[" : "{";
    const close = array ? "]" : "}";
    if (!entries.length) return open + close;
    return indent
      ? `${open}\n${indent.repeat(depth + 1)}${entries.join(`,\n${indent.repeat(depth + 1)}`)}\n${indent.repeat(depth)}${close}`
      : open + entries.join(",") + close;
  }
  const result = visit(value, 0);
  if (result.length > MAX_DECODED)
    throw new Error("JSON exceeds the 64 MiB safety limit.");
  return result;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function words(bytes) {
  return CryptoJS.lib.WordArray.create(bytes);
}

function bytesFromWords(value) {
  const result = new Uint8Array(value.sigBytes);
  for (let i = 0; i < result.length; i++)
    result[i] = (value.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255;
  return result;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Save contains invalid UTF-8 text.");
  }
}

function aligned(length, size) {
  return Math.ceil(length / size) * size;
}

function checkRecords(records) {
  if (!Array.isArray(records) || records.length === 0)
    throw new Error("Save must contain JSON records.");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      isNumeric(record)
    ) {
      throw new Error(`Save record ${i + 1} must be a JSON object.`);
    }
  }
  if (
    !Object.hasOwn(records[0], "version") ||
    typeof records[0].version !== "string" ||
    !records[0].version.trim()
  ) {
    throw new Error(
      "The first save record must contain a nonempty version string.",
    );
  }
}

function decodeRecords(text) {
  if (text.length > MAX_DECODED)
    throw new Error("Save text exceeds the 64 MiB safety limit.");
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const records = lines.map((line, index) => {
    if (!line.trim()) throw new Error(`Save record ${index + 1} is empty.`);
    try {
      return parseJson(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON in save record ${index + 1}: ${error.message}`,
      );
    }
  });
  checkRecords(records);
  return records;
}

function decodeBase64(text) {
  const compact = text.replace(/[\t\n\r ]/g, "");
  if (
    !compact.length ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    (compact.includes("=") && compact.length % 4 !== 0)
  ) {
    throw new Error("Save is neither a JSON record stream nor valid base64.");
  }
  try {
    const binary = atob(compact);
    // Reject noncanonical unused bits instead of silently changing corrupt data.
    if (btoa(binary).replace(/=+$/, "") !== compact.replace(/=+$/, ""))
      throw new Error("Invalid padding");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error("Save contains invalid base64 data or padding.");
  }
}

function encodeBase64(bytes) {
  const parts = [];
  // Divisible by three: all chunks except the final chunk have no base64 padding.
  for (let i = 0; i < bytes.length; i += 24576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))));
  }
  return parts.join("");
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function updateCrc(crc, bytes) {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return crc;
}

function inflateGzip(bytes) {
  if (
    bytes.length < 18 ||
    bytes[0] !== 31 ||
    bytes[1] !== 139 ||
    bytes[2] !== 8 ||
    bytes[3] & 0xe0
  ) {
    throw new Error("Invalid gzip save header.");
  }
  const data = view(bytes);
  const footer = bytes.length - 8;
  const expectedSize = data.getUint32(footer + 4, true);
  if (expectedSize > MAX_DECODED)
    throw new Error("Decompressed save exceeds the 64 MiB safety limit.");
  let start = 10;
  const flags = bytes[3];
  if (flags & 4) {
    if (start + 2 > footer) throw new Error("Truncated gzip extra field.");
    start += 2 + data.getUint16(start, true);
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (start < footer && bytes[start] !== 0) start++;
      if (start >= footer) throw new Error("Truncated gzip text header.");
      start++;
    }
  }
  if (flags & 2) {
    if (
      start + 2 > footer ||
      ((updateCrc(-1, bytes.subarray(0, start)) ^ -1) & 0xffff) !==
        data.getUint16(start, true)
    ) {
      throw new Error("Gzip header checksum mismatch.");
    }
    start += 2;
  }
  if (start >= footer) throw new Error("Truncated gzip save data.");
  let length = 0;
  let crc = -1;
  const chunks = [];
  // fflate's synchronous gunzip trusts ISIZE and skips CRC verification. Stream
  // small compressed chunks instead, bounding expansion before retaining output.
  const inflater = new Inflate((chunk) => {
    length += chunk.length;
    if (length > MAX_DECODED || length > expectedSize)
      throw new Error(
        "Decompressed save exceeds its declared size or the 64 MiB safety limit.",
      );
    crc = updateCrc(crc, chunk);
    chunks.push(chunk);
  });
  try {
    for (let offset = start; offset < footer; offset += 4096) {
      const end = Math.min(offset + 4096, footer);
      inflater.push(bytes.subarray(offset, end), end === footer);
    }
  } catch (error) {
    throw new Error(`Cannot decompress save: ${error.message}`);
  }
  if (length !== expectedSize)
    throw new Error("Gzip length mismatch: the save is truncated or corrupt.");
  if ((crc ^ -1) >>> 0 !== data.getUint32(footer, true))
    throw new Error("Gzip checksum mismatch: the save is corrupt.");
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function decodeVariant(bytes) {
  if (bytes.length < 8) throw new Error("Truncated Godot string variant.");
  const data = view(bytes);
  if (data.getUint32(0, true) !== 4)
    throw new Error("Compressed save does not contain a Godot string variant.");
  const length = data.getUint32(4, true);
  if (length > MAX_DECODED - 8 || bytes.length !== 8 + aligned(length, 4)) {
    throw new Error("Invalid Godot string variant length.");
  }
  for (let i = 8 + length; i < bytes.length; i++) {
    if (bytes[i] !== 0)
      throw new Error("Invalid Godot string variant padding.");
  }
  return decodeUtf8(bytes.subarray(8, 8 + length));
}

function encodeVariant(bytes) {
  const length = 8 + aligned(bytes.length, 4);
  if (length > MAX_DECODED)
    throw new Error("Godot string variant exceeds the 64 MiB safety limit.");
  const result = new Uint8Array(length);
  view(result).setUint32(0, 4, true);
  view(result).setUint32(4, bytes.length, true);
  result.set(bytes, 8);
  return result;
}

function decodeTextContainer(bytes) {
  const text = decodeUtf8(bytes).trim();
  if (text.startsWith("{"))
    return { records: decodeRecords(text), format: "plain" };
  const decoded = decodeBase64(text);
  if (decoded[0] === 31 && decoded[1] === 139) {
    return {
      records: decodeRecords(decodeVariant(inflateGzip(decoded))),
      format: "compressed",
    };
  }
  return { records: decodeRecords(decodeUtf8(decoded)), format: "base64" };
}

function decrypt(bytes, format) {
  const legacy = format === "godot3";
  const headerLength = legacy ? 32 : 44;
  if (bytes.length < headerLength)
    throw new Error(`Truncated ${format} encrypted header.`);
  const data = view(bytes);
  const lengthOffset = legacy ? 24 : 20;
  const length = data.getUint32(lengthOffset, true);
  if (data.getUint32(lengthOffset + 4, true) !== 0 || length > MAX_CONTAINER) {
    throw new Error(
      "Encrypted save declares an excessive length (96 MiB limit).",
    );
  }
  if (bytes.length !== headerLength + aligned(length, 16))
    throw new Error(
      "Encrypted save length is invalid or the file is truncated.",
    );
  const decrypted = bytesFromWords(
    CryptoJS.AES.decrypt(
      CryptoJS.lib.CipherParams.create({
        ciphertext: words(bytes.subarray(headerLength)),
      }),
      passwordKey,
      {
        mode: legacy ? CryptoJS.mode.ECB : CryptoJS.mode.CFB,
        padding: CryptoJS.pad.NoPadding,
        ...(legacy ? {} : { iv: words(bytes.subarray(28, 44)) }),
      },
    ),
  );
  const payload = decrypted.subarray(0, length);
  const checksumOffset = legacy ? 8 : 4;
  const expected = words(
    bytes.subarray(checksumOffset, checksumOffset + 16),
  ).toString();
  if (CryptoJS.MD5(words(payload)).toString() !== expected) {
    throw new Error(
      "Encrypted save MD5 checksum mismatch: the file is corrupt or uses a different password.",
    );
  }
  for (let i = length; i < decrypted.length; i++) {
    if (decrypted[i] !== 0)
      throw new Error("Encrypted save has corrupt zero padding.");
  }
  return payload;
}

function encrypt(payload, format) {
  const legacy = format === "godot3";
  const headerLength = legacy ? 32 : 44;
  const result = new Uint8Array(headerLength + aligned(payload.length, 16));
  const data = view(result);
  data.setUint32(0, MAGIC, true);
  if (legacy) data.setUint32(4, 1, true);
  result.set(bytesFromWords(CryptoJS.MD5(words(payload))), legacy ? 8 : 4);
  data.setUint32(legacy ? 24 : 20, payload.length, true);
  const iv = legacy
    ? undefined
    : globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (iv) result.set(iv, 28);
  const padded = new Uint8Array(aligned(payload.length, 16));
  padded.set(payload);
  const ciphertext = CryptoJS.AES.encrypt(words(padded), passwordKey, {
    mode: legacy ? CryptoJS.mode.ECB : CryptoJS.mode.CFB,
    padding: CryptoJS.pad.NoPadding,
    ...(iv ? { iv: words(iv) } : {}),
  }).ciphertext;
  result.set(bytesFromWords(ciphertext), headerLength);
  return result;
}

export async function decodeSave(bytes) {
  if (!(bytes instanceof Uint8Array))
    throw new Error("Save input must be a Uint8Array.");
  if (!bytes.length) throw new Error("The save file is empty.");
  if (bytes.length > MAX_CONTAINER)
    throw new Error("Save file exceeds the 96 MiB safety limit.");
  if (bytes.length >= 4 && view(bytes).getUint32(0, true) === MAGIC) {
    // Header widths differ modulo 16; do not mistake random MD5 bytes for mode 1.
    const legacy =
      bytes.length >= 32 &&
      bytes.length % 16 === 0 &&
      view(bytes).getUint32(4, true) === 1;
    const format = legacy ? "godot3" : "godot4";
    return {
      records: decodeTextContainer(decrypt(bytes, format)).records,
      format,
    };
  }
  return decodeTextContainer(bytes);
}

export async function encodeSave(records, format = "godot4") {
  if (!formats.has(format))
    throw new Error(`Unsupported save format: ${format}`);
  checkRecords(records);
  const text = records.map((record) => stringifyJson(record)).join("\n");
  if (text.length > MAX_DECODED)
    throw new Error("Save text exceeds the 64 MiB safety limit.");
  const plain = utf8.encode(text);
  if (plain.length > MAX_DECODED)
    throw new Error("UTF-8 save text exceeds the 64 MiB safety limit.");
  if (format === "plain") return plain;
  if (format === "base64") return utf8.encode(encodeBase64(plain));
  const exported = utf8.encode(encodeBase64(gzipSync(encodeVariant(plain))));
  if (format === "compressed") return exported;
  return encrypt(exported, format);
}
