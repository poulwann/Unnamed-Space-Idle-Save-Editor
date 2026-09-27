"""CastleDB-backed authorities for active modules and equipped void shards."""

import math


STAT_MODIFIERS = {"Flat", "Additive", "Multiplicative"}
DISSONANCE_FIELDS = ("antumbra_dissonance", "penumbra_dissonance")


def _whole(value, label):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0 or int(value) != value
            or value > 2**53 - 1):
        raise ValueError(f"Invalid source {label}: {value!r}")
    return int(value)


def build_nested_metadata(tables):
    # Import lazily: category_metadata owns the shared CastleDB label convention
    # and may import this builder while it is itself being initialized.
    from category_metadata import _name

    stats = {row["id"]: row for row in tables.get("stats", [])}
    targets = {}
    modules = {}
    shards = {}
    permanent_types = {row.get("unique_type") for row in tables.get("void_shards", []) if row.get("is_key")}

    def effects(rows, kind):
        result = []
        allowed = {"level"} if kind == "module" else {"resonance", *DISSONANCE_FIELDS}
        for row in rows:
            target = row.get("target", "")
            modifier = row.get("modifier_type", "")
            is_stat = target in stats and modifier in STAT_MODIFIERS
            expression = row.get("expression", "")
            direct = row.get("direct_connection", "")
            second = row.get("direct_connection2", "")
            connection = row.get("connection_type", "")
            item = {
                "target": target,
                "name": _name(stats[target]) if target in stats else f"{modifier}: {target}",
                "modifierType": modifier,
                "stat": is_stat,
                "color": row.get("color", ""),
                "fields": [],
                "baseEffect": row.get("base_effect", 0),
                "expression": expression,
                "connectionType": connection,
                "directConnection": direct,
                "directConnection2": second,
            }
            if not is_stat:
                item["unsupportedReason"] = "This effect changes an unlock or automation, not a numeric stat."
            elif connection in ("Crew", "Dynamic"):
                item["unsupportedReason"] = "This effect depends on external dynamic authorities."
            elif direct:
                if connection != "Self":
                    item["unsupportedReason"] = "This effect depends on an external authority."
                else:
                    for token, field in (("[x]", direct), ("[y]", second)):
                        if token in expression:
                            if field not in allowed:
                                item["unsupportedReason"] = f"Unsupported saved authority: {field}."
                            elif field not in item["fields"]:
                                item["fields"].append(field)
                    if not item["fields"] and "unsupportedReason" not in item:
                        item["unsupportedReason"] = "This effect is fixed by the equipped item, not its saved level."
            elif kind == "module":
                item["fields"] = ["level"]
            else:
                item["unsupportedReason"] = "This effect is fixed by the equipped item, not its saved resonance."
            result.append(item)
        return result

    def index(identifier, item_effects, collection):
        for effect in item_effects:
            if not effect["stat"]:
                continue
            target = effect["target"]
            stat = stats[target]
            entry = targets.setdefault(target, {
                "name": _name(stat), "group": stat.get("type", "Other"),
                "description": stat.get("description", ""), "modules": [], "shards": [],
            })
            if identifier not in entry[collection]:
                entry[collection].append(identifier)

    for row in tables.get("modules", []):
        identifier = row["id"]
        tiers = []
        item = {
            "name": _name(row), "maxTier": _whole(row.get("max_tier", 0), f"{identifier} tier cap"),
            "startTier": _whole(row.get("start_tier", 0), f"{identifier} display tier offset"),
            "tiers": tiers,
        }
        for offset, tier in enumerate(row.get("tiers", []), 1):
            # Saved tiers are one-based array indexes, NOT start_tier + tier.
            order = _whole(tier.get("tier_order"), f"{identifier} tier order")
            if order != offset:
                item["unsupportedReason"] = "Source tier order does not match the module's one-based array indexing."
            tier_effects = effects(tier.get("effect", []), "module")
            tiers.append({
                "tier": order,
                "maxLevel": _whole(tier.get("max_level", 0), f"{identifier} tier {order} level cap"),
                "effects": tier_effects,
            })
            index(identifier, tier_effects, "modules")
        if not item["maxTier"] or item["maxTier"] > len(tiers):
            item["unsupportedReason"] = "Source does not supply a reachable finite module tier cap."
        modules[identifier] = item

    for row in tables.get("void_shards", []):
        identifier = row["id"]
        shard_effects = effects(row.get("effect", []), "shard")
        # HarmonyArea.get_shard_dissonance_regions checks direct_connection,
        # not shard tier, slot color, or whether a dissonance field already exists.
        regions = [field for field in DISSONANCE_FIELDS
                   if any(effect.get("direct_connection") == field for effect in row.get("effect", []))]
        item = {
            "name": _name(row), "tier": _whole(row.get("tier", 0), f"{identifier} tier"),
            "maxResonance": _whole(row.get("max_resonance", 0), f"{identifier} resonance cap"),
            "maxDissonance": _whole(row.get("max_dissonance", 0), f"{identifier} dissonance cap"),
            "slotTypes": row.get("slot_type", "").split(","),
            "uniqueType": row.get("unique_type", ""), "isKey": bool(row.get("is_key")),
            "permanentSlot": f'Perma{row.get("unique_type", "")}' if row.get("unique_type") in permanent_types else "",
            "dissonanceFields": regions, "effects": shard_effects,
        }
        shards[identifier] = item
        index(identifier, shard_effects, "shards")

    return {"targets": targets, "modules": modules, "shards": shards}
