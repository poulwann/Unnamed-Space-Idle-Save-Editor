import { makeNumeric, numericText } from "./codec.js";
import { isIntegerText } from "./resource-amounts.js";

function whole(value, label) {
  const text = numericText(value);
  const number = Number(text);
  if (!isIntegerText(text) || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be a nonnegative safe whole number.`);
  return number;
}

export function savedUpgradeId(record, catalog) {
  return (
    catalog.categoryMetadata.records[record.save_name]?.upgradeId ||
    record.save_name
  );
}

export function planUpgradeMaximum(records, catalog, limits) {
  const changes = [];
  const upgrades = [];
  const effects = new Set();
  let eligible = 0;
  let locked = 0;
  for (const [index, record] of records.entries()) {
    const id = savedUpgradeId(record, catalog);
    if (!catalog.categoryMetadata.entities.upgrades[id]?.actionable) continue;
    if (!Object.hasOwn(limits, id)) continue;
    if (record.unlocked === false) {
      locked++;
      continue;
    }
    // These actions only handle ordinary saved upgrade counters, never nested
    // core/research/fleet progression with its own cap and loading semantics.
    if (
      !Object.hasOwn(record, "amount_have") ||
      !Object.hasOwn(record, "amount_purchased")
    )
      continue;
    eligible++;
    const level = Math.max(
      limits[id],
      whole(record.amount_have, `${id} level`),
      whole(record.amount_purchased, `${id} purchased level`),
    );
    const before = changes.length;
    for (const field of ["amount_have", "amount_purchased"]) {
      if (whole(record[field], `${id} ${field}`) !== level)
        changes.push({
          path: [index, field],
          value: makeNumeric(String(level)),
        });
    }
    if (changes.length !== before) {
      const metadata = catalog.categoryMetadata.entities.upgrades[id];
      upgrades.push({ id, name: metadata?.name || id, level });
      for (const effect of metadata?.effects || []) effects.add(effect);
    }
  }
  if (!eligible)
    throw new Error(
      "No unlocked, saved upgrades with supported counters in this group. Missing and locked upgrades are not granted.",
    );
  return { changes, upgrades, locked, effects: [...effects] };
}
