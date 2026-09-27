"""Challenge completion authorities and rewards from CastleDB and Godot source."""

import math
from pathlib import Path
import re


CHALLENGE_IDS = ("compute_challenge", "synth_challenge", "power_challenge", "base_challenge")


def _finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid source {label}: {value!r}")
    return value


def _whole(value, label):
    _finite(value, label)
    if value < 0 or int(value) != value or value > 2**53 - 1:
        raise ValueError(f"Invalid source {label}: {value!r}")
    return int(value)


def build_challenge_metadata(source, tables):
    """Return categoryMetadata.challengeBoosts, without changing the catalog."""
    from category_metadata import _name

    source = Path(source)
    # These source invariants make CastleDB IDs exact save names and the target
    # count the persistent cap, not an editor-selected completion ceiling.
    required = {
        "interface/prestige/ChallengeArea.gd": ("cb.set_name(c.id)",),
        "interface/prestige/ChallengeSelectButton.gd": (
            '"num_completions": num_completions', '"amount_have": amount_have',
            '"highest_target": highest_target', '"locked": locked',
            "amount_have = len(stats.targets)", "num_completions = amount_have",
            "UpgradeHelper.process_upgrade(self, num_completions)",
            "s.id in PlayerInfo.sectors_cleared_this_reinforce and s.order >= stats.unlocks_at",
        ),
        "Challenges.gd": ('"challenge_active": challenge_active',
                          '"current_challenge": current_challenge'),
        "UpgradeHelper.gd": (
            'e["total_effect"] = pow(1 + e.base_effect, amount_indicator) - 1',
            'e["total_effect"] += 1',
            'PlayerInfo.upgrades[e.target][e.mod_target] = e.formula_mod + e.expression',
        ),
    }
    for relative, snippets in required.items():
        text = (source / relative).read_text()
        if any(snippet not in text for snippet in snippets):
            raise ValueError(f"Unsupported challenge reconstruction in {relative}")

    challenge_rows = {row["id"]: row for row in tables["challenges"]}
    if len(challenge_rows) != len(tables["challenges"]):
        raise ValueError("Duplicate CastleDB challenge IDs")
    stats = {row["id"]: row for row in tables["stats"]}
    boosts = {row["id"]: row for row in tables["power_boosts"]}
    exponents = {float(match[1])
                 for sheet in ("upgrades", "upgrades2")
                 for row in tables.get(sheet, []) if row.get("type") == "compute"
                 for effect in row.get("effect", [])
                 for match in re.finditer(r",([\d.]+)\[m1\]", effect.get("expression", ""))}
    if len(exponents) != 1:
        raise ValueError("Ambiguous base compute exponent")
    compute_exponent = exponents.pop()
    challenges = []
    for identifier in CHALLENGE_IDS:
        row = challenge_rows[identifier]
        targets = [_whole(entry["target"], f"{identifier} target") for entry in row["targets"]]
        if not targets or targets[0] <= 0 or any(a >= b for a, b in zip(targets, targets[1:])):
            raise ValueError(f"Unsupported challenge targets: {identifier}")
        count = len(targets)
        effects = []
        descriptions = []
        for effect in row["effect"]:
            target = effect["target"]
            base = _finite(effect["base_effect"], f"{identifier} base effect")
            item = {"target": target, "modifierType": effect["modifier_type"], "baseEffect": base}
            if (effect["modifier_type"] == "Multiplicative" and effect["self_multiplicative"]
                    and not any(effect.get(key) for key in (
                        "direct_connection", "direct_connection2", "connection_type", "expression"))):
                factor = 1 + base
                if factor <= 0 or target not in stats:
                    raise ValueError(f"Unsupported challenge multiplier: {identifier}/{target}")
                maximum = _finite(factor ** count, f"{identifier} maximum reward")
                item.update(kind="multiplier", name=_name(stats[target]), factor=factor,
                            formula="(1 + baseEffect) ** completions", maximum=maximum,
                            statBase=_finite(stats[target]["base"], f"{target} base"))
                descriptions.append(f"{item['name']}: challenge contribution ×{maximum:g} ({factor:g}^{count}).")
            elif (effect["modifier_type"] == "FormulaModification" and target == "group:compute"
                    and effect["connection_type"] == "Self"
                    and effect["direct_connection"] == "num_completions"
                    and effect["formula_mod"] == "+" and effect["mod_target"] == "m1"):
                match = re.fullmatch(r"\(([\d.]+)\*\[x\]\)", effect["expression"])
                if not match or float(match[1]) != base:
                    raise ValueError("Unsupported compute challenge exponent formula")
                maximum = base * count
                item.update(kind="exponentIncrement", name="Compute exponent", perCompletion=base,
                            formula="baseExponent + perCompletion * completions", maximum=maximum,
                            baseExponent=compute_exponent, maximumExponent=compute_exponent + maximum)
                descriptions.append(f"Compute exponent: {compute_exponent:g} + {base:g} × {count} = {item['maximumExponent']:g}.")
            elif (effect["modifier_type"] == "FormulaModification" and target in boosts
                    and effect["mod_target"] == "cost_mod_growth" and effect["formula_mod"] == "-"
                    and not effect["direct_connection"] and not effect["direct_connection2"]
                    and re.fullmatch(r"[\d.]+", effect["expression"])):
                reduction = _finite(float(effect["expression"]), f"{target} growth reduction")
                growths = [_finite(cost["cost_growth"], f"{target} cost growth") for cost in boosts[target]["cost"]]
                if not growths or any(growth <= reduction for growth in growths):
                    raise ValueError(f"Unsupported reactor boost growth: {target}")
                # UpgradeHelper.process_upgrade assigns this literal even at zero
                # completions. It is NOT -0.1 per tier, nor a -0.5 reward at five.
                item.update(kind="formulaModification", name=_name(boosts[target]),
                            modTarget=effect["mod_target"], formulaMod=effect["formula_mod"],
                            expression=effect["expression"], maximum=reduction,
                            completionDependent=False, baseGrowths=growths,
                            modifiedGrowths=[growth - reduction for growth in growths])
            else:
                raise ValueError(f"Unsupported challenge reward: {identifier}/{target}")
            effects.append(item)

        if identifier == "synth_challenge":
            descriptions.append("Synth Purity necessarily changes both synthesis XP and output. Alien recipes ignore these two normal-synthesis stats.")
        elif identifier == "power_challenge":
            descriptions.append("Drain uses base drain × (1 + drain-scaling stat)^(active level - 1) × running penalty; the reward scales that stat, not the entire drain directly. Engine Boost is excluded from the level-cost divider.")
            descriptions.append("The six non-engine reactor boosts also receive the source's literal -0.1 cost-growth patch (1.5 → 1.4). This patch is assigned even at zero completions, not accumulated per completion.")
        elif identifier == "base_challenge":
            descriptions.append("Only buildings with base_divider_effects use this cost divider; Fleet-base buildings use their separate base6 divider.")
        challenges.append({
            "id": identifier, "name": _name(row), "saveName": identifier,
            "maxCompletions": count, "targetCeiling": targets[-1], "targets": targets,
            "unlocksAt": _whole(row["unlocks_at"], f"{identifier} unlock sector"),
            "effects": effects, "descriptions": descriptions,
            "rewardDetails": [entry["description"].replace("\\n", "\n") for entry in row["effect_text"]],
        })

    return {
        "source": "interface/prestige/ChallengeSelectButton.gd",
        "activeSaveName": "Challenges", "playerSaveName": "PlayerInfo",
        "unlockHistoryField": "sectors_cleared_this_reinforce",
        "completionFields": ["amount_have", "num_completions"], "highestTargetField": "highest_target",
        "sectorOrders": {row["id"]: _whole(row["order"], f"{row['id']} sector order")
                         for row in tables["sectors"]},
        "challenges": challenges,
        "reconstruction": "SaveLoad assigns saved fields, then the challenge button clamps completions and raises highest_target to the completed tier. Rewards and total challenges_completed are recalculated during loading; no cached PlayerInfo stats or total need editing.",
    }
