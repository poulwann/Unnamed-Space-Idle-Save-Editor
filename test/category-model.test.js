import test from "node:test";
import assert from "node:assert/strict";
import {
  isNumeric,
  makeNumeric,
  numericText,
  stringifyJson,
} from "../src/codec.js";
import {
  buildCategoryEntries,
  collectActionFields,
  getFieldPolicy,
  planFieldAction,
} from "../src/category-model.js";

const number = makeNumeric;
const catalog = {
  labels: {},
  resources: [],
  achievements: [],
  categoryMetadata: {
    records: {
      ResearchA: {
        category: "Research",
        group: "Applied",
        source: "interface/research/LevelBasedResearchUpgrade.gd",
      },
      FleetA: {
        category: "Fleet",
        group: "Galaxy A",
        source: "fleet/interface/FleetEvent.gd",
      },
    },
    achievements: { AchievementA: { group: "Exploration", tier: 1 } },
    entities: {
      recipes: {
        a: { name: "Recipe A", maxLevel: 5 },
        b: { name: "Recipe B", maxLevel: 10 },
        unknown: { maxLevel: 0 },
      },
      modules: {
        a: { name: "Module A", maxTier: 2, levelsByTier: { 1: 10, 2: 20 } },
        b: { name: "Module B", maxTier: 2, levelsByTier: { 1: 10, 2: 5 } },
      },
      crew: { first: { name: "First officer" }, second: { name: "Engineer" } },
      crewSkills: { piloting: { name: "Piloting" } },
      crewUpgrades: { improve: { name: "Improvement", maxLevel: 3 } },
      research: {
        ResearchA: { name: "Research A", method: "Level", maxLevel: 4 },
      },
      fleet: { FleetA: { name: "Fleet event", maxContributionLevel: 2 } },
    },
  },
};
const classify = (record) =>
  ({
    Recipes: "Inventory",
    Modules: "Inventory",
    VoidDeviceArea: "Inventory",
    PlayerInfo: "Resources",
    Crew: "Crew",
    Themes: "Settings",
    AchievementA: "Achievements",
    ResearchA: "Research",
    FleetA: "Fleet",
  })[record.save_name] || "Other";
const fieldAt = (records, path) => ({
  path,
  label: path.at(-1),
  policy: getFieldPolicy(records, catalog, path),
});

function leafPaths(value, path, omitFields = []) {
  if (
    value === null ||
    typeof value !== "object" ||
    isNumeric(value) ||
    Object.keys(value).length === 0
  ) {
    return [JSON.stringify(path)];
  }
  return Object.keys(value)
    .filter((key) => !omitFields.includes(key))
    .flatMap((key) =>
      leafPaths(value[key], [
        ...path,
        Array.isArray(value) ? Number(key) : key,
      ]),
    );
}

function resolve(records, path) {
  return path.reduce((value, key) => value[key], records);
}

test("category entries retain exactly every editable leaf, including future data and empty collections", () => {
  const records = [
    { version: number("1"), timestamp: number("123") },
    {
      save_name: "Recipes",
      recipes_load: {
        a: { level: number("2"), future: { nested: [null, {}] } },
        b: null,
      },
      unknown: [],
    },
    { save_name: "Modules", modules_load: {} },
    {
      save_name: "VoidDeviceArea",
      inventory_data: {
        Slot1: null,
        Slot2: { name: "FutureShard", resonance: number("1.25") },
      },
      harmony_data: {},
      unknown: { x: false },
    },
    {
      save_name: "PlayerInfo",
      cores_info_load: { laser: { tier: number("1"), locked: true } },
      ships_load: { starter: { locked: false } },
      cores: [{ core_id: "laser", future: [] }],
      resources_load: {},
      total_time: number("100"),
    },
    {
      save_name: "Crew",
      crew_load: {
        first: {
          rank: number("3"),
          stats: {
            piloting: { level: number("4"), xp: number("1.5"), future: {} },
          },
          upgrades: { improve: { level: number("1") } },
          unknown: { kept: null },
        },
        second: { stats: {}, upgrades: [] },
      },
    },
    {
      save_name: "Themes",
      skins_load_owned: { default: true },
      themes_load_owned: {},
    },
    {
      save_name: "ResearchA",
      amount_have: number("1"),
      resources_in: number("0.5"),
    },
    {
      save_name: "FleetA",
      finished_first_time: false,
      contribution_upgrade_level_load: number("1"),
    },
    { save_name: "AchievementA", amount_have: number("0") },
    {
      save_name: "Unrecognized99",
      future: [{ id: number("8"), enabled: true }],
    },
  ];
  const entries = buildCategoryEntries(records, catalog, classify);
  const actual = entries.flatMap((entry) =>
    leafPaths(resolve(records, entry.path), entry.path, entry.omitFields),
  );
  assert.deepEqual(actual.sort(), leafPaths(records, []).sort());
  assert.deepEqual(
    [...new Set(entries.map((entry) => entry.category))].sort(),
    [
      "Achievements",
      "Inventory",
      "Progression",
      "Crew",
      "Fleet",
      "Research",
      "Settings",
      "Other",
    ].sort(),
  );
  const skill = entries.find(
    (entry) => entry.path.join("/") === "5/crew_load/first/stats/piloting",
  );
  assert.equal(skill.group, "First officer");
  assert.equal(skill.subgroup, "Skills");
});

