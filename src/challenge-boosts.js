import { isNumeric, makeNumeric, numericText } from "./codec.js";
import { isIntegerText } from "./resource-amounts.js";

const IDS = [
  "compute_challenge",
  "synth_challenge",
  "power_challenge",
  "base_challenge",
];

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

// Validate and compare exact JSON integers without rounding prior endless-mode
// progress through Number. The game uses finite numbers; fractional or negative
// completion counts must never be silently repaired by this action.
function whole(value, label) {
  const text = numericText(value);
  if (
    text.length > 4096 ||
    !Number.isFinite(Number(text)) ||
    !isIntegerText(text)
  )
    throw new Error(`${label} must be a nonnegative finite whole number.`);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  const digits = match[2] + (match[3] || "");
  if (/^0+$/.test(digits)) return 0n;
  if (match[1]) throw new Error(`${label} must be nonnegative.`);
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

function history(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !id)
  )
    throw new Error(`${label} must be an array of sector IDs.`);
  return value;
}

function validateChallenge(row) {
  object(row, "Challenge source row");
  if (
    !IDS.includes(row.id) ||
    row.saveName !== row.id ||
    typeof row.name !== "string" ||
    !row.name ||
    !Array.isArray(row.targets) ||
    !row.targets.length ||
    !Array.isArray(row.effects) ||
    !row.effects.length ||
    !Array.isArray(row.descriptions) ||
    !row.descriptions.length ||
    row.descriptions.some((text) => typeof text !== "string" || !text)
  )
    throw new Error("The catalog has malformed challenge source metadata.");
  const maximum = sourceWhole(
    row.maxCompletions,
    `${row.id} maximum completions`,
  );
  const ceiling = sourceWhole(row.targetCeiling, `${row.id} target ceiling`);
  sourceWhole(row.unlocksAt, `${row.id} unlock sector`);
  let previous = 0n;
  for (const target of row.targets) {
    const current = sourceWhole(target, `${row.id} target`);
    if (current <= previous)
      throw new Error(`${row.id} targets must increase.`);
    previous = current;
  }
  if (maximum !== BigInt(row.targets.length) || ceiling !== previous)
    throw new Error(`${row.id} maximum must match its source target tiers.`);
  for (const effect of row.effects) {
    object(effect, `${row.id} effect`);
    if (
      typeof effect.target !== "string" ||
      !effect.target ||
      !["multiplier", "exponentIncrement", "formulaModification"].includes(
        effect.kind,
      ) ||
      typeof effect.maximum !== "number" ||
      !Number.isFinite(effect.maximum)
    )
      throw new Error(`${row.id} has malformed reward formulas.`);
  }
  return { maximum, ceiling };
}

/**
 * Plan one source-capped, unlocked challenge reward. Only the selected record's
 * completion authorities are changed; callers apply the returned paths after
 * successful planning. No cached stats, active-run settings or histories change.
 */
