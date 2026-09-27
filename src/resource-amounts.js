import { makeNumeric, numericText } from "./codec.js";

// PlayerInfo.gd stores balances as Godot floats; NumberUtils.gd formats floats.
// One tenth of the largest finite binary64 value leaves arithmetic headroom.
export const MAX_RESOURCE_AMOUNT = "1.7976931348623157e307";

// Check integrality without rounding balances or progression through Number.
export function isIntegerText(text) {
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return false;
  const digits = match[1] + (match[2] || "");
  const places = (match[2]?.length || 0) - Number(match[3] || 0);
  if (places <= 0) return true;
  return /^0*$/.test(places >= digits.length ? digits : digits.slice(-places));
}

// Work limits, not balance caps. They bound every BigInt and decimal expansion.
const MAX_DIGITS = 4096;
const MAX_EXPONENT = 4096;
const DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/;
// Binary64 rounds this exact midpoint to Infinity, not to its largest value.
const OVERFLOW = { coefficient: (1n << 1024n) - (1n << 970n), exponent: 0 };

function parseDecimal(text, label) {
  if (typeof text !== "string")
    throw new Error(`${label} must be entered as exact numeric text.`);
  if (text.length > MAX_DIGITS + 32)
    throw new Error(`${label} exceeds the supported digit limit.`);
  const trimmed = text.trim();
  const match = DECIMAL.exec(trimmed);
  if (!match) throw new Error(`${label} must be a finite JSON number.`);
  const [, sign, integer, fraction = "", exponentSign, exponentDigits = ""] =
    match;
  if (integer.length + fraction.length > MAX_DIGITS)
    throw new Error(`${label} exceeds the supported digit limit.`);
  let exponent = 0;
  for (const digit of exponentDigits) {
    exponent = exponent * 10 + digit.charCodeAt(0) - 48;
    if (exponent > MAX_EXPONENT)
      throw new Error(`${label} exceeds the supported exponent limit.`);
  }
  if (exponentSign === "-") exponent = -exponent;
  const decimal = {
    coefficient: BigInt(`${sign}${integer}${fraction}`),
    exponent: exponent - fraction.length,
  };
  if (decimal.coefficient === 0n) decimal.exponent = 0;
  if (Math.abs(decimal.exponent) > MAX_EXPONENT)
    throw new Error(`${label} exceeds the supported decimal scale limit.`);
  requireFinite(decimal, label);
  return decimal;
}

function align(left, right) {
  const exponent = Math.min(left.exponent, right.exponent);
  return {
    left: left.coefficient * 10n ** BigInt(left.exponent - exponent),
    right: right.coefficient * 10n ** BigInt(right.exponent - exponent),
    exponent,
  };
}

function requireFinite(decimal, label) {
  const magnitude = {
    coefficient:
      decimal.coefficient < 0n ? -decimal.coefficient : decimal.coefficient,
    exponent: decimal.exponent,
  };
  const aligned = align(magnitude, OVERFLOW);
  if (aligned.left >= aligned.right)
    throw new Error(`${label} would overflow Godot's finite binary64 range.`);
}

function nonnegative(text, label) {
  const decimal = parseDecimal(text, label);
  if (decimal.coefficient < 0n)
    throw new Error(`${label} must be nonnegative.`);
  return decimal;
}

function toNumeric(coefficient, exponent) {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (digits.length > MAX_DIGITS)
    throw new Error("Result exceeds the supported digit limit.");
  const point = digits.length + exponent;
  let text;
  const expandedDigits =
    exponent >= 0 ? point : Math.max(digits.length, 1 - exponent);
  if (expandedDigits > MAX_DIGITS) text = `${digits}e${exponent}`;
  else if (exponent >= 0) text = digits + "0".repeat(exponent);
  else if (point > 0) text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  else text = `0.${"0".repeat(-point)}${digits}`;
  return makeNumeric(negative ? `-${text}` : text);
}

export function addResourceAmount(value, incrementText = "1e9") {
  const current = parseDecimal(numericText(value), "Current amount");
  const increment = nonnegative(incrementText, "Increment");
  if (increment.coefficient === 0n) return value;
  const aligned = align(current, increment);
  const result = {
    coefficient: aligned.left + aligned.right,
    exponent: aligned.exponent,
  };
  requireFinite(result, "Result");
  return toNumeric(result.coefficient, result.exponent);
}

export function fillResourceAmount(value, targetText) {
  const current = parseDecimal(numericText(value), "Current amount");
  const target = nonnegative(targetText, "Fill target");
  const aligned = align(current, target);
  return aligned.left >= aligned.right ? value : makeNumeric(targetText);
}
