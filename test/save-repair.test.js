import test from "node:test";
import assert from "node:assert/strict";
import { parseJson, stringifyJson } from "../src/codec.js";
import { planOverflowRepairs } from "../src/save-repair.js";

// The planner must not pass balances through Number: this rounds up to 1e304.
test("repair distinguishes the exact cutoff from a value immediately below it", () => {
  const records = parseJson(
    `[{"below":${"9".repeat(304)},"at":1e304,"negative":-1e304,"scaled":0.01e306}]`,
  );
  assert.deepEqual(planOverflowRepairs(records), [
    [0, "at"],
    [0, "negative"],
    [0, "scaled"],
  ]);
});

test("repair finds extreme values across records and totals without mutating unrelated data", () => {
  const records = parseJson(
    '[{"save_name":"PlayerInfo","resources_load":{"Salvage":1.7976931348623157e307,"Adaptium":42},"resource_totals_gained_load":{"Salvage":1e305}},{"save_name":"UnknownFutureRecord","nested":[-1e309,1e999999999999999999999999999,"1e305",null,true,0e999999999999999999999999999,1e-999999999999999999999999999]}]',
  );
  const original = stringifyJson(records);
  assert.deepEqual(planOverflowRepairs(records), [
    [0, "resources_load", "Salvage"],
    [0, "resource_totals_gained_load", "Salvage"],
    [1, "nested", 0],
    [1, "nested", 1],
  ]);
  assert.equal(stringifyJson(records), original);
});

test("repair ignores zeros, small values, numeric strings, and null entries", () => {
  const records = parseJson(
    '[{"values":[0,-0.0,1e303,-9.99e303,0.001e306,"1e309",null,false]}]',
  );
  assert.deepEqual(planOverflowRepairs(records), []);
});