test("mixed recipe caps clamp additions without decreasing higher values or treating zero as a maximum", () => {
  const records = [
    {
      save_name: "Recipes",
      recipes_load: {
        a: { level: number("4") },
        b: { level: number("12") },
        unknown: { level: number("3") },
      },
    },
  ];
  const fields = ["a", "b", "unknown"].map((id) =>
    fieldAt(records, [0, "recipes_load", id, "level"]),
  );
  const original = stringifyJson(records);
  const changes = planFieldAction(records, fields, "add", "3");
  assert.deepEqual(
    changes.map(({ path, value }) => [path[2], numericText(value)]),
    [
      ["a", "5"],
      ["unknown", "6"],
    ],
  );
  assert.equal(stringifyJson(records), original);
  assert.throws(() => planFieldAction(records, fields, "max"), /maximum/);
  assert.throws(
    () => planFieldAction(records, fields, "fill", "2.5"),
    /whole-number/,
  );
  assert.equal(stringifyJson(records), original);
  assert.deepEqual(
    planFieldAction(records, [fields[0]], "add", "1e308").map(({ value }) =>
      numericText(value),
    ),
    ["5"],
  );
});

test("module tier conflicts reject the complete group and stale level policies use the current tier", () => {
  const records = [
    {
      save_name: "Modules",
      modules_load: {
        a: { tier: number("1"), level: number("8") },
        b: { tier: number("1"), level: number("8") },
      },
    },
  ];
  const tierFields = ["a", "b"].map((id) =>
    fieldAt(records, [0, "modules_load", id, "tier"]),
  );
  const original = stringifyJson(records);
  assert.throws(
    () => planFieldAction(records, tierFields, "max"),
    /Module B.*level 8.*maximum 5/,
  );
  assert.equal(stringifyJson(records), original);
  const levelField = fieldAt(records, [0, "modules_load", "b", "level"]);
  records[0].modules_load.b.level = number("2");
  records[0].modules_load.b.tier = number("2");
  const changes = planFieldAction(records, [levelField], "add", "100");
  assert.equal(numericText(changes[0].value), "5");
  assert.equal(numericText(records[0].modules_load.b.level), "2");
});

test("crew experience keeps exact fractional tails while integer progression never rounds", () => {
  const records = [
    {
      save_name: "Crew",
      crew_load: {
        first: {
          rank: number("2.5"),
          stats: {
            piloting: {
              level: number("2"),
              xp: number("9007199254740993.000000000000000001"),
              xp_needed: number("100"),
              levels_this_run: number("1.25"),
            },
          },
          upgrades: {},
        },
      },
    },
  ];
  const xp = fieldAt(records, [
    0,
    "crew_load",
    "first",
    "stats",
    "piloting",
    "xp",
  ]);
  const changes = planFieldAction(records, [xp], "add", "0.25");
  assert.equal(
    numericText(changes[0].value),
    "9007199254740993.250000000000000001",
  );
  assert.equal(
    getFieldPolicy(records, catalog, [
      0,
      "crew_load",
      "first",
      "stats",
      "piloting",
      "xp_needed",
    ]),
    null,
  );
  const level = fieldAt(records, [
    0,
    "crew_load",
    "first",
    "stats",
    "piloting",
    "level",
  ]);
  assert.throws(
    () => planFieldAction(records, [level], "add", "1e-1"),
    /whole-number/,
  );
  const rank = fieldAt(records, [0, "crew_load", "first", "rank"]);
  const original = stringifyJson(records);
  assert.throws(
    () => planFieldAction(records, [xp, rank], "fill", "10"),
    /fractional/,
  );
  assert.equal(stringifyJson(records), original);
});

test("explicit boolean actions cannot include numeric IDs, timestamps, costs, or incompatible fields", () => {
  const records = [
    {
      save_name: "FleetA",
      finished_first_time: false,
      rewards_given: false,
      contribution_upgrade_level_load: number("1"),
      timestamp: number("10"),
      id: number("7"),
      costs: { amount: number("99") },
    },
    { save_name: "Themes", skins_load_owned: { default: false } },
  ];
  const entry = buildCategoryEntries(records, catalog, classify).find(
    (candidate) => candidate.path[0] === 0,
  );
  const fields = collectActionFields(records, catalog, entry);
  const flag = fields.find(
    (field) => field.path.at(-1) === "finished_first_time",
  );
  const level = fields.find(
    (field) => field.path.at(-1) === "contribution_upgrade_level_load",
  );
  assert.ok(flag.policy.note);
  assert.deepEqual(planFieldAction(records, [flag], "true"), [
    { path: [0, "finished_first_time"], value: true },
  ]);
  const original = stringifyJson(records);
  assert.throws(
    () => planFieldAction(records, [flag, level], "true"),
    /does not support/,
  );
  assert.equal(stringifyJson(records), original);
  for (const path of [
    [0, "id"],
    [0, "timestamp"],
    [0, "costs", "amount"],
  ]) {
    assert.equal(getFieldPolicy(records, catalog, path), null);
  }
  const ownership = fieldAt(records, [1, "skins_load_owned", "default"]);
  assert.deepEqual(planFieldAction(records, [ownership], "true"), [
    { path: ownership.path, value: true },
  ]);
});
