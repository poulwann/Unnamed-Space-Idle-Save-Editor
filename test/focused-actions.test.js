import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson, stringifyJson, numericText } from "../src/codec.js";
import { planUpgradeMaximum } from "../src/focused-actions.js";

const catalog = JSON.parse(
  readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8"),
);
function apply(records, plan) {
  for (const { path, value } of plan.changes) {
    const parent = path
      .slice(0, -1)
      .reduce((entry, key) => entry[key], records);
    parent[path.at(-1)] = value;
  }
}

test("spec bonus actions resolve old scene names without boosting compute speed or buying specs", () => {
  const records = parseJson(
    '[{"save_name":"WarpComputeSpeedCapital2","amount_have":0,"amount_purchased":0,"unlocked":true},{"save_name":"WarpComputeTierScaling2","amount_have":0,"amount_purchased":0,"unlocked":false},{"save_name":"SynthSynthSpeed","amount_have":1,"amount_purchased":1,"unlocked":true},{"save_name":"FSTurretPowerDamage","amount_have":2,"amount_purchased":2},{"save_name":"PlayerInfo","resources_load":{"FighterSpecPoint":4,"SynthPoint":20}}]',
  );
  const unrelated = stringifyJson(records.slice(1));
  apply(
    records,
    planUpgradeMaximum(
      records,
      catalog,
      catalog.categoryMetadata.quickUpgrades.compute_base_spec_points,
    ),
  );
  // WarpComputeSpeedCapital2 is the saved name of the +1-per-level spec grant.
  // At its source cap it adds two earned points, not compute-speed levels.
  const earned = 1 + Number(numericText(records[0].amount_have));
  assert.equal(earned, 3);
  assert.equal(numericText(records[0].amount_purchased), "2");
  assert.equal(stringifyJson(records.slice(1)), unrelated);
  assert.deepEqual(
    planUpgradeMaximum(
      records,
      catalog,
      catalog.categoryMetadata.quickUpgrades.compute_base_spec_points,
    ).changes,
    [],
  );
});

test("a bad later upgrade aborts the entire action without partial mutations", () => {
  for (const bad of ["1.0000000000000000001", "1e307", "-1"]) {
    const records = parseJson(
      `[{"save_name":"SynthSynthSpeed","amount_have":0,"amount_purchased":0,"unlocked":true},{"save_name":"SynthSynthSpeed2","amount_have":${bad},"amount_purchased":0,"unlocked":true}]`,
    );
    const before = stringifyJson(records);
    assert.throws(() =>
      planUpgradeMaximum(
        records,
        catalog,
        catalog.categoryMetadata.quickUpgrades.synth_speed,
      ),
    );
    assert.equal(stringifyJson(records), before);
  }
});
