import { isNumeric, numericText } from "./codec.js";

// Include the decade below 1e305 so nearby values are repaired too.
export const OVERFLOW_REPAIR_EXPONENT = 304;

export function planOverflowRepairs(records) {
  const paths = [];
  const path = [];
  function visit(value) {
    if (isNumeric(value)) {
      const [, integer, fraction = "", exponent = "0"] =
        /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(numericText(value));
      const integerStart = integer.search(/[1-9]/);
      const fractionStart = fraction.search(/[1-9]/);
      if (integerStart < 0 && fractionStart < 0) return;
      // Convert only the exponent, never the balance. Even an exponent too
      // large for Number still compares correctly as +/-Infinity here.
      const magnitude =
        Number(exponent) +
        (integerStart >= 0
          ? integer.length - integerStart - 1
          : -fractionStart - 1);
      if (magnitude >= OVERFLOW_REPAIR_EXPONENT) paths.push([...path]);
    } else if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          path.push(i);
          visit(value[i]);
          path.pop();
        }
      } else {
        for (const key of Object.keys(value)) {
          path.push(key);
          visit(value[key]);
          path.pop();
        }
      }
    }
  }
  visit(records);
  return paths;
}
