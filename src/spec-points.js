import { isNumeric, makeNumeric, numericText } from "./codec.js";
import { isIntegerText } from "./resource-amounts.js";

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

function whole(value, label) {
  const text = numericText(value);
  const number = Number(text);
  if (!isIntegerText(text) || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be a nonnegative safe whole number.`);
  return number;
}

function wholeField(record, field) {
  return Object.hasOwn(record, field)
    ? whole(record[field], `${record.save_name}.${field}`)
    : 0;
}

function finite(value, label) {
  const number = Number(numericText(value));
  if (!Number.isFinite(number) || number < 0)
    throw new Error(`${label} must be a nonnegative finite number.`);
  return number;
}

function flag(record, key, fallback = false) {
  if (!Object.hasOwn(record, key)) return fallback;
  if (typeof record[key] !== "boolean")
    throw new Error(`${record.save_name}.${key} must be a boolean.`);
  return record[key];
}

function sumSafe(values, label) {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum) || sum < 0)
    throw new Error(`${label} exceeds safe whole-number arithmetic.`);
  return sum;
}

function spentAt(specification, level) {
  // Upgrade.get_amount_spent uses amount_have, not amount_purchased.
  return (
    specification.costBase *
    (level + (specification.costGrowth * level * (level - 1)) / 2)
  );
}

function tierLimit(fighter, stats) {
  const delay = stats[fighter.tierDelayStat];
  const reduction = stats.compute_fighter_tier_scaling_reduction;
  const growth = Math.max(fighter.costGrowth / reduction, 2);
  if (
    !Number.isFinite(growth) ||
    growth < 2 ||
    !Number.isSafeInteger(delay) ||
    delay < 0
  )
    throw new Error(`Cannot reconstruct safe tier costs for ${fighter.id}.`);

  // ComputeButton also multiplies the cost by fills-to-tier (and by five for
  // its progress display). Reserve a complete tier of work and the next tier,
  // rather than merely accepting a finite pow() at the edited tier. This is a
  // numerical bound, not a gameplay cap or a generic resource maximum.
  const workFactor = Math.max(fighter.levelsPerTier, 5);
  const costLimit = Number.MAX_VALUE / workFactor;
  const safe = (tier) => {
    const cost = Math.round(
      fighter.costBase * growth ** Math.max(tier + 1 - delay, 0),
    );
    const effectTier = tier + 1;
    const effect =
      fighter.effect.kind === "exponential"
        ? fighter.effect.factor ** effectTier
        : 1 + fighter.effect.factor * effectTier;
    return (
      Number.isFinite(cost) &&
      cost > 0 &&
      cost <= costLimit &&
      Number.isFinite(cost * workFactor) &&
      Number.isFinite(effect)
    );
  };
  let limit =
    Math.floor(
      (Math.log(costLimit) - Math.log(fighter.costBase)) / Math.log(growth) +
        delay,
    ) - 1;
  if (!Number.isSafeInteger(limit) || limit < 0 || !safe(0))
    throw new Error(`${fighter.id} has no numerically safe compute tier.`);
  // Floating-point logarithms may straddle the exact power boundary.
  while (limit > 0 && !safe(limit)) limit -= 1;
  if (safe(limit + 1)) limit += 1;
  return limit;
}

export function planSpecPoints(records, catalog) {
  if (!Array.isArray(records))
    throw new Error("Save records must be an array.");
  const metadata = catalog?.categoryMetadata?.specPoints;
  if (
    !metadata ||
    !Array.isArray(metadata.fighters) ||
    !metadata.fighters.length ||
    !Array.isArray(metadata.specifications) ||
    !metadata.specifications.length ||
    !Array.isArray(metadata.contributions)
  )
    throw new Error(
      "The catalog has no source-backed specialization funding metadata.",
    );

  const byName = new Map();
  records.forEach((record, index) => {
    object(record, `Save record ${index}`);
    if (typeof record.save_name !== "string") return;
    const matches = byName.get(record.save_name) || [];
    matches.push(index);
    byName.set(record.save_name, matches);
  });
  const locate = (names, label) => {
    const matches = [
      ...new Set(names.flatMap((name) => byName.get(name) || [])),
    ];
    if (matches.length > 1)
      throw new Error(`Ambiguous duplicate save records for ${label}.`);
    return matches.length ? matches[0] : -1;
  };
  const playerIndex = locate(["PlayerInfo"], "PlayerInfo");
  if (playerIndex < 0) throw new Error("This save needs a PlayerInfo record.");
  const player = records[playerIndex];
  if (metadata.disabledShips.includes(player.ship))
    throw new Error(
      "Titan ships replace fighter specialization; the game would reset these tiers on load.",
    );
  if (player.resources_load !== undefined)
    object(player.resources_load, "PlayerInfo.resources_load");

  // Challenges stores its active definition verbatim, and load_from_save does
  // not replace it. Replay check_stat/check_stat_multiplier in source order.
  const challengeIndex = locate(["Challenges"], "Challenges");
  let challengeChanges = [];
  if (
    challengeIndex >= 0 &&
    flag(records[challengeIndex], "challenge_active")
  ) {
    const challenge = object(
      records[challengeIndex].current_challenge,
      "Current challenge",
    );
    if (!Array.isArray(challenge.stat_changes))
      throw new Error(
        "The active challenge has no valid stat_changes collection.",
      );
    challengeChanges = challenge.stat_changes;
    for (const change of challengeChanges) {
      object(change, "Challenge stat change");
      if (
        typeof change.stat !== "string" ||
        typeof change.source !== "string" ||
        typeof change.restricted !== "boolean"
      )
        throw new Error(
          "The active challenge has an invalid stat restriction.",
        );
      finite(change.multiplier, "Challenge stat multiplier");
    }
  }
  const challengeMultiplier = (stat, group) => {
    let allowed = true;
    let multiplier = 1;
    for (const change of challengeChanges) {
      if (
        (change.stat === stat || change.stat === "all") &&
        (change.source === group || change.source === "all")
      ) {
        allowed = !change.restricted;
        multiplier = finite(change.multiplier, "Challenge stat multiplier");
      }
    }
    return allowed ? multiplier : 0;
  };

  const stats = { ...object(metadata.statBases, "Specialization stat bases") };
  for (const contribution of metadata.contributions) {
    const index = locate(contribution.saveNames, contribution.id);
    if (index < 0) continue; // Absent source records load at their source defaults.
    const record = records[index];
    let level;
    if (contribution.kind === "firstClear") {
      level =
        flag(record, "finished_first_time") &&
        (!contribution.deferredUntilGalaxyFinish ||
          !flag(record, "finished_first_this_run"))
          ? 1
          : 0;
    } else if (contribution.kind === "level") {
      level = wholeField(record, "amount_have");
      if (contribution.pendingField) {
        const pending = wholeField(record, contribution.pendingField);
        if (level + pending > contribution.maxLevel)
          throw new Error(
            `${record.save_name} exceeds its source active-plus-pending cap.`,
          );
      }
    } else {
      throw new Error(`Unsupported specialization source ${contribution.id}.`);
    }
    if (level > contribution.maxLevel)
      throw new Error(`${record.save_name} exceeds its source level cap.`);
    for (const effect of contribution.effects) {
      if (!Object.hasOwn(stats, effect.stat))
        throw new Error(`Unknown specialization stat ${effect.stat}.`);
      stats[effect.stat] +=
        level *
        effect.perLevel *
        challengeMultiplier(effect.stat, contribution.group);
    }
  }
  for (const [stat, value] of Object.entries(stats)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(
        `${stat} cannot be reconstructed as a nonnegative safe whole number.`,
      );
  }
  const divisor = stats.compute_tiers_per_spec_point;
  const basePoints = stats.compute_base_spec_points;
  if (divisor < 1 || stats.compute_fighter_tier_scaling_reduction < 1)
    throw new Error(
      "Specialization tier divisor and scaling reduction must be positive.",
    );

  let spent = 0;
  const requiredTotal = sumSafe(
    metadata.specifications.map((specification) => {
      const index = locate(specification.saveNames, specification.id);
      const level = index < 0 ? 0 : wholeField(records[index], "amount_have");
      if (level > specification.maxLevel)
        throw new Error(
          `${specification.id} exceeds its source specialization cap.`,
        );
      spent += spentAt(specification, level);
      return spentAt(specification, specification.maxLevel);
    }),
    "Complete specialization budget",
  );
  if (
    requiredTotal !== metadata.requiredTotal ||
    !Number.isSafeInteger(spent) ||
    spent > requiredTotal
  )
    throw new Error("Specialization costs do not match the source budget.");

  const fighters = [];
  for (const fighter of metadata.fighters) {
    const index = locate(fighter.saveNames, fighter.id);
    if (index < 0) continue; // Never create/unlock a missing fighter in a partial save.
    const record = records[index];
    const tier = wholeField(record, "tier");
    const limit = tierLimit(fighter, stats);
    if (tier > limit)
      throw new Error(
        `${record.save_name} tier ${tier} exceeds the safe source-cost bound ${limit}; no fields were changed.`,
      );
    for (const field of [
      "amount_have",
      "amount_purchased",
      "additional_cap",
      "compute_allocated",
      "progress",
    ])
      if (record[field] !== undefined)
        finite(record[field], `${record.save_name}.${field}`);
    fighters.push({
      id: fighter.id,
      index,
      tier,
      original: tier,
      limit,
      unlocked: flag(record, "unlocked", fighter.unlockedByDefault),
    });
  }
  const eligible = fighters.filter((fighter) => fighter.unlocked);
  let totalTiers = sumSafe(
    fighters.map((fighter) => fighter.tier),
    "Total fighter tiers",
  );
  const neededTiers = Math.max(0, requiredTotal - basePoints) * divisor;
  if (!Number.isSafeInteger(neededTiers))
    throw new Error("Required specialization tiers exceed safe arithmetic.");
  const capacity = sumSafe(
    fighters.map((fighter) =>
      fighter.unlocked ? fighter.limit : fighter.tier,
    ),
    "Safely reachable fighter tiers",
  );
  if (capacity < neededTiers) {
    const reachable = Math.floor(capacity / divisor) + basePoints;
    throw new Error(
      `Full specialization funding needs ${requiredTotal} earned points (${neededTiers} total tiers), ` +
        `but this save can safely reach only ${reachable} points (${capacity} tiers). ` +
        "Unlock more fighters or earn tier-divisor reductions, tier delays, or starting-point grants in game first. Nothing was changed.",
    );
  }

  if (totalTiers < neededTiers) {
    // Integer water-filling raises only the lowest unlocked tiers. Binary search
    // avoids a loop per tier, even if future source data adds large tier delays.
    const needed = neededTiers - totalTiers;
    const addedAt = (level) =>
      eligible.reduce(
        (sum, fighter) =>
          sum + Math.max(0, Math.min(level, fighter.limit) - fighter.original),
        0,
      );
    let low = 0;
    let high = Math.max(...eligible.map((fighter) => fighter.limit));
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (addedAt(middle) >= needed) high = middle;
      else low = middle + 1;
    }
    let remaining = needed;
    for (const fighter of eligible) {
      fighter.tier = Math.max(
        fighter.original,
        Math.min(low - 1, fighter.limit),
      );
      remaining -= fighter.tier - fighter.original;
    }
    for (const fighter of eligible) {
      if (!remaining) break;
      if (fighter.tier < low && fighter.tier < fighter.limit) {
        fighter.tier += 1;
        remaining -= 1;
      }
    }
    if (remaining !== 0)
      throw new Error("Unable to distribute specialization tiers safely.");
    totalTiers = neededTiers;
  }
  const total = Math.floor(totalTiers / divisor) + basePoints;
  const available = total - spent;
  if (
    !Number.isSafeInteger(total) ||
    total < requiredTotal ||
    available < requiredTotal - spent
  )
    throw new Error(
      "The planned tiers do not fund the complete specialization budget.",
    );

  const changes = fighters
    .filter((fighter) => fighter.tier !== fighter.original)
    .map((fighter) => ({
      path: [fighter.index, "tier"],
      value: makeNumeric(String(fighter.tier)),
    }));
  const raisedFighters = changes.length;
  const current = player.resources_load?.FighterSpecPoint;
  if (current === undefined || numericText(current) !== String(available))
    changes.push({
      path: [playerIndex, "resources_load", "FighterSpecPoint"],
      value: makeNumeric(String(available)),
    });
  // progress_needed is deliberately untouched: ComputeButton.after_load_setup
  // recalculates it. Purchases, progress, allocation, unlocks and grant sources
  // are never changed. The caller applies all planned paths in one undo entry.
  return {
    changes,
    playerIndex,
    requiredTotal,
    total,
    spent,
    available,
    raisedFighters,
    totalTiers,
    tiersPerPoint: divisor,
    basePoints,
  };
}