export function planChallengeMaximum(records, catalog, id) {
  if (!IDS.includes(id)) throw new Error(`Unsupported challenge: ${id}.`);
  if (!Array.isArray(records))
    throw new Error("Save records must be an array.");
  const metadata = object(
    catalog?.categoryMetadata?.challengeBoosts,
    "Challenge boost metadata",
  );
  if (
    metadata.activeSaveName !== "Challenges" ||
    metadata.playerSaveName !== "PlayerInfo" ||
    metadata.unlockHistoryField !== "sectors_cleared_this_reinforce" ||
    metadata.highestTargetField !== "highest_target" ||
    !Array.isArray(metadata.completionFields) ||
    metadata.completionFields.length !== 2 ||
    metadata.completionFields[0] !== "amount_have" ||
    metadata.completionFields[1] !== "num_completions" ||
    !Array.isArray(metadata.challenges)
  )
    throw new Error(
      "The catalog has no supported source-backed challenge authorities.",
    );
  const choices = metadata.challenges.filter((row) => row?.id === id);
  if (choices.length !== 1)
    throw new Error(`Missing or ambiguous challenge source: ${id}.`);
  const row = choices[0];
  const { maximum, ceiling } = validateChallenge(row);
  const sectorOrders = object(metadata.sectorOrders, "Source sector orders");

  const locate = (name) => {
    const indexes = [];
    records.forEach((record, index) => {
      object(record, `Save record ${index}`);
      if (record.save_name === name) indexes.push(index);
    });
    if (indexes.length !== 1)
      throw new Error(`This action needs exactly one ${name} save record.`);
    return indexes[0];
  };
  const index = locate(row.saveName);
  const saved = records[index];
  const amount = whole(saved.amount_have, `${row.name} amount_have`);
  const completions = whole(
    saved.num_completions,
    `${row.name} num_completions`,
  );
  // The source explicitly accepts null highest_target and reconstructs it as 0.
  const highest =
    saved.highest_target === null
      ? 0n
      : whole(saved.highest_target, `${row.name} highest_target`);
  if (typeof saved.locked !== "boolean")
    throw new Error(`${row.name} locked must be a boolean.`);
  if (saved.locked)
    throw new Error(
      `${row.name} is locked; this action does not unlock challenges.`,
    );

  const active = records[locate(metadata.activeSaveName)];
  if (typeof active.challenge_active !== "boolean")
    throw new Error("Challenges.challenge_active must be a boolean.");
  if (active.challenge_active) {
    const current = object(active.current_challenge, "Active challenge");
    if (
      typeof current.id !== "string" ||
      !metadata.challenges.some((entry) => entry?.id === current.id)
    )
      throw new Error(
        "The save's active challenge cannot be identified safely.",
      );
    if (current.id === id)
      throw new Error(
        `Finish or abandon the active ${row.name} run in the game before changing its completions.`,
      );
  }

  const player = records[locate(metadata.playerSaveName)];
  let cleared = history(
    player[metadata.unlockHistoryField],
    "PlayerInfo.sectors_cleared_this_reinforce",
  );
  if (
    Object.hasOwn(player, "on_reinforcement_run") &&
    typeof player.on_reinforcement_run !== "boolean"
  )
    throw new Error("PlayerInfo.on_reinforcement_run must be a boolean.");
  // PlayerInfo resets this flag to false before loading. Before the first
  // reinforcement, load_from_save replaces unequal-length reinforcement history
  // with lifetime history. Reproduce that predicate without modifying either.
  if (player.on_reinforcement_run !== true) {
    const lifetime = history(
      player.sectors_cleared,
      "PlayerInfo.sectors_cleared",
    );
    if (cleared.length !== lifetime.length) cleared = lifetime;
  }
  let unlockedOnLoad = false;
  for (const sector of cleared) {
    if (!Object.hasOwn(sectorOrders, sector)) continue;
    const order = sourceWhole(
      sectorOrders[sector],
      `${sector} source sector order`,
    );
    if (order >= BigInt(row.unlocksAt)) unlockedOnLoad = true;
  }
  if (!unlockedOnLoad)
    throw new Error(
      `${row.name} needs a cleared sector of order ${row.unlocksAt} in its load-time reinforcement history. Sector histories are not edited.`,
    );

  const changes = [];
  const set = (field, previous, target) => {
    if (previous !== target)
      changes.push({
        path: [index, field],
        value: makeNumeric(String(target)),
      });
  };
  // The game caps counts at the number of targets. Synchronize both counters,
  // including older over-cap saves, while retaining valid higher endless clears.
  set("amount_have", amount, maximum);
  set("num_completions", completions, maximum);
  set("highest_target", highest, highest > ceiling ? highest : ceiling);
  const effects = [
    `${row.name}: ${row.maxCompletions}/${row.maxCompletions} source target tiers; highest cleared target is at least sector ${row.targetCeiling}. Higher existing endless-mode progress is preserved.`,
    ...row.descriptions,
    "The game rebuilds challenge rewards and total completed challenges on load. Active run settings, other challenge records, ship/loadouts, sector histories and cached stats are unchanged by this action.",
  ];
  if (active.challenge_active)
    effects.push(
      "Another challenge is active and is left intact; its own rules may restrict or scale these rewards while that run continues.",
    );
  return {
    changes,
    items: changes.length ? [{ id, name: row.name }] : [],
    effects,
  };
}
