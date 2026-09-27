import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson, stringifyJson, numericText } from "../src/codec.js";
import { planSpecPoints } from "../src/spec-points.js";

const catalog = JSON.parse(
  readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8"),
);
const metadata = catalog.categoryMetadata.specPoints;
function fixture() {
  const records = [
    {
      save_name: "PlayerInfo",
      ship: "BattleShip",
      resources_load: { FighterSpecPoint: 0, SynthPoint: 12 },
    },
    ...metadata.fighters.map((f) => ({
      save_name: f.saveNames[0],
      tier: 0,
      amount_have: 1,
      amount_purchased: 1,
      unlocked: true,
      compute_allocated: 7,
      progress: 3,
    })),
    ...["MasteryComputeTier", "R116ComputeTiers", "R142ComputeTiers"].map(
      (id) => ({ save_name: id, amount_have: 1, amount_purchased: 1 }),
    ),
    { save_name: "FSTurretPowerDamage", amount_have: 2, amount_purchased: 2 },
    { save_name: "FSDamageTradeOff", amount_have: 1, amount_purchased: 1 },
  ];
  for (const [id, level] of Object.entries(
    catalog.categoryMetadata.quickUpgrades.compute_base_spec_points,
  )) {
    const source = metadata.contributions.find((entry) => entry.id === id);
    records.push({
      save_name: source.saveNames[0],
      amount_have: level,
      amount_purchased: level,
      unlocked: true,
    });
  }
  return parseJson(JSON.stringify(records));
}
function apply(records, plan) {
  for (const { path, value } of plan.changes) {
    const parent = path
      .slice(0, -1)
      .reduce((entry, key) => entry[key], records);
    parent[path.at(-1)] = value;
  }
}

test("funding survives earned-minus-spent reconciliation without counting pending fleet bonuses", () => {
  const records = fixture();
  const fleet = metadata.contributions.find(
    (entry) =>
      entry.pendingField &&
      entry.effects.some(
        (effect) => effect.stat === "compute_base_spec_points",
      ),
  );
  records.push(
    parseJson(
      JSON.stringify({
        save_name: fleet.saveNames[0],
        amount_have: 0,
        [fleet.pendingField]: fleet.maxLevel,
      }),
    ),
  );
  const untouched = stringifyJson(records.slice(7));
  const plan = planSpecPoints(records, catalog);
  apply(records, plan);
  const tiers = records
    .slice(1, 7)
    .reduce((sum, record) => sum + Number(numericText(record.tier)), 0);
  // Base 1 + six starting grants = 16; the three source reductions make divisor 3.
  const earned = Math.floor(tiers / 3) + 16;
  assert.equal(earned, 255);
  assert.equal(
    numericText(records[0].resources_load.FighterSpecPoint),
    String(earned - (1 + 2) - 2),
  );
  assert.equal(stringifyJson(records.slice(7)), untouched);
  for (const record of records.slice(1, 7)) {
    assert.equal(numericText(record.compute_allocated), "7");
    assert.equal(numericText(record.progress), "3");
  }
  assert.deepEqual(planSpecPoints(records, catalog).changes, []);
});

test("infeasible compute costs and Titan conversion reject funding atomically", () => {
  const early = fixture().filter(
    (record) =>
      record.save_name === "PlayerInfo" ||
      metadata.fighters.some((f) => f.saveNames.includes(record.save_name)),
  );
  const before = stringifyJson(early);
  assert.throws(() => planSpecPoints(early, catalog), /safely reach/);
  assert.equal(stringifyJson(early), before);
  const titan = fixture();
  titan[0].ship = "Titan";
  const titanBefore = stringifyJson(titan);
  assert.throws(() => planSpecPoints(titan, catalog), /Titan/);
  assert.equal(stringifyJson(titan), titanBefore);
});
