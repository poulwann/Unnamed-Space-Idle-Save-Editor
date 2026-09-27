import { isNumeric, makeNumeric, numericText } from "./codec.js";
import {
  addResourceAmount,
  fillResourceAmount,
  isIntegerText,
} from "./resource-amounts.js";

const own = (value, key) => value != null && Object.hasOwn(value, key);
const composite = (value) =>
  value !== null && typeof value === "object" && !isNumeric(value);
const lookup = (table, key) => (own(table, key) ? table[key] : undefined);
const pretty = (value) =>
  String(value)
    .replace(/_load$/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
const policyCatalogs = new WeakMap();

function atPath(records, path) {
  let value = records;
  for (const key of path) {
    if (!own(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function children(value) {
  return Object.keys(value).map((key) => [
    Array.isArray(value) ? Number(key) : key,
    value[key],
  ]);
}

function named(catalog, id, metadata) {
  return metadata?.name || lookup(catalog.labels, id)?.name || pretty(id);
}

function fallbackGroup(category, name) {
  if (!name) return "Save metadata";
  const families = {
    Inventory: [
      [/recipe|synth/i, "Synthesis"],
      [/module/i, "Modules"],
      [/shard|harmony|voiddevice/i, "Shards"],
      [/core/i, "Cores"],
      [/loadout/i, "Loadouts"],
    ],
    Progression: [
      [/compute/i, "Compute"],
      [/reactor|power|overdrive/i, "Reactor and power"],
      [/warp|tether/i, "Warp"],
      [/base|building/i, "Bases"],
      [/challenge/i, "Challenges"],
      [/reinforce|prestige|retrofit/i, "Prestige and reinforcement"],
      [/sector|battle/i, "Sectors and battles"],
      [/upgrade/i, "Upgrades"],
    ],
    Crew: [
      [/splice|aspect/i, "Splicing"],
      [/sleeve/i, "Sleeves"],
      [/crew/i, "Crew"],
    ],
    Fleet: [
      [/unstable|transit|^ut/i, "Unstable transit"],
      [/galaxy/i, "Galaxies"],
      [/event/i, "Fleet events"],
      [/ship/i, "Fleet ships"],
    ],
    Research: [
      [/specimen/i, "Specimen research"],
      [/capital/i, "Capital research"],
      [/research/i, "Research"],
    ],
    Settings: [
      [/theme|skin/i, "Appearance"],
      [/setting|config/i, "Preferences"],
    ],
  };
  for (const [pattern, group] of families[category] || []) {
    if (pattern.test(name)) return group;
  }
  return pretty(name.replace(/(?:[_-]?\d+)+$/, "")) || category;
}

// Collection fields are omitted only after their actual children have entries.
// Empty, malformed, and future collections stay in the original generic tree.
export function buildCategoryEntries(records, catalog, classifyRecord) {
  const metadata = catalog.categoryMetadata || {};
  const entities = metadata.entities || {};
  const entries = [];
  const add = (path, title, category, group, subgroup, omitFields = []) => {
    const entry = { key: JSON.stringify(path), path, title, category, group };
    if (subgroup) entry.subgroup = subgroup;
    if (omitFields.length) entry.omitFields = omitFields;
    entries.push(entry);
    return entry;
  };

  records.forEach((record, index) => {
    const name = String(record?.save_name ?? "");
    const info = lookup(metadata.records, name);
    const achievement = lookup(metadata.achievements, name);
    const category =
      name === "PlayerInfo"
        ? "Progression"
        : achievement
          ? "Achievements"
          : info?.category || classifyRecord(record);
    const group =
      achievement?.group || info?.group || fallbackGroup(category, name);
    const subgroup =
      info?.subgroup ||
      (achievement?.tier != null ? `Tier ${achievement.tier}` : undefined);
    const entity =
      lookup(entities.research, name) ||
      lookup(entities.upgrades, name) ||
      lookup(entities.fleet, name);
    const title = name
      ? named(catalog, name, entity)
      : own(record, "version")
        ? "Game version"
        : own(record, "compatibility_version")
          ? "Compatibility version"
          : own(record, "timestamp")
            ? "Save timestamp"
            : `Record ${index + 1}`;
    const overview = add([index], title, category, group, subgroup);
    const omitted = [];
    const split = (field, categoryIn, groupIn, entityKind, describe) => {
      const collection = record?.[field];
      if (!composite(collection) || Object.keys(collection).length === 0)
        return;
      omitted.push(field);
      for (const [key, value] of children(collection)) {
        const entity = lookup(entities[entityKind], key);
        const details = describe?.(key, value, entity) || {};
        add(
          [index, field, key],
          details.title || named(catalog, key, entity),
          categoryIn,
          details.group || entity?.group || groupIn,
          details.subgroup ||
            (entity?.tier != null ? `Tier ${entity.tier}` : undefined),
        );
      }
    };

    if (name === "Recipes") {
      split("recipes_load", "Inventory", "Recipes", "recipes");
    } else if (name === "Modules") {
      split(
        "modules_load",
        "Inventory",
        "Modules",
        "modules",
        (_key, value) => ({
          subgroup: isNumeric(value?.tier)
            ? `Tier ${numericText(value.tier)}`
            : undefined,
        }),
      );
    } else if (name === "VoidDeviceArea") {
      for (const [field, location] of [
        ["inventory_data", "Inventory slots"],
        ["harmony_data", "Equipped slots"],
      ]) {
        split(field, "Inventory", "Shards", "shards", (key, value) => {
          const shard = lookup(entities.shards, value?.name);
          return {
            title: `${pretty(key)} · ${value == null ? "Empty" : named(catalog, value.name || key, shard)}`,
            group: "Shards",
            subgroup: location,
          };
        });
      }
      split("locked_data_load", "Inventory", "Shard slots", "", (key) => ({
        title: pretty(key),
        subgroup: "Unlocks",
      }));
    } else if (name === "PlayerInfo") {
      split(
        "cores_info_load",
        "Inventory",
        "Core unlocks",
        "cores",
        (_key, _value, entity) => ({
          group: "Core unlocks",
          subgroup: entity?.group,
        }),
      );
      split(
        "ships_load",
        "Inventory",
        "Ship unlocks",
        "ships",
        (_key, _value, entity) => ({
          group: "Ship unlocks",
          subgroup: entity?.group,
        }),
      );
      split("cores", "Inventory", "Equipped cores", "cores", (key, value) => ({
        title: `Slot ${typeof key === "number" ? key + 1 : key} · ${named(catalog, value?.core_id || key, lookup(entities.cores, value?.core_id))}`,
        group: "Equipped cores",
        subgroup: lookup(entities.cores, value?.core_id)?.group,
      }));
    } else if (
      name === "Crew" &&
      composite(record.crew_load) &&
      Object.keys(record.crew_load).length
    ) {
      omitted.push("crew_load");
      for (const [id, member] of children(record.crew_load)) {
        const crew = lookup(entities.crew, id);
        const memberName = named(catalog, id, crew);
        const memberGroup = memberName;
        const memberEntry = add(
          [index, "crew_load", id],
          memberName,
          "Crew",
          memberGroup,
          "Members",
        );
        const memberOmitted = [];
        for (const [field, kind, section] of [
          ["stats", "crewSkills", "Skills"],
          ["upgrades", "crewUpgrades", "Upgrades"],
        ]) {
          if (!composite(member?.[field]) || !Object.keys(member[field]).length)
            continue;
          memberOmitted.push(field);
          for (const [key] of children(member[field])) {
            const entity = lookup(entities[kind], key);
            add(
              [index, "crew_load", id, field, key],
              `${memberName} · ${named(catalog, key, entity)}`,
              "Crew",
              memberGroup,
              section,
            );
          }
        }
        if (memberOmitted.length) memberEntry.omitFields = memberOmitted;
      }
    } else if (name === "Themes") {
      split("skins_load_owned", "Settings", "Appearance", "", (key) => ({
        title: pretty(key),
        subgroup: "Ship skins",
      }));
      split("themes_load_owned", "Settings", "Appearance", "", (key) => ({
        title: pretty(key),
        subgroup: "Themes",
      }));
    } else if (name === "Warps") {
      split("warps_load", "Progression", "Warp destinations", "");
    } else if (name === "TitanComputeController") {
      split("strata_data", "Progression", "Compute strata", "");
      split("strata_growths", "Progression", "Compute growth", "");
    }
    if (omitted.length) overview.omitFields = omitted;
  });
  return entries;
}

function positiveMax(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? String(value)
    : undefined;
}

function numberPolicy(max, integer = false, note, min = "0") {
  const policy = { kind: "number", step: "1", min };
  if (integer) policy.integer = true;
  if (max !== undefined) policy.max = max;
  if (note) policy.note = note;
  return policy;
}

function moduleLevelMax(module, tier) {
  if (!isNumeric(tier)) return undefined;
  const text = numericText(tier);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return positiveMax(lookup(module?.levelsByTier, String(number)));
}

function numericPolicy(catalog, path, record, name) {
  const metadata = catalog.categoryMetadata || {};
  const entities = metadata.entities || {};
  const [, collection, id, field, item, leaf] = path;
  const rootField = path.length === 2 ? collection : undefined;
  const info = lookup(metadata.records, name);
  const research = lookup(entities.research, name);
  const upgrade = lookup(entities.upgrades, name);
  const fleet = lookup(entities.fleet, name);
  const source = String(info?.source || "")
    .split("/")
    .pop()
    .replace(/\.gd$/, "");
  const achievement =
    lookup(metadata.achievements, name) ||
    catalog.achievements?.some((entry) => entry.id === name);

  if (achievement && rootField === "amount_have") {
    return numberPolicy(
      "1",
      true,
      "Completion only. Loading a completed achievement does not grant AI points or extra rewards.",
    );
  }
  if (
    name === "Recipes" &&
    collection === "recipes_load" &&
    path.length === 4
  ) {
    if (field === "level")
      return numberPolicy(
        positiveMax(lookup(entities.recipes, id)?.maxLevel),
        true,
        "Only this level changes; the game recalculates recipe costs on load. No rewards or resources are added here.",
      );
    if (field === "num_crafted_this_level") return numberPolicy();
  }
  if (
    name === "Modules" &&
    collection === "modules_load" &&
    path.length === 4
  ) {
    const module = lookup(entities.modules, id);
    if (field === "level")
      return numberPolicy(
        moduleLevelMax(module, record.modules_load[id]?.tier ?? 1),
        true,
        "Capped at the saved module tier. This action does not advance its tier or equip the module.",
      );
    if (field === "tier" && positiveMax(module?.maxTier)) {
      return numberPolicy(
        positiveMax(module.maxTier),
        true,
        "The existing level must fit the new tier; adjust the level separately if necessary.",
        "1",
      );
    }
  }
  if (
    name === "VoidDeviceArea" &&
    ["inventory_data", "harmony_data"].includes(collection) &&
    path.length === 4
  ) {
    const shard = lookup(entities.shards, record[collection][id]?.name);
    if (field === "resonance")
      return numberPolicy(positiveMax(shard?.maxResonance));
    if (["antumbra_dissonance", "penumbra_dissonance"].includes(field))
      return numberPolicy();
  }
  if (name === "PlayerInfo") {
    if (
      collection === "cores_info_load" &&
      field === "tier" &&
      path.length === 4
    ) {
      const max = positiveMax(lookup(entities.cores, id)?.maxTier);
      return max ? numberPolicy(max, true, undefined, "1") : null;
    }
    if (collection === "cores" && field === "tier" && path.length === 4) {
      const max = positiveMax(
        lookup(entities.cores, record.cores[id]?.core_id)?.maxTier,
      );
      return max ? numberPolicy(max, true, undefined, "1") : null;
    }
    if (
      ["resources_load", "resource_totals_gained_load"].includes(collection) &&
      path.length === 3 &&
      catalog.resources?.some((resource) => resource.id === id)
    )
      return numberPolicy();
    if (rootField === "retrofits_available")
      return numberPolicy(undefined, true);
  }
  if (name === "Crew") {
    if (rootField === "sleeves") return numberPolicy(undefined, true);
    if (
      collection === "crew_load" &&
      path.length === 4 &&
      ["rank", "highest_rank", "mastery"].includes(field)
    ) {
      return numberPolicy(
        undefined,
        true,
        "Changes only the selected progression field, not rank spending, skill XP, mastery rewards, or upgrade order.",
      );
    }
    if (collection === "crew_load" && field === "stats" && path.length === 6) {
      if (["level", "highest_level", "levels_this_sleeve"].includes(leaf))
        return numberPolicy(undefined, true);
      // Mastery gain modifiers make these saved counters legitimately fractional.
      if (["xp", "levels_this_run", "mastery_this_sleeve"].includes(leaf))
        return numberPolicy();
    }
    if (
      collection === "crew_load" &&
      field === "upgrades" &&
      leaf === "level" &&
      path.length === 6
    ) {
      return numberPolicy(
        positiveMax(lookup(entities.crewUpgrades, item)?.maxLevel),
        true,
      );
    }
  }
  if (research && rootField === "resources_in")
    return numberPolicy(
      undefined,
      false,
      "Research progress only; costs can scale dynamically. The game may recalculate completion when loading.",
    );
  if (research && rootField === "amount_have") {
    return research.method === "Unbound"
      ? null
      : numberPolicy(
          positiveMax(research.maxLevel),
          true,
          "Changes only the saved research level/completion, not its resource investment or reward records.",
        );
  }
  if (
    rootField === "amount_have" &&
    (upgrade || /Upgrade|^(?:ComputeButton|PowerBoost)$/.test(source))
  ) {
    const max =
      source === "PowerBoost" && isNumeric(record.max_level)
        ? numericText(record.max_level)
        : positiveMax(upgrade?.maxLevel);
    return numberPolicy(
      max && Number(max) > 0 ? max : undefined,
      true,
      upgrade?.note,
    );
  }
  if (
    (fleet || source === "FleetEvent") &&
    rootField === "contribution_upgrade_level_load"
  ) {
    return numberPolicy(
      positiveMax(fleet?.maxContributionLevel),
      true,
      "The game may update event completion and grant clear upgrades when loading this progression.",
    );
  }
  if (
    (fleet || source === "FleetEvent") &&
    ["contribution_resources_in", "acquire_resources_in"].includes(rootField)
  )
    return numberPolicy();
  if ((fleet || source === "FleetGalaxy") && rootField === "galaxy_fuel")
    return numberPolicy();
  if ((fleet || source === "FleetGalaxy") && rootField === "transit_charges")
    return numberPolicy(undefined, true);
  if (source === "UTLevelButton" && rootField === "banked_runs")
    return numberPolicy(undefined, true);
  if (name === "Fleet" && rootField === "ut_rerolls")
    return numberPolicy(undefined, true);
  if (name === "Fleet" && rootField === "ut_artifacts_gained")
    return numberPolicy();
  if (
    [
      "ComputeButton",
      "WarpCore",
      "TetherWarpCore",
      "ReactorOverdrive",
      "LimitedUpgradeButton",
    ].includes(source) &&
    rootField === "progress"
  )
    return numberPolicy();
  if (source === "ReactorOverdrive" && rootField === "charges")
    return numberPolicy();
  if (
    source === "UnstableGalaxyDisplay" &&
    rootField === "instability_progress_load"
  )
    return numberPolicy();
  if (source === "UnstableGalaxyDisplay" && rootField === "instability_load")
    return numberPolicy(undefined, true);
  return null;
}

export function getFieldPolicy(records, catalog, path) {
  if (!Array.isArray(path) || path.length < 2 || !Number.isInteger(path[0]))
    return null;
  const record = records[path[0]];
  if (!composite(record)) return null;
  const value = atPath(records, path);
  const name = String(record.save_name ?? "");
  const key = String(path.at(-1));
  if (
    /^(?:save_name|id|.*_id|version|compatibility_version|timestamp|.*_timestamp|.*_date|.*_seed|seed|parent|pos_x|pos_y)$/.test(
      key,
    )
  )
    return null;
  let policy;
  if (typeof value === "boolean") {
    policy = { kind: "boolean" };
    if (
      /reward|complete|finish|battle_done|resources_done|acquire_cost_paid/.test(
        key,
      )
    ) {
      policy.note =
        "Completion/reward flag only. The game may grant or skip rewards on load; related costs, history, and reward records are not changed.";
    }
  } else if (isNumeric(value)) {
    policy = numericPolicy(catalog, path, record, name);
  }
  if (!policy) return null;
  policyCatalogs.set(policy, catalog);
  return policy;
}

export function collectActionFields(records, catalog, entry) {
  const fields = [];
  const omitted = new Set(entry.omitFields || []);
  const visit = (value, path, relative) => {
    if (composite(value)) {
      for (const [key, child] of children(value)) {
        if (relative.length === 0 && omitted.has(String(key))) continue;
        visit(child, [...path, key], [...relative, key]);
      }
      return;
    }
    const policy = getFieldPolicy(records, catalog, path);
    if (policy)
      fields.push({
        path,
        relativeKey: JSON.stringify(relative),
        label: relative.length ? relative.map(pretty).join(" › ") : "Value",
        policy,
      });
  };
  visit(atPath(records, entry.path), entry.path, []);
  return fields;
}

function exceeds(value, max) {
  const bound = makeNumeric(max);
  return fillResourceAmount(bound, numericText(value)) !== bound;
}

function planNumber(value, policy, action, target) {
  // Validate existing numeric text, finite range, and work bounds even for no-ops.
  addResourceAmount(value, "0");
  if (policy.integer && !isIntegerText(numericText(value))) {
    throw new Error(
      "The saved value is fractional. Correct it explicitly before using an integer-level action; it will not be rounded.",
    );
  }
  const operand =
    action === "max"
      ? policy.max
      : (target ?? (action === "add" ? policy.step || "1" : undefined));
  if (action === "max" && (!operand || !exceeds(makeNumeric(operand), "0"))) {
    throw new Error("This field has no known positive maximum.");
  }
  // Validate the requested operand independently of whether a cap makes it a no-op.
  fillResourceAmount(makeNumeric("0"), operand);
  if (policy.integer && !isIntegerText(operand.trim()))
    throw new Error(
      "This field requires a whole-number amount; decimal levels are not rounded.",
    );
  const requested = makeNumeric(operand);
  if (
    action !== "add" &&
    fillResourceAmount(requested, policy.min || "0") !== requested
  ) {
    throw new Error(`The target must be at least ${policy.min || "0"}.`);
  }
  let result;
  if (policy.max && fillResourceAmount(value, policy.max) === value) {
    result = value;
  } else if (
    action === "add" &&
    policy.max &&
    fillResourceAmount(value, "0") === value &&
    fillResourceAmount(requested, policy.max) === requested
  ) {
    result = makeNumeric(policy.max);
  } else {
    result =
      action === "add"
        ? addResourceAmount(value, operand)
        : fillResourceAmount(value, operand);
  }
  if (policy.max && exceeds(result, policy.max)) {
    result = fillResourceAmount(value, policy.max);
  }
  if (fillResourceAmount(result, policy.min || "0") !== result) {
    throw new Error(`The result must be at least ${policy.min || "0"}.`);
  }
  return result;
}

export function planFieldAction(records, fields, action, target) {
  if (!["add", "fill", "max", "true", "false"].includes(action))
    throw new Error("Unsupported field action.");
  const plans = new Map();
  const selected = [];
  for (const field of fields) {
    const catalog = policyCatalogs.get(field.policy);
    const policy = catalog && getFieldPolicy(records, catalog, field.path);
    if (!policy)
      throw new Error(
        `${field.label || "Field"}: no safe quick action is available. Select the field again or use its generic editor.`,
      );
    const value = atPath(records, field.path);
    const booleanAction = action === "true" || action === "false";
    if (booleanAction !== (policy.kind === "boolean")) {
      throw new Error(
        `${field.label || "Field"}: this field does not support ${action}.`,
      );
    }
    const replacement = booleanAction
      ? action === "true"
      : planNumber(value, policy, action, target);
    const key = JSON.stringify(field.path);
    plans.set(key, { path: field.path, value: replacement });
    selected.push({ field, catalog, policy, value });
  }

  // Evaluate tier-dependent levels against the complete proposed transaction.
  // No saved field is mutated, even if the last member of a group is invalid.
  for (const { field, catalog, policy, value } of selected) {
    const [index, collection, id, leaf] = field.path;
    if (
      records[index].save_name !== "Modules" ||
      collection !== "modules_load" ||
      field.path.length !== 4 ||
      !["tier", "level"].includes(leaf)
    )
      continue;
    const module = lookup(catalog.categoryMetadata?.entities?.modules, id);
    const tierPath = [index, collection, id, "tier"];
    const levelPath = [index, collection, id, "level"];
    const tierPlan = plans.get(JSON.stringify(tierPath));
    const tier = tierPlan?.value ?? atPath(records, tierPath) ?? 1;
    const max = moduleLevelMax(module, tier);
    if (
      leaf === "level" &&
      (!isNumeric(tier) ||
        !isIntegerText(numericText(tier)) ||
        Number(numericText(tier)) < 1 ||
        (positiveMax(module?.maxTier) &&
          exceeds(tier, positiveMax(module.maxTier))))
    ) {
      throw new Error(
        `${named(catalog, id, module)}: correct the saved module tier before changing its level.`,
      );
    }
    if (leaf === "level" && tierPlan) {
      const effective = { ...policy };
      if (max) effective.max = max;
      else delete effective.max;
      plans.set(JSON.stringify(levelPath), {
        path: levelPath,
        value: planNumber(value, effective, action, target),
      });
    }
  }
  for (const { field, catalog } of selected) {
    const [index, collection, id, leaf] = field.path;
    if (
      records[index].save_name !== "Modules" ||
      collection !== "modules_load" ||
      field.path.length !== 4 ||
      leaf !== "tier"
    )
      continue;
    const module = lookup(catalog.categoryMetadata?.entities?.modules, id);
    const tierPath = [index, collection, id, "tier"];
    const levelPath = [index, collection, id, "level"];
    const tierPlan = plans.get(JSON.stringify(tierPath));
    const tier = tierPlan.value;
    const max = moduleLevelMax(module, tier);
    const level =
      plans.get(JSON.stringify(levelPath))?.value ?? atPath(records, levelPath);
    if (
      tierPlan &&
      tierPlan.value !== atPath(records, tierPath) &&
      max &&
      isNumeric(level) &&
      exceeds(level, max)
    ) {
      throw new Error(
        `${named(catalog, id, module)}: level ${numericText(level)} exceeds tier ${numericText(tier)}'s maximum ${max}. Lower its level explicitly before changing tier; no changes were applied.`,
      );
    }
  }
  return [...plans.values()].filter(
    ({ path, value }) => value !== atPath(records, path),
  );
}
