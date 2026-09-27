import { isNumeric, makeNumeric, numericText } from "./codec.js";
import { isIntegerText } from "./resource-amounts.js";

const MODES = ["materialCosts", "craftTime", "output", "fixturePoints"];
const SAFE_WHOLE = BigInt(Number.MAX_SAFE_INTEGER);

function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isNumeric(value)
  )
    throw new Error(`${label} must be an object.`);
  return value;
}

// Keep over-cap save levels exact, even when they exceed JavaScript's safe range.
// They are preserved, not converted back from a rounded Number.
function whole(value, label) {
  const text = numericText(value);
  const number = Number(text);
  if (
    text.length > 4096 ||
    !Number.isFinite(number) ||
    number < 0 ||
    !isIntegerText(text)
  )
    throw new Error(`${label} must be a nonnegative finite whole number.`);
  if (number === 0) return 0n;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  const digits = match[2] + (match[3] || "");
  const scale = Number(match[4] || 0) - (match[3]?.length || 0);
  return BigInt(
    scale >= 0 ? digits + "0".repeat(scale) : digits.slice(0, scale),
  );
}

function sourceWhole(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative safe source whole number.`);
  return BigInt(value);
}

function sourceFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite source number.`);
}

function validateRecipe(row) {
  object(row, "Recipe source row");
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.name !== "string" ||
    typeof row.alien !== "boolean" ||
    !Array.isArray(row.rewards) ||
    !Array.isArray(row.costs) ||
    !Array.isArray(row.modes)
  )
    throw new Error("The catalog has malformed recipe source metadata.");
  const cap = sourceWhole(row.maxLevel, `${row.id} maximum level`);
  sourceWhole(row.synthPointsPerLevel, `${row.id} synth point rate`);
  sourceWhole(row.fixturePointsPerLevel, `${row.id} fixture point rate`);
  sourceFinite(row.resultAmount, `${row.id} output`);
  const resources = new Set();
  for (const cost of row.costs) {
    object(cost, `${row.id} source cost`);
    if (typeof cost.resource !== "string" || !cost.resource)
      throw new Error(`${row.id} has an invalid cost resource.`);
    sourceFinite(cost.amount, `${row.id} source cost`);
    resources.add(cost.resource);
  }
  for (const reward of row.rewards) {
    object(reward, `${row.id} reward`);
    sourceWhole(reward.level, `${row.id} reward level`);
    sourceFinite(reward.amount, `${row.id} reward amount`);
    if (
      typeof reward.type !== "string" ||
      !reward.type ||
      typeof reward.target !== "string"
    )
      throw new Error(`${row.id} has an invalid source reward.`);
    if (reward.type === "DivideCost" && reward.amount <= 0)
      throw new Error(`${row.id} has an invalid source cost divisor.`);
    if (reward.type === "FixturePoints" || reward.type === "SynthPoints")
      sourceWhole(reward.amount, `${row.id} point reward`);
  }
  const reachable = row.rewards.filter(
    (reward) => reward.level <= row.maxLevel,
  );
  const reductions = reachable.filter(
    (reward) =>
      ["SubtractCost", "DivideCost"].includes(reward.type) &&
      resources.has(reward.target),
  );
  const supported = {
    materialCosts: reductions.some((reward) => reward.target !== "Time"),
    craftTime: reductions.some((reward) => reward.target === "Time"),
    output: reachable.some((reward) => reward.type === "IncreaseOutput"),
    fixturePoints:
      !row.alien &&
      (row.fixturePointsPerLevel > 0 ||
        reachable.some((reward) => reward.type === "FixturePoints")),
  };
  const expected = MODES.filter((mode) => supported[mode]);
  if (
    row.modes.length !== expected.length ||
    expected.some((mode) => !row.modes.includes(mode))
  )
    throw new Error(`${row.id} boost choices do not match its source rewards.`);
  return cap;
}

function rewardEffects(row, previous, target) {
  const descriptions = new Set();
  for (const reward of row.rewards) {
    const level = BigInt(reward.level);
    if (level <= previous || level > target) continue;
    const suffix = reward.target ? ` (${reward.target})` : "";
    switch (reward.type) {
      case "SynthPoints":
      case "FixturePoints":
        // These are awarded by recipe_check_level, not recipe_calc_stuff on load.
        break;
      case "Infinite":
        descriptions.add(`infinite production${suffix || ` (${row.id})`}`);
        break;
      case "AlienIntegration":
      case "AlienUpgrade":
        descriptions.add(`alien module progression: ${reward.type}${suffix}`);
        break;
      default:
        descriptions.add(`${reward.type}${suffix}`);
    }
  }
  return descriptions.size
    ? `${row.name}: reaching level ${target} also applies these coupled recipe rewards: ${[...descriptions].join(", ")}.`
    : null;
}

