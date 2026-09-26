import test from "node:test";
import assert from "node:assert/strict";
import { makeNumeric, numericText, stringifyJson } from "../src/codec.js";
import {
  addResourceAmount,
  fillResourceAmount,
} from "../src/resource-amounts.js";

test("addition retains large integer digits and fractional tails across scientific notation", () => {
  const original = makeNumeric("9007199254740993.000000000000000001");
  const result = addResourceAmount(original, "2.5e-1");
  assert.equal(
    stringifyJson({ amount: result }),
    '{"amount":9007199254740993.250000000000000001}',
  );
  assert.equal(numericText(original), "9007199254740993.000000000000000001");
  assert.equal(
    numericText(addResourceAmount(makeNumeric("-1.25e1"), "12.75")),
    "0.25",
  );
  assert.equal(
    numericText(addResourceAmount(9007199254740993n)),
    "9007200254740993",
  );
  assert.equal(numericText(addResourceAmount(0.1, "0.2")), "0.3");
});

test("fill is an exact lower bound and unchanged actions retain the original numeric lexeme", () => {
  const original = makeNumeric("9.007199254740993000e15");
  assert.strictEqual(
    fillResourceAmount(original, "9007199254740992.999999999"),
    original,
  );
  assert.strictEqual(
    fillResourceAmount(original, "9007199254740993"),
    original,
  );
  assert.strictEqual(addResourceAmount(original, "-0.000e+10"), original);
  assert.equal(
    numericText(fillResourceAmount(original, "9007199254740993.000000001")),
    "9007199254740993.000000001",
  );
  assert.equal(
    numericText(fillResourceAmount(makeNumeric("-0.001"), "0")),
    "0",
  );
  const negativeZero = makeNumeric("-0.00e+4");
  assert.strictEqual(fillResourceAmount(negativeZero, "0"), negativeZero);
});

test("the exact binary64 overflow midpoint is rejected without rounding finite results", () => {
  const largest = (1n << 1024n) - (1n << 971n);
  const halfUlp = 1n << 970n;
  const original = makeNumeric(largest.toString());
  assert.equal(
    numericText(addResourceAmount(original, (halfUlp - 1n).toString())),
    (largest + halfUlp - 1n).toString(),
  );
  assert.throws(
    () => addResourceAmount(original, halfUlp.toString()),
    /overflow/i,
  );
  assert.equal(
    numericText(addResourceAmount(original, "0.01")),
    `${largest}.01`,
  );
  assert.throws(
    () => fillResourceAmount(original, (largest + halfUlp).toString()),
    /overflow/i,
  );
  assert.throws(
    () => addResourceAmount(makeNumeric("-1e309"), "1"),
    /overflow/i,
  );
});

test("invalid, negative, nonfinite, and pathological operands fail before returning a replacement", () => {
  const original = makeNumeric("12");
  for (const text of [
    "-1",
    "Infinity",
    "NaN",
    "1e309",
    "1e999999999",
    "1e-4097",
    "1".repeat(4097),
  ]) {
    assert.throws(() => addResourceAmount(original, text));
    assert.throws(() => fillResourceAmount(original, text));
  }
  assert.throws(() => addResourceAmount("12", "1"));
  assert.throws(() => addResourceAmount(Infinity, "1"));
  assert.throws(() => fillResourceAmount(original, 100));
  assert.throws(
    () => addResourceAmount(Number.MAX_SAFE_INTEGER + 1, "1"),
    /unsafe/i,
  );
  assert.equal(numericText(original), "12");
});

test("bounded tiny exact results remain usable by subsequent amount actions", () => {
  const tiny = addResourceAmount(makeNumeric("0"), "1e-4096");
  assert.equal(numericText(tiny), "1e-4096");
  const doubled = addResourceAmount(tiny, "1e-4096");
  assert.equal(numericText(doubled), "2e-4096");
  assert.strictEqual(fillResourceAmount(doubled, "1e-4096"), doubled);
});
