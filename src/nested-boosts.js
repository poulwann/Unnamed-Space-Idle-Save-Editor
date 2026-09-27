import { isNumeric, makeNumeric, numericText } from "./codec.js";
import { isIntegerText } from "./resource-amounts.js";

function dictionary(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isNumeric(value)
  )
    throw new Error(`${label} must be a saved dictionary.`);
  return value;
}

function whole(value, label) {
  const text = numericText(value);
  const number = Number(text);
  if (!isIntegerText(text) || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be a nonnegative safe whole number.`);
  return number;
}

function cap(value, label) {
  const number = whole(value, label);
  if (number === 0)
    throw new Error(`${label} has no finite positive source cap.`);
  return number;
}

function bounded(value, maximum, label, integral = true) {
  const text = numericText(value);
  const number = integral ? whole(value, label) : Number(text);
  if (!Number.isFinite(number) || number < 0 || number > maximum)
    throw new Error(
      `${label} must be between 0 and the source cap ${maximum}.`,
    );
  // Dissonance is a source float. Compare exact decimals as well so rounding
  // 1000.00000000000000001 to 1000 cannot silently accept an over-cap save.
  if (!integral) {
    if (text.length > 4096)
      throw new Error(`${label} exceeds the supported numeric length.`);
    const [mantissa, power = "0"] = text.toLowerCase().split("e");
    const digits = mantissa.replace(/[-.]/g, "").replace(/^0+/, "");
    if (digits) {
      if (mantissa.startsWith("-"))
        throw new Error(`${label} must be nonnegative.`);
      const places = (mantissa.split(".")[1] || "").length;
      const length = digits.length + Number(power) - places;
      const ceiling = String(maximum);
      const width = Math.max(digits.length, ceiling.length);
      if (
        length > ceiling.length ||
        (length === ceiling.length &&
          digits.padEnd(width, "0") > ceiling.padEnd(width, "0"))
      )
        throw new Error(`${label} exceeds the source cap ${maximum}.`);
    }
  }
  return number;
}

function ownerIndex(records, catalog, kind) {
  const source =
    kind === "module" ? "Modules.gd" : "interface/harmony/HarmonyArea.gd";
  const names =
    kind === "module" ? ["Modules"] : ["HarmonyArea", "VoidDeviceArea"];
  const owners = catalog.categoryMetadata.records || catalog.records || {};
  const indices = [];
  for (let index = 0; index < records.length; index++) {
    const name = records[index]?.save_name;
    if (names.includes(name) || owners[name]?.source === source)
      indices.push(index);
  }
  if (indices.length > 1)
    throw new Error(
      `Multiple ${kind} save owners are ambiguous; no changes were planned.`,
    );
  return indices[0] ?? -1;
}

function labels(effects) {
  return [...new Set(effects.map((effect) => effect.name))];
}

function flag(item, field, label) {
  if (Object.hasOwn(item, field) && typeof item[field] !== "boolean")
    throw new Error(`${label} ${field} must be a saved boolean.`);
}

function select(plan, detail, effects, target, includeCoupled) {
  const other = effects.filter(
    (effect) => !effect.stat || effect.target !== target,
  );
  detail.effects = labels(effects);
  detail.otherEffects = labels(other);
  detail.isCoupled = other.length > 0;
  if (detail.isCoupled) {
    plan.coupled.push({
      ...detail,
      reason: "This contributor also has other effects.",
    });
    if (!includeCoupled) {
      plan.skipped.push({
        ...detail,
        reason: "Coupled effects require the separate coupled action.",
      });
      return false;
    }
  }
  plan.selected.push(detail);
  plan.items.push({ id: detail.id, name: detail.name });
  return true;
}

function planModules(records, catalog, target, includeCoupled, metadata, plan) {
  const identifiers = metadata.targets[target].modules;
  const index = ownerIndex(records, catalog, "module");
  if (index < 0 || !Object.hasOwn(records[index], "modules_load")) {
    plan.skipped.push({
      id: "Modules",
      name: "Active modules",
      reason: "No saved module collection exists.",
    });
    return;
  }
  const saved = dictionary(records[index].modules_load, "modules_load");
  for (const id of identifiers) {
    const info = metadata.modules[id];
    const detail = { id, name: info.name, kind: "module", recordIndex: index };
    if (!Object.hasOwn(saved, id)) {
      plan.skipped.push({
        ...detail,
        reason: "This module is absent from the save.",
      });
      continue;
    }
    const module = dictionary(saved[id], info.name);
    for (const field of ["locked", "active", "removed"])
      flag(module, field, info.name);
    if (
      module.locked !== false ||
      module.active !== true ||
      module.removed === true
    ) {
      plan.skipped.push({
        ...detail,
        reason:
          module.locked !== false
            ? "This module is locked or has no saved unlock state."
            : module.removed === true
              ? "This module is removed."
              : "This module is inactive.",
      });
      continue;
    }
    if (info.unsupportedReason) {
      plan.unsupported.push({ ...detail, reason: info.unsupportedReason });
      continue;
    }
    const maximumTier = cap(info.maxTier, `${info.name} tier`);
    // Modules.load_from_save supplies tier 1 for old saves; startTier is only a
    // display/crafting offset and must never be added to this saved authority.
    const tier = bounded(
      Object.hasOwn(module, "tier") ? module.tier : 1,
      maximumTier,
      `${info.name} tier`,
    );
    if (tier < 1 || !info.tiers[tier - 1] || !info.tiers[maximumTier - 1])
      throw new Error(`${info.name} has an invalid one-based source tier.`);
    const current = info.tiers[tier - 1];
    const final = info.tiers[maximumTier - 1];
    if (current.tier !== tier || final.tier !== maximumTier)
      throw new Error(`${info.name} source tier indexing is inconsistent.`);
    if (!current.maxLevel || !final.maxLevel) {
      plan.unsupported.push({
        ...detail,
        reason: "This module has no finite source level cap.",
      });
      continue;
    }
    const level = bounded(
      module.level,
      cap(current.maxLevel, `${info.name} current level`),
      `${info.name} level`,
    );
    if (level === 0)
      throw new Error(
        `${info.name} is marked active but has no crafted levels.`,
      );
    const finalLevel = cap(final.maxLevel, `${info.name} final level`);
    const finalTarget = final.effects.filter(
      (effect) => effect.stat && effect.target === target,
    );
    if (
      !finalTarget.length ||
      finalTarget.some((effect) => effect.unsupportedReason)
    ) {
      plan.unsupported.push({
        ...detail,
        reason:
          "The final tier has no supported capped contribution to this stat.",
      });
      continue;
    }
    // Tier upgrades replace the effect array. Include current and resulting
    // effects (and intermediate tiers) rather than calling an early tier pure.
    const effects = info.tiers
      .slice(tier - 1, maximumTier)
      .flatMap((entry) => entry.effects);
    if (effects.some((effect) => !effect.stat)) {
      plan.unsupported.push({
        ...detail,
        effects: labels(effects),
        reason: "This module would also change an unlock or automation.",
      });
      continue;
    }
    Object.assign(detail, {
      tier,
      maximumTier,
      level,
      maximumLevel: finalLevel,
      fields: ["tier", "level"],
    });
    if (!select(plan, detail, effects, target, includeCoupled)) continue;
    if (tier !== maximumTier)
      plan.changes.push({
        path: [index, "modules_load", id, "tier"],
        value: makeNumeric(String(maximumTier)),
      });
    if (level !== finalLevel)
      plan.changes.push({
        path: [index, "modules_load", id, "level"],
        value: makeNumeric(String(finalLevel)),
      });
    for (const effect of effects) plan.effects.add(effect.name);
  }
}

function shardSlot(slot, info) {
  if (info.permanentSlot && slot === info.permanentSlot)
    return { permanent: true, color: "" };
  const match = /^ShardSlot(Red|Orange|Pink|Blue|Green|Purple|White)$/.exec(
    slot,
  );
  if (!match) return null;
  const color = match[1];
  if (
    color !== "White" &&
    !info.slotTypes.includes("Any") &&
    !info.slotTypes.includes(color)
  )
    return null;
  return { permanent: false, color };
}

function effectActive(effect, slot, owner) {
  if (
    !effect.color ||
    slot.permanent ||
    slot.color === "White" ||
    slot.color === effect.color
  )
    return true;
  if (!Object.hasOwn(owner, "link_data_load")) return false;
  const links = dictionary(owner.link_data_load, "Shard links");
  // Match HarmonyArea.check_link_combo without enabling or adding any links.
  for (const [name, active] of Object.entries(links)) {
    const colors = name.split("_");
    if (colors.includes(slot.color) && colors.includes(effect.color)) {
      if (typeof active !== "boolean")
        throw new Error(`Shard link ${name} must be a saved boolean.`);
      return active;
    }
  }
  return false;
}

function planShards(records, catalog, target, includeCoupled, metadata, plan) {
  const index = ownerIndex(records, catalog, "shard");
  if (index < 0 || !Object.hasOwn(records[index], "harmony_data")) {
    plan.skipped.push({
      id: "HarmonyArea",
      name: "Equipped void shards",
      reason: "No saved equipped-shard collection exists.",
    });
    return;
  }
  const owner = records[index];
  const saved = dictionary(owner.harmony_data, "harmony_data");
  if (
    Object.hasOwn(owner, "charging_perma_slot") &&
    typeof owner.charging_perma_slot !== "string"
  )
    throw new Error("Shard charging_perma_slot must be a saved string.");
  const candidates = new Set(metadata.targets[target].shards);
  const equipped = new Set();
  for (const [slotName, value] of Object.entries(saved)) {
    if (value === null) continue;
    const shard = dictionary(value, `Equipped shard in ${slotName}`);
    if (typeof shard.name !== "string")
      throw new Error(`Equipped shard in ${slotName} has no valid name.`);
    if (!candidates.has(shard.name)) continue;
    const id = shard.name;
    equipped.add(id);
    const info = metadata.shards[id];
    const detail = {
      id,
      name: info.name,
      kind: "shard",
      recordIndex: index,
      slot: slotName,
      tier: info.tier,
    };
    const slot = shardSlot(slotName, info);
    if (info.isKey || !slot) {
      plan.unsupported.push({
        ...detail,
        reason: "This shard has no applicable source equipment slot here.",
      });
      continue;
    }
    if (owner.charging_perma_slot) {
      plan.skipped.push({
        ...detail,
        reason:
          "Shards do not contribute while permanent-slot charging is active.",
      });
      continue;
    }
    if (Object.hasOwn(owner, "locked_data_load")) {
      const locks = dictionary(owner.locked_data_load, "Shard slot locks");
      if (Object.hasOwn(locks, slotName)) {
        const lock = dictionary(locks[slotName], `${slotName} lock state`);
        flag(lock, "locked", slotName);
        flag(lock, "visibility_locked", slotName);
        if (lock.locked === true || lock.visibility_locked === true) {
          plan.skipped.push({
            ...detail,
            reason: "This equipment slot is locked or hidden.",
          });
          continue;
        }
      }
    }
    const active = info.effects.filter((effect) =>
      effectActive(effect, slot, owner),
    );
    const targetEffects = active.filter(
      (effect) => effect.stat && effect.target === target,
    );
    if (!targetEffects.length) {
      plan.skipped.push({
        ...detail,
        reason:
          "This stat's effect is inactive in the current slot/link configuration.",
      });
      continue;
    }
    const fields = [
      ...new Set(
        targetEffects
          .filter((effect) => !effect.unsupportedReason)
          .flatMap((effect) => effect.fields),
      ),
    ];
    if (!fields.length) {
      plan.unsupported.push({
        ...detail,
        reason:
          targetEffects[0].unsupportedReason ||
          "This effect has no capped saved authority.",
      });
      continue;
    }
    if (
      fields.some(
        (field) =>
          field !== "resonance" && !info.dissonanceFields.includes(field),
      )
    ) {
      plan.unsupported.push({
        ...detail,
        reason:
          "The source does not apply this dissonance region to this shard.",
      });
      continue;
    }
    if (
      fields.some(
        (field) =>
          !(field === "resonance" ? info.maxResonance : info.maxDissonance),
      )
    ) {
      plan.unsupported.push({
        ...detail,
        reason: "This shard authority has no finite positive source cap.",
      });
      continue;
    }
    detail.fields = fields;
    // Conservatively classify the whole contributor, including colored effects
    // that could be enabled by existing gameplay later. Only relevant fields are
    // actually changed; a Penumbra effect never fabricates Antumbra dissonance.
    if (!select(plan, detail, info.effects, target, includeCoupled)) continue;
    const resonanceCap = cap(info.maxResonance, `${info.name} resonance`);
    bounded(shard.resonance, resonanceCap, `${info.name} resonance`);
    for (const field of fields) {
      const maximum =
        field === "resonance"
          ? resonanceCap
          : cap(info.maxDissonance, `${info.name} dissonance`);
      const exists = Object.hasOwn(shard, field);
      const current = bounded(
        exists ? shard[field] : 0,
        maximum,
        `${info.name} ${field}`,
        field === "resonance",
      );
      if (!exists || current !== maximum)
        plan.changes.push({
          path: [index, "harmony_data", slotName, field],
          value: makeNumeric(String(maximum)),
        });
    }
    for (const effect of active)
      if (effect.fields.some((field) => fields.includes(field)))
        plan.effects.add(effect.name);
  }
  for (const id of candidates) {
    if (!equipped.has(id))
      plan.skipped.push({
        id,
        name: metadata.shards[id].name,
        kind: "shard",
        reason:
          "This shard is not currently equipped; inventory is left unchanged.",
      });
  }
}

export function planNestedBoost(
  records,
  catalog,
  target,
  kind,
  includeCoupled = false,
) {
  if (kind !== "module" && kind !== "shard")
    throw new Error("Choose module or shard authorities.");
  if (typeof includeCoupled !== "boolean")
    throw new Error("Coupled effects must be explicitly selected.");
  if (!Array.isArray(records))
    throw new Error("Save records must be an array.");
  const metadata = catalog.categoryMetadata?.nestedBoosts;
  if (!metadata?.targets?.[target])
    throw new Error(
      `No source-backed nested contributions exist for ${target}.`,
    );
  const plan = {
    changes: [],
    items: [],
    effects: new Set(),
    selected: [],
    coupled: [],
    unsupported: [],
    skipped: [],
  };
  if (kind === "module")
    planModules(records, catalog, target, includeCoupled, metadata, plan);
  else planShards(records, catalog, target, includeCoupled, metadata, plan);
  // No save object was mutated. Callers may apply the complete plan only after
  // this function returns; a malformed later contributor rejects the whole plan.
  return { ...plan, effects: [...plan.effects] };
}