export function planRecipeMaximum(records, catalog, mode) {
  if (!MODES.includes(mode))
    throw new Error(`Unsupported recipe boost mode: ${mode}.`);
  if (!Array.isArray(records))
    throw new Error("Save records must be an array.");
  const metadata = object(
    catalog?.categoryMetadata?.recipeBoosts,
    "Recipe boost metadata",
  );
  if (
    metadata.saveName !== "Recipes" ||
    metadata.collection !== "recipes_load" ||
    !Array.isArray(metadata.recipes) ||
    !metadata.recipes.length ||
    !Array.isArray(metadata.modes) ||
    !metadata.modes.includes(mode)
  )
    throw new Error(
      "The catalog has no supported source-backed recipe boosts.",
    );

  const locate = (name) => {
    const indexes = [];
    records.forEach((record, index) => {
      object(record, `Save record ${index}`);
      if (record.save_name === name) indexes.push(index);
    });
    if (indexes.length > 1)
      throw new Error(`Ambiguous duplicate ${name} save records.`);
    return indexes[0] ?? -1;
  };
  const recipeIndex = locate(metadata.saveName);
  if (recipeIndex < 0) throw new Error("This save needs a Recipes record.");
  const saved = object(
    records[recipeIndex][metadata.collection],
    "Recipes.recipes_load",
  );
  const byId = new Map();
  for (const row of metadata.recipes) {
    const cap = validateRecipe(row);
    if (byId.has(row.id))
      throw new Error(`Duplicate source recipe: ${row.id}.`);
    byId.set(row.id, { row, cap });
  }

  const changes = [];
  const items = [];
  const effects = [];
  let fixturePoints = 0n;
  for (const [id, value] of Object.entries(saved)) {
    // Unknown IDs are ignored by Recipes.load_from_save and must not be granted.
    if (!byId.has(id)) continue;
    const recipe = object(value, `Saved recipe ${id}`);
    const previous = whole(recipe.level, `${id} level`);
    if (Object.hasOwn(recipe, "locked") && typeof recipe.locked !== "boolean")
      throw new Error(`${id} locked must be a boolean.`);
    const { row, cap } = byId.get(id);
    const unlocked = recipe.locked === false;
    const target =
      unlocked && row.modes.includes(mode) && previous < cap ? cap : previous;
    if (target !== previous) {
      changes.push({
        path: [recipeIndex, metadata.collection, id, "level"],
        value: makeNumeric(String(target)),
      });
      items.push({ id, name: row.name });
      const effect = rewardEffects(row, previous, target);
      if (effect) effects.push(effect);
    }
    // Exact predicates and reward sum from Recipes.set_fixture_points. Include
    // all existing unlocked non-alien contributors, not only edited recipes.
    if (
      mode === "fixturePoints" &&
      unlocked &&
      !row.alien &&
      row.fixturePointsPerLevel > 0 &&
      target > 0n
    ) {
      fixturePoints += BigInt(row.fixturePointsPerLevel) * target;
      for (const reward of row.rewards) {
        if (reward.type === "FixturePoints" && target >= BigInt(reward.level))
          fixturePoints += BigInt(reward.amount);
      }
      if (fixturePoints > SAFE_WHOLE)
        throw new Error(
          "Fixture Point reconstruction exceeds exact safe whole-number arithmetic.",
        );
    }
  }
  if (items.length) {
    effects.unshift(
      "Recipe levels are coupled: the game recalculates all reached rewards, including recipe/module unlocks, infinite production and alien module progression. No locked or missing recipe is directly changed; load-time unlock rewards may unlock other content.",
    );
    effects.push(
      "Cached recipe costs, output, craft time and next-level progress are left for game recomputation. Active challenges may suppress cost reductions or infinite production.",
    );
    effects.push(
      mode === "fixturePoints"
        ? "Only the source-derived FixturePoint balance is reconciled. SynthPoint rewards are not granted by editing levels."
        : "SynthPoint and FixturePoint balances are unchanged: recipe_check_level awards them during gameplay, not recipe_calc_stuff on load. Choose Fixture Points separately to reconcile fixture speed.",
    );
  }

  const plan = { changes, items, effects, mode };
  if (mode === "fixturePoints") {
    const playerIndex = locate("PlayerInfo");
    if (playerIndex < 0)
      throw new Error("Fixture Points need a PlayerInfo record.");
    const balances = records[playerIndex].resources_load;
    if (balances !== undefined) object(balances, "PlayerInfo.resources_load");
    const current =
      balances && Object.hasOwn(balances, "FixturePoint")
        ? balances.FixturePoint
        : undefined;
    const currentPoints =
      current === undefined
        ? undefined
        : whole(current, "Current Fixture Points");
    if (currentPoints !== fixturePoints) {
      changes.push({
        path: [playerIndex, "resources_load", "FixturePoint"],
        value: makeNumeric(String(fixturePoints)),
      });
      items.push({ id: "FixturePoint", name: "Fixture Points" });
    }
    effects.push(
      `Fixture Points are reconciled to ${fixturePoints} using Recipes.set_fixture_points: sum each unlocked non-alien recipe's level × positive fixture-point rate, plus all reached FixturePoints rewards for those recipes. This replaces the balance and can lower an inconsistent existing amount.`,
    );
    plan.playerIndex = playerIndex;
    plan.fixturePoints = String(fixturePoints);
  }
  return plan;
}
