import { isNumeric, makeNumeric, numericText } from "./codec.js";
import { isIntegerText } from "./resource-amounts.js";

function whole(value, label) {
  const text = numericText(value);
  const number = Number(text);
  if (!isIntegerText(text) || !Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be a nonnegative safe whole number.`);
  return number;
}

export function planCrewMastery(records, catalog) {
  const playerIndex = records.findIndex((r) => r.save_name === "PlayerInfo");
  const crewIndex = records.findIndex((r) => r.save_name === "Crew");
  if (playerIndex < 0 || crewIndex < 0)
    throw new Error("This save needs both PlayerInfo and Crew records.");
  const savedCrew = records[crewIndex].crew_load;
  if (!savedCrew || typeof savedCrew !== "object" || Array.isArray(savedCrew))
    throw new Error("This save has no valid crew_load collection.");
  const costs = catalog.categoryMetadata.crewMastery.upgradeCosts;
  const requiredTotal = Object.values(costs).reduce(
    (sum, cost) => sum + cost,
    0,
  );
  const crew = [];
  for (const id of Object.keys(catalog.categoryMetadata.entities.crew)) {
    if (!Object.hasOwn(savedCrew, id)) continue;
    const member = savedCrew[id];
    if (
      !member ||
      typeof member !== "object" ||
      isNumeric(member) ||
      Array.isArray(member)
    )
      throw new Error(`Invalid saved crew member: ${id}.`);
    const level = whole(
      Object.hasOwn(member, "mastery") ? member.mastery : 0,
      `${id} mastery`,
    );
    crew.push({
      id,
      level,
      original: level,
      unlocked: member.locked === false,
    });
  }
  if (!crew.length)
    throw new Error("This save has no recognized crew members.");
  let total = crew.reduce((sum, member) => sum + member.level, 0);
  if (!Number.isSafeInteger(total))
    throw new Error("Total crew mastery is too large.");
  const eligible = crew.filter((member) => member.unlocked);
  if (total < requiredTotal && !eligible.length)
    throw new Error("Unlock at least one crew member in the game first.");
  // Raise the lowest unlocked mastery first. At most the source upgrade budget
  // is added; never put the generic e307 resource target into crew progression.
  while (total < requiredTotal) {
    const lowest = eligible.reduce((a, b) => (a.level <= b.level ? a : b));
    lowest.level++;
    total++;
  }
  const byName = new Map(records.map((record) => [record.save_name, record]));
  let spent = 0;
  for (const [id, cost] of Object.entries(costs)) {
    const record = byName.get(id);
    if (record && whole(record.amount_have ?? 0, `${id} level`) >= 1)
      spent += cost;
  }
  // Crew.check_mastery_points(): earned mastery minus active-tier upgrades spent.
  const available = Math.max(0, total - spent);
  const changes = crew
    .filter((member) => member.level !== member.original)
    .map((member) => ({
      path: [crewIndex, "crew_load", member.id, "mastery"],
      value: makeNumeric(String(member.level)),
    }));
  const raisedCrew = changes.length;
  const balances = records[playerIndex].resources_load;
  if (
    balances !== undefined &&
    (!balances ||
      typeof balances !== "object" ||
      isNumeric(balances) ||
      Array.isArray(balances))
  )
    throw new Error("This save has no valid resources_load collection.");
  const current =
    balances && Object.hasOwn(balances, "MasteryPoint")
      ? balances.MasteryPoint
      : undefined;
  if (current === undefined || numericText(current) !== String(available))
    changes.push({
      path: [playerIndex, "resources_load", "MasteryPoint"],
      value: makeNumeric(String(available)),
    });
  return {
    changes,
    playerIndex,
    requiredTotal,
    total,
    spent,
    available,
    raisedCrew,
  };
}
