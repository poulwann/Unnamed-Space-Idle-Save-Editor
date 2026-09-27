import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJson, stringifyJson, numericText } from "../src/codec.js";
import { planCrewMastery } from "../src/crew-mastery.js";

const catalog = JSON.parse(
  readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8"),
);
function apply(records, plan) {
  records[plan.playerIndex].resources_load ??= {};
  for (const { path, value } of plan.changes) {
    const parent = path
      .slice(0, -1)
      .reduce((entry, key) => entry[key], records);
    parent[path.at(-1)] = value;
  }
}

test("funding supplies the active upgrade budget and survives earned-minus-spent reconciliation", () => {
  const records = parseJson(
    '[{"save_name":"PlayerInfo","resources_load":{"MasteryPoint":1e307,"MasteryComponents":7}},{"save_name":"Crew","crew_load":{"first":{"locked":false,"mastery":2,"rank":9,"stats":{"Engineering":{"xp":123}}},"second":{"locked":false,"mastery":4},"third":{"locked":true,"mastery":1}}},{"save_name":"MasteryCompute","amount_have":1},{"save_name":"MasterySupremacy","amount_have":1},{"save_name":"MasteryResource2","amount_have":1}]',
  );
  const before = stringifyJson(records);
  const plan = planCrewMastery(records, catalog);
  assert.equal(
    stringifyJson(records),
    before,
    "Planning must not mutate the save",
  );
  apply(records, plan);
  const crew = records[1].crew_load;
  const total = Object.values(crew).reduce(
    (sum, member) => sum + Number(numericText(member.mastery)),
    0,
  );
  // Active tiers cost 24 + 24 + 16; the unused crew_mastery_womp upgrade is excluded.
  assert.equal(total, 64);
  assert.equal(
    Number(numericText(records[0].resources_load.MasteryPoint)),
    total - 2 - 16,
  );
  assert.equal(
    numericText(crew.third.mastery),
    "1",
    "Locked crew must not gain levels",
  );
  assert.equal(numericText(crew.first.rank), "9");
  assert.equal(numericText(crew.first.stats.Engineering.xp), "123");
  assert.equal(numericText(records[0].resources_load.MasteryComponents), "7");
  assert.equal(numericText(records[2].amount_have), "1");
  assert.deepEqual(planCrewMastery(records, catalog).changes, []);
});

test("higher earned mastery is preserved and missing balances are restored consistently", () => {
  const records = parseJson(
    '[{"save_name":"PlayerInfo"},{"save_name":"Crew","crew_load":{"first":{"locked":false,"mastery":80}}},{"save_name":"MasteryCompute","amount_have":1}]',
  );
  apply(records, planCrewMastery(records, catalog));
  assert.equal(numericText(records[1].crew_load.first.mastery), "80");
  assert.equal(numericText(records[0].resources_load.MasteryPoint), "78");
});

test("missing mastery defaults to zero without inventing crew or unlocking them", () => {
  const records = parseJson(
    '[{"save_name":"PlayerInfo"},{"save_name":"Crew","crew_load":{"first":{"locked":false},"second":{"locked":true}}}]',
  );
  apply(records, planCrewMastery(records, catalog));
  assert.equal(numericText(records[1].crew_load.first.mastery), "64");
  assert.deepEqual(records[1].crew_load.second, { locked: true });
  assert.deepEqual(Object.keys(records[1].crew_load), ["first", "second"]);
  assert.equal(numericText(records[0].resources_load.MasteryPoint), "64");
});

test("invalid crew levels and absent unlocked crew fail before any mutation", () => {
  for (const member of [
    '{"locked":true,"mastery":0}',
    '{"locked":false,"mastery":1.0000000000000000001}',
    '{"locked":false,"mastery":1e307}',
  ]) {
    const records = parseJson(
      `[{"save_name":"PlayerInfo"},{"save_name":"Crew","crew_load":{"first":${member}}}]`,
    );
    const before = stringifyJson(records);
    assert.throws(() => planCrewMastery(records, catalog));
    assert.equal(stringifyJson(records), before);
  }
  assert.throws(
    () => planCrewMastery(parseJson('[{"save_name":"PlayerInfo"}]'), catalog),
    /Crew records/,
  );
});
