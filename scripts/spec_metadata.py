"""Source-backed fighter specialization funding inputs (no saved-stat shortcuts)."""

from collections import defaultdict
from pathlib import Path
import math
import re


def _whole(value, label, positive=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or int(value) != value
            or value < (1 if positive else 0) or value > 2**53 - 1):
        raise ValueError(f"Unsupported {label}: {value!r}")
    return int(value)


def _scene_nodes(source):
    for path in sorted(source.rglob("*.tscn")):
        if any(part.startswith(".") for part in path.relative_to(source).parts):
            continue
        text = path.read_text()
        for match in re.finditer(r"^\[node ([^\n]+)\]\n(.*?)(?=^\[|\Z)", text, re.M | re.S):
            attrs = dict(re.findall(r'(\w+)="([^"]*)"', match[1]))
            yield path.relative_to(source).as_posix(), attrs, match[2]


def build_spec_metadata(source: Path, tables: dict) -> dict:
    source = Path(source)
    upgrades = {row["id"]: row for sheet in ("upgrades", "upgrades2")
                for row in tables.get(sheet, [])}
    stats = {row["id"]: row for row in tables["stats"]}
    nodes = list(_scene_nodes(source))
    aliases = defaultdict(set)
    for _, attrs, body in nodes:
        match = re.search(r'^UpgradeID = "([^"\n]+)"', body, re.M)
        if match:
            aliases[match[1]].add(attrs["name"])

    def names(identifier):
        # Scene names win over CastleDB IDs: three Warp point sources differ.
        return sorted(aliases[identifier]) or [identifier]

    fighters = []
    for scene, attrs, body in nodes:
        if scene != "interface/compute/ComputeArea.tscn":
            continue
        if not re.search(r"^fighter_version = true$", body, re.M):
            continue
        identifier = re.search(r'^UpgradeID = "([^"\n]+)"', body, re.M)[1]
        row = upgrades[identifier]
        costs = row.get("cost", [])
        effects = row.get("effect", [])
        if (len(costs) != 1 or costs[0].get("type") != 3
                or len(effects) != 1 or costs[0]["cost_base"] <= 0
                or not math.isfinite(costs[0]["cost_base"])
                or costs[0]["cost_growth"] < 2):
            raise ValueError(f"Unsupported fighter compute cost: {identifier}")
        effect = effects[0]
        expression = effect.get("expression", "")
        exponential = re.fullmatch(r"pow\(([\d.]+),\[x\]\)-1", expression)
        linear = re.fullmatch(r"([\d.]+)\*\[x\]", expression)
        if (effect.get("connection_type") != "Self"
                or effect.get("direct_connection") != "tier"
                or effect.get("modifier_type") != "Multiplicative"
                or not (exponential or linear)):
            raise ValueError(f"Unsupported fighter compute effect: {identifier}")
        fighters.append({
            "id": identifier, "saveNames": names(identifier),
            "unlockedByDefault": not bool(row.get("unlock_message")),
            "costBase": costs[0]["cost_base"], "costGrowth": costs[0]["cost_growth"],
            "levelsPerTier": _whole(costs[0]["levels_to_increase"], identifier, True),
            "tierDelayStat": "compute_" + effect["target"] + "_tier_delay",
            "effect": {"kind": "exponential" if exponential else "linear",
                       "factor": float((exponential or linear)[1])},
        })
    if not fighters:
        raise ValueError("No fighter compute scene nodes found")

    specifications = []
    for identifier, row in upgrades.items():
        if row.get("type") != "fighter_spec":
            continue
        costs = row.get("cost", [])
        if (len(costs) != 1 or costs[0].get("resource") != "FighterSpecPoint"
                or costs[0].get("type") != 1 or costs[0].get("precise", False)):
            raise ValueError(f"Unsupported specialization cost: {identifier}")
        specifications.append({
            "id": identifier, "saveNames": names(identifier),
            "maxLevel": _whole(row.get("max_level"), identifier, True),
            "costBase": _whole(costs[0]["cost_base"], identifier, True),
            "costGrowth": _whole(costs[0]["cost_growth"], identifier),
        })
    required_total = sum(s["costBase"] * (s["maxLevel"] + s["costGrowth"]
                         * s["maxLevel"] * (s["maxLevel"] - 1) // 2)
                         for s in specifications)
    _whole(required_total, "specialization budget", True)

    relevant = {"compute_base_spec_points", "compute_tiers_per_spec_point",
                "compute_fighter_tier_scaling_reduction"}
    relevant.update(f["tierDelayStat"] for f in fighters)
    bases = {identifier: stats[identifier]["base"] for identifier in sorted(relevant)}
    grid_sources = defaultdict(list)
    for galaxy in tables.get("fleet_galaxies", []):
        for line in galaxy.get("artifact_upgrades", []):
            for cell in line.get("row", []):
                if "upgrade" in cell:
                    grid_sources[cell["upgrade"]].append({
                        "kind": "level", "saveNames": [galaxy["id"] + "_" + cell["id"]],
                        "maxLevel": cell.get("max_level_override") or upgrades[cell["upgrade"]]["max_level"],
                        "pendingField": "amount_next_reinforce",
                    })

    fleet_text = (source / "fleet/Fleet.gd").read_text()
    event_sources = defaultdict(list)
    for event in tables.get("fleet_events", []):
        rewards = event.get("first_clear_reward", [])
        if not any(any(e.get("target") in relevant for e in upgrades.get(r.get("upgrade"), {}).get("effect", []))
                   for r in rewards):
            continue
        finals = {bool(re.search(r"^final_node = true$", body, re.M))
                  for scene, attrs, body in nodes
                  if scene.startswith("fleet/interface/galaxymaps/") and attrs["name"] == event["id"]}
        if len(finals) != 1:
            raise ValueError(f"Ambiguous fleet event scene: {event['id']}")
        battle = event.get("battle_requirement")
        deferred = False
        if battle:
            setup = re.search(r'"' + re.escape(battle) + r'":\s*\{.*?"fleet_setup":\s*\[(.*?)\n\s*\]\}',
                              fleet_text, re.S)
            if not setup:
                raise ValueError(f"Missing fleet battle: {battle}")
            commands = [ship for ship in re.findall(r'FleetEntry\.new\("([^"]+)"', setup[1]) if "Command" in ship]
            deferred = not next(iter(finals)) and bool(commands) and commands[0] == "EnemyCommandShip"
        for reward in rewards:
            if reward.get("upgrade"):
                event_sources[reward["upgrade"]].append({
                    "kind": "firstClear", "saveNames": [event["id"]],
                    "maxLevel": 1, "deferredUntilGalaxyFinish": deferred,
                })

    contributions = []
    covered_effects = set()
    for sheet in ("upgrades", "upgrades2", "research"):
        for row in tables.get(sheet, []):
            effects = [effect for effect in row.get("effect", []) if effect.get("target") in relevant]
            if not effects:
                continue
            for effect in effects:
                if (effect.get("modifier_type") != "Flat" or effect.get("self_multiplicative")
                        or any(effect.get(key) for key in ("global_hook", "direct_connection", "direct_connection2",
                                                          "connection_type", "expression", "expression_connections"))
                        or not isinstance(effect.get("base_effect"), (int, float))
                        or not math.isfinite(effect["base_effect"])):
                    raise ValueError(f"Unsupported specialization stat effect: {row['id']}")
                covered_effects.add(id(effect))
            if row.get("type") == "fleet":
                sources = grid_sources[row["id"]] + event_sources[row["id"]]
                if not sources:
                    raise ValueError(f"Unknown fleet specialization source: {row['id']}")
            else:
                sources = [{"kind": "level", "saveNames": names(row["id"]),
                            "maxLevel": _whole(row.get("max_level"), row["id"], True)}]
            for storage in sources:
                storage["maxLevel"] = _whole(storage["maxLevel"], row["id"], True)
                contributions.append({
                    "id": row["id"], "group": row["type"], **storage,
                    "effects": [{"stat": e["target"], "perLevel": e["base_effect"]} for e in effects],
                })

    def check_covered(value):
        if isinstance(value, dict):
            target = value.get("target")
            if isinstance(target, str) and target in relevant and "modifier_type" in value and id(value) not in covered_effects:
                raise ValueError(f"Unaccounted specialization stat contribution: {value}")
            for child in value.values():
                check_covered(child)
        elif isinstance(value, list):
            for child in value:
                check_covered(child)

    for sheet, entries in tables.items():
        if "@" not in sheet:
            check_covered(entries)

    enums = (source / "Enums.gd").read_text()
    ship_enum = re.search(r"enum ShipClass\s*\{([^}]+)\}", enums)[1]
    ship_classes = {}
    next_value = 0
    for entry in ship_enum.split(","):
        parts = entry.strip().split("=")
        if not parts[0].strip():
            continue
        if len(parts) == 2:
            next_value = int(parts[1].strip())
        ship_classes[parts[0].strip()] = next_value
        next_value += 1
    return {
        "requiredTotal": required_total, "specifications": specifications,
        "fighters": fighters, "statBases": bases, "contributions": contributions,
        "disabledShips": [r["id"] for r in tables["main_ships"] if r["ship_class"] == ship_classes["TITAN"]],
        "formulas": {
            "earned": "floor(sum(fighter.tier) / compute_tiers_per_spec_point) + compute_base_spec_points",
            "spent": "sum(costBase * (amount_have + costGrowth * amount_have * (amount_have - 1) / 2))",
            "tierCost": "round(costBase * pow(max(costGrowth / compute_fighter_tier_scaling_reduction, 2), max(tier - tierDelay, 0)))",
        },
        "sources": ["interface/compute/ComputeFighters.gd", "interface/compute/ComputeButton.gd",
                    "interface/compute/ComputeArea.tscn", "upgrades/Upgrade.gd", "UpgradeHelper.gd",
                    "PlayerInfo.gd", "Challenges.gd", "fleet/interface/AdjacentUpgradeGrid.gd",
                    "fleet/interface/AdjacentUpgradeButton.gd", "fleet/interface/FleetEvent.gd", "game_data.cdb"],
    }
