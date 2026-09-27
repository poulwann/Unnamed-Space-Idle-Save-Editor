import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson, stringifyJson, numericText } from "../src/codec.js";
import { planNestedBoost } from "../src/nested-boosts.js";
import { planRecipeMaximum } from "../src/recipe-boosts.js";
import { planChallengeMaximum } from "../src/challenge-boosts.js";

const catalog = JSON.parse(
  readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8"),
);
function apply(records, plan) {
  if (plan.playerIndex !== undefined)
    records[plan.playerIndex].resources_load ??= {};
  for (const { path, value } of plan.changes) {
    const parent = path
      .slice(0, -1)
      .reduce((entry, key) => entry[key], records);
    parent[path.at(-1)] = value;
  }
}

test("module maxima require explicit coupled effects and use internal tier limits", () => {
  const records = parseJson(
    '[{"save_name":"Modules","modules_load":{"CombatEnhancer1":{"locked":false,"active":true,"removed":false,"tier":1,"level":1},"SynthSpeeder":{"locked":false,"active":false,"removed":false,"tier":1,"level":1}}}]',
  );
  assert.deepEqual(
    planNestedBoost(records, catalog, "damage", "module").changes,
    [],
  );
  assert.deepEqual(
    planNestedBoost(records, catalog, "synth_speed", "module").changes,
    [],
  );
  apply(records, planNestedBoost(records, catalog, "damage", "module", true));
  const combat = records[0].modules_load.CombatEnhancer1;
  assert.equal(
    numericText(combat.tier),
    "6",
    "The display start-tier offset is not part of saved tier indexing",
  );
  assert.equal(1 + 5000 * Number(numericText(combat.level)) + 10815, 60816);
  assert.equal(records[0].modules_load.SynthSpeeder.active, false);
  assert.equal(numericText(records[0].modules_load.SynthSpeeder.level), "1");
});

test("shard boosts respect slot compatibility and leave inventory and charging state untouched", () => {
  const records = parseJson(
    '[{"save_name":"VoidDeviceArea","harmony_data":{"ShardSlotRed":{"name":"synth_shard_1","resonance":2}},"inventory_data":{"0":{"name":"synth_shard_1","resonance":1}},"charging_perma_slot":""}]',
  );
  const inventory = stringifyJson(records[0].inventory_data);
  apply(records, planNestedBoost(records, catalog, "synth_speed", "shard"));
  assert.equal(
    1 +
      0.0075 *
        Number(numericText(records[0].harmony_data.ShardSlotRed.resonance)),
    1.75,
  );
  assert.equal(stringifyJson(records[0].inventory_data), inventory);
  assert.equal(records[0].charging_perma_slot, "");
  records[0].harmony_data.ShardSlotOrange = {
    ...records[0].harmony_data.ShardSlotRed,
    resonance: 2,
  };
  delete records[0].harmony_data.ShardSlotRed;
  assert.deepEqual(
    planNestedBoost(records, catalog, "synth_speed", "shard").changes,
    [],
  );
});

test("fixture funding includes reached rewards but excludes locked and alien recipes", () => {
  const alien = catalog.categoryMetadata.recipeBoosts.recipes.find(
    (row) => row.alien,
  );
  const records = parseJson(
    JSON.stringify([
      {
        save_name: "PlayerInfo",
        resources_load: { FixturePoint: 1e307, SynthPoint: 7 },
      },
      {
        save_name: "Recipes",
        recipes_load: {
          JointMaterial: { locked: false, level: 0, num_crafted_this_level: 3 },
          FlexibleRod: { locked: true, level: 20 },
          [alien.id]: { locked: false, level: 1 },
        },
      },
    ]),
  );
  const before = stringifyJson(records);
  const plan = planRecipeMaximum(records, catalog, "fixturePoints");
  assert.equal(stringifyJson(records), before);
  apply(records, plan);
  // Joint Material earns 80*1 plus reached rewards 10+20+...+80.
  assert.equal(numericText(records[0].resources_load.FixturePoint), "440");
  assert.equal(numericText(records[0].resources_load.SynthPoint), "7");
  assert.equal(numericText(records[1].recipes_load.FlexibleRod.level), "20");
  assert.equal(numericText(records[1].recipes_load[alien.id].level), "1");
  assert.equal(
    numericText(records[1].recipes_load.JointMaterial.num_crafted_this_level),
    "3",
  );
  assert.deepEqual(
    planRecipeMaximum(records, catalog, "fixturePoints").changes,
    [],
  );
});

test("challenge reward maxima preserve endless progress and reject the active selected run", () => {
  const records = parseJson(
    '[{"save_name":"PlayerInfo","on_reinforcement_run":true,"sectors_cleared_this_reinforce":["forty_a"]},{"save_name":"Challenges","challenge_active":false,"current_challenge":{}},{"save_name":"power_challenge","amount_have":1,"num_completions":1,"highest_target":9007199254740993,"locked":false}]',
  );
  const settings = stringifyJson(records.slice(0, 2));
  apply(records, planChallengeMaximum(records, catalog, "power_challenge"));
  assert.equal(100 ** Number(numericText(records[2].num_completions)), 1e10);
  assert.equal(numericText(records[2].highest_target), "9007199254740993");
  assert.equal(stringifyJson(records.slice(0, 2)), settings);
  records[1].challenge_active = true;
  records[1].current_challenge = { id: "power_challenge" };
  const before = stringifyJson(records);
  assert.throws(
    () => planChallengeMaximum(records, catalog, "power_challenge"),
    /active/,
  );
  assert.equal(stringifyJson(records), before);
});
