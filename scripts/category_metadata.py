"""Source-owned save families and conservative CastleDB action limits."""

from collections import defaultdict
from pathlib import Path
import re

from spec_metadata import build_spec_metadata
from nested_metadata import build_nested_metadata
from recipe_metadata import build_recipe_metadata
from challenge_metadata import build_challenge_metadata


# Scene families are also useful for inherited scripts shared by several systems.
FAMILIES = {
    "interface/achievements/": ("Achievements", "Achievements"),
    "interface/crew/splice/": ("Crew", "Splicing"),
    "interface/crew/": ("Crew", "Crew management"),
    "interface/research/": ("Research", "Research management"),
    "interface/harmony/": ("Inventory", "Void shards"),
    "interface/synth/": ("Inventory", "Synthesis"),
    "interface/core/": ("Inventory", "Cores and ships"),
    "interface/loadouts/": ("Inventory", "Loadouts"),
    "interface/settings/": ("Settings", "Preferences"),
    "interface/power/": ("Progression", "Reactor"),
    "interface/compute/strata/": ("Progression", "Compute strata"),
    "interface/compute/": ("Progression", "Compute"),
    "interface/forward_base/": ("Progression", "Forward bases"),
    "interface/prestige/": ("Progression", "Prestige"),
    "interface/reinforce/": ("Progression", "Reinforcement"),
    "interface/veil_shift/": ("Progression", "Veil shifts"),
    "interface/warp/": ("Progression", "Warp"),
    "interface/titan_weapon/": ("Progression", "Titan weapons"),
    "interface/ai/": ("Progression", "AI upgrades"),
    "interface/events/": ("Progression", "Seasonal events"),
    "fleet/": ("Fleet", "Fleet management"),
    "battle/": ("Progression", "Battle and sectors"),
    "player/": ("Progression", "Player abilities"),
    "background_battle/": ("Progression", "Background battles"),
    "upgrades/": ("Progression", "Upgrades"),
    "purchase/": ("Other", "Purchases"),
}
ROOT_FAMILIES = {
    "PlayerInfo.gd": ("Resources", "Player state"),
    "Modules.gd": ("Inventory", "Synthesis modules"),
    "Recipes.gd": ("Inventory", "Synthesis recipes"),
    "Power.gd": ("Progression", "Power allocation"),
    "Challenges.gd": ("Progression", "Challenges"),
    "VeilController.gd": ("Progression", "Veil progression"),
    "Themes.gd": ("Settings", "Themes and skins"),
    "Dialogue.gd": ("Progression", "Dialogue"),
    "StoredState.gd": ("Other", "Stored state"),
    "HTTPRequestStatTracker.gd": ("Other", "Statistics tracking"),
}
GROUP_NAMES = {
    "ai": "AI upgrades", "ai_capital": "Capital AI", "ai_compute": "Compute AI",
    "ai_fleet": "Fleet AI", "ai_reactor": "Reactor AI", "ai_synth": "Synthesis AI",
    "ai_void": "Void AI", "base": "Forward bases", "core": "Core upgrades",
    "crew_mastery": "Crew mastery", "crew_mastery2": "Crew mastery 2",
    "crew_mastery3": "Crew mastery 3", "crew_mastery_womp": "Crew mastery",
    "void": "Void device", "void_power": "Void power", "recipes": "Recipes",
}


def _humanize(value):
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(value)).replace("_", " ").strip()


def _name(row):
    value = row.get("name") or row.get("id", "Unnamed")
    return re.sub(r"\[/?(?:b|i|u|s|center|left|right|fill|color|font|font_size|url|outline_size|outline_color)(?:=[^\]]*)?\]", "", value).strip()


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _limit(item, name, value):
    if _positive(value):
        item[name] = value


def _family(path):
    if path in ROOT_FAMILIES:
        return ROOT_FAMILIES[path]
    return next((family for prefix, family in FAMILIES.items() if path.startswith(prefix)), None)


def _source_files(source, suffix):
    return sorted(p for p in source.rglob("*" + suffix)
                  if not any(part.startswith(".") for part in p.relative_to(source).parts))


def _record_owners(source):
    """Resolve exact node names, inheritance, instance properties and autoload UIDs.

    Conflicting names are omitted rather than assigning the first scene's family.
    Exported IDs are retained so differently named upgrade instances get their own cap.
    """
    scripts = {p.relative_to(source).as_posix(): p.read_text() for p in _source_files(source, ".gd")}
    classes = {}
    for path, text in scripts.items():
        match = re.search(r"^class_name\s+(\w+)", text, re.M)
        if match:
            classes[match[1]] = path

    def owner(path, seen=None):
        seen = set() if seen is None else seen
        if path not in scripts or path in seen:
            return None
        seen.add(path)
        text = scripts[path]
        if re.search(r"^func (?:save|get_save_data)\(", text, re.M) and '"save_name"' in text:
            return path
        parent = re.search(r'^extends\s+(?:"res://([^"\n]+)"|(\w+))', text, re.M)
        return owner(parent[1] or classes.get(parent[2]), seen) if parent else None

    scenes = {}
    for path in _source_files(source, ".tscn"):
        text = path.read_text()
        refs = {}
        for header in re.findall(r"^\[ext_resource [^\n]+\]", text, re.M):
            attrs = dict(re.findall(r'(\w+)="([^"]*)"', header))
            if "id" in attrs and "path" in attrs:
                refs[attrs["id"]] = attrs["path"].removeprefix("res://")
        nodes = []
        for match in re.finditer(r"^\[node ([^\n]+)\]\n(.*?)(?=^\[|\Z)", text, re.M | re.S):
            attrs = dict(re.findall(r'(\w+)="([^"]*)"', match[1]))
            script = re.search(r'^script = ExtResource\("([^"]+)"\)', match[2], re.M)
            instance = re.search(r'instance=ExtResource\("([^"]+)"\)', match[1])
            props = dict(re.findall(r'^(\w+) = "([^"\n]*)"', match[2], re.M))
            nodes.append((attrs.get("name"), refs.get(script[1]) if script else None,
                          refs.get(instance[1]) if instance else None, props))
        scenes[path.relative_to(source).as_posix()] = nodes

    def scene_root(path, seen=None):
        seen = set() if seen is None else seen
        if path in seen or not scenes.get(path):
            return None, {}
        seen.add(path)
        _, script, instance, props = scenes[path][0]
        inherited_script, inherited_props = scene_root(instance, seen) if instance else (None, {})
        return script or inherited_script, {**inherited_props, **props}

    candidates = defaultdict(set)

    def add(name, path, script, props):
        saved_by = owner(script)
        if not name or not saved_by:
            return
        # Specific scenes disambiguate generic upgrade scripts; settings retain their
        # owner even when embedded inside another system's scene.
        script_family = _family(script) or _family(saved_by)
        scene_family = _family(path)
        family = script_family if script_family and script_family[0] == "Settings" else scene_family or script_family
        family = family or ("Other", _humanize(Path(saved_by).stem))
        candidates[name].add((*family, props.get("UpgradeID", ""), saved_by, props.get("galaxy_id", "")))

    for path, nodes in scenes.items():
        for name, script, instance, props in nodes:
            inherited_script, inherited_props = scene_root(instance) if instance else (None, {})
            add(name, path, script or inherited_script, {**inherited_props, **props})
    uid_paths = {p.read_text().strip(): p.relative_to(source).as_posix()[:-4]
                 for p in _source_files(source, ".gd.uid")}
    project = (source / "project.godot").read_text()
    autoload = re.search(r"^\[autoload\]\n(.*?)(?=^\[|\Z)", project, re.M | re.S)
    if autoload:
        for name, location in re.findall(r'^(\w+)="\*([^"\n]+)"', autoload[1], re.M):
            path = location.removeprefix("res://") if location.startswith("res://") else uid_paths.get(location)
            add(name, path or "", path, {})
    result = {}
    for name, choices in candidates.items():
        families = {(category, group, upgrade) for category, group, upgrade, _, _ in choices}
        if len(families) == 1:
            category, group, upgrade = next(iter(families))
            result[name] = {"category": category, "group": group}
            if upgrade:
                result[name]["upgradeId"] = upgrade
            owners = {choice[3] for choice in choices}
            if len(owners) == 1:
                result[name]["source"] = next(iter(owners))
            galaxies = {choice[4] for choice in choices if choice[4]}
            if len(galaxies) == 1:
                result[name]["galaxyId"] = next(iter(galaxies))
    return result


def build_metadata(source: Path, tables: dict) -> dict:
    records = _record_owners(source)
    entities = {key: {} for key in ("recipes", "modules", "research", "upgrades", "crew",
                                  "crewSkills", "crewUpgrades", "cores", "fleet", "shards", "ships")}
    achievements = {}
    mastery_costs = {}
    quick_upgrades = {target: {} for target in (
        "synth_speed", "fixture_speed", "compute_base_spec_points", "research_datacore_start_with")}
    stats = {row["id"]: row for row in tables.get("stats", [])}
    mechanics = {}
    upgrade_rows = {row["id"]: row for sheet in ("upgrades", "upgrades2") for row in tables.get(sheet, [])}
    ordinary_owners = {"upgrades/LimitedUpgradeButton.gd", "interface/warp/WarpUpgradeButton.gd",
                       "interface/ai/AIUpgrade.gd"}
    owners_by_upgrade = defaultdict(set)
    for save_name, info in records.items():
        if info.get("source"):
            owners_by_upgrade[info.get("upgradeId", save_name)].add(info["source"])
    base_purchases = {u["upgrade"] for base in tables.get("forward_bases", [])
                      for u in base.get("upgrades", [])}

    def mechanic_for(effect):
        target = effect.get("target")
        modifier = effect.get("modifier_type")
        if target in stats and modifier in ("Flat", "Additive", "Multiplicative"):
            identifier, stat = target, stats[target]
        elif modifier == "FormulaModification" and target:
            field = effect.get("mod_target", "")
            identifier = f"formula:{target}:{field}"
            target_name = _name(upgrade_rows[target]) if target in upgrade_rows else target
            stat = {"name": f"{target_name} · {_humanize(field)}",
                    "type": "Cost formulas" if field.startswith("cost_") else "Formula modifiers",
                    "description": "Source formula modification; assignments and progression prerequisites still apply."}
        else:
            return None
        return mechanics.setdefault(identifier, {
            "name": _name(stat), "group": stat.get("type", "Other"),
            "description": stat.get("description", ""), "upgrades": {}, "coupledUpgrades": {},
            "uncapped": [], "unsupported": [], "otherSources": []})
    # IncreaseCap is applied at runtime, not a universal CastleDB ceiling.
    dynamic_caps = set()

    def collect_effects(value):
        if isinstance(value, dict):
            if value.get("modifier_type") == "IncreaseCap":
                dynamic_caps.add(value.get("target"))
            for child in value.values():
                collect_effects(child)
        elif isinstance(value, list):
            for child in value:
                collect_effects(child)

    for sheet, rows in tables.items():
        if "@" not in sheet:
            collect_effects(rows)

    for identifier, row in upgrade_rows.items():
        kind = row.get("type", "")
        item = {"name": _name(row), "group": GROUP_NAMES.get(kind, _humanize(kind).capitalize() or "Other upgrades"), "type": kind}
        # CrewMasteryUpgradeArea.gd instantiates only these three active tiers.
        if kind in ("crew_mastery", "crew_mastery2", "crew_mastery3"):
            costs = row.get("cost", [])
            if (row.get("max_level") != 1 or len(costs) != 1
                    or costs[0].get("resource") != "MasteryPoint"
                    or costs[0].get("type") != 1 or costs[0].get("cost_growth") != 0
                    or not _positive(costs[0].get("cost_base"))
                    or not float(costs[0]["cost_base"]).is_integer()):
                raise ValueError(f"Unsupported crew mastery cost: {identifier}")
            mastery_costs[identifier] = int(costs[0]["cost_base"])
        effects = row.get("effect", [])
        if len(effects) == 1:
            effect = effects[0]
            target = effect.get("target")
            speed = target in ("synth_speed", "fixture_speed") and kind == "synth"
            points = target in ("compute_base_spec_points", "research_datacore_start_with") and kind in ("synth", "warp")
            if speed or points:
                if (identifier in dynamic_caps or not _positive(row.get("max_level"))
                        or effect.get("modifier_type") != ("Multiplicative" if speed else "Flat")
                        or effect.get("direct_connection") or effect.get("expression")):
                    raise ValueError(f"Unsupported focused upgrade: {identifier}")
                quick_upgrades[target][identifier] = int(row["max_level"])
        if identifier in dynamic_caps:
            item["note"] = "The game expands this cap at runtime; no universal maximum is supplied."
        else:
            _limit(item, "maxLevel", row.get("max_level"))
        owners = owners_by_upgrade[identifier]
        dynamic_limited = (kind in ("synth", "crew_mastery", "crew_mastery2", "crew_mastery3",
                                   "splicing_humanity", "splicing_corruption")
                           or re.fullmatch(r"fixture\d*", kind) or identifier in base_purchases)
        item["actionable"] = bool("maxLevel" in item and (
            (owners and owners <= ordinary_owners) or (not owners and dynamic_limited)))
        entities["upgrades"][identifier] = item
        for effect in effects:
            mechanic = mechanic_for(effect)
            if mechanic is None:
                continue
            if item["actionable"]:
                mechanic["upgrades" if len(effects) == 1 else "coupledUpgrades"][identifier] = item["maxLevel"]
            elif "maxLevel" in item:
                if identifier not in mechanic["unsupported"]:
                    mechanic["unsupported"].append(identifier)
            elif identifier not in mechanic["uncapped"]:
                mechanic["uncapped"].append(identifier)
        item["effects"] = list(dict.fromkeys(
            _name(stats[e["target"]]) if e.get("target") in stats
            else f'{e.get("modifier_type", "Effect")}: {e.get("target", "")}'
            for e in effects))
        # Upgrade scenes may place a data family in Crew/Fleet rather than Progression.
        previous = records.get(identifier, {})
        category = previous.get("category", "Progression")
        if category == "Other":
            category = "Progression"
        if kind.startswith("crew") or kind.startswith("splicing"):
            category = "Crew"
        elif kind in ("fleet", "fleet_unstable"):
            category = "Fleet"
        records[identifier] = {**previous, "category": category, "group": item["group"]}

    for save_name, info in records.items():
        identifier = info.get("upgradeId")
        if identifier in entities["upgrades"]:
            entities["upgrades"][save_name] = dict(entities["upgrades"][identifier])

    def nested_effects(value):
        if isinstance(value, dict):
            if "modifier_type" in value and "target" in value:
                yield value
            for child in value.values():
                yield from nested_effects(child)
        elif isinstance(value, list):
            for child in value:
                yield from nested_effects(child)

    for sheet, rows in tables.items():
        if "@" in sheet or sheet in ("upgrades", "upgrades2"):
            continue
        for row in rows:
            seen = set()
            for effect in nested_effects(row):
                mechanic = mechanic_for(effect)
                if mechanic is not None and id(mechanic) not in seen:
                    seen.add(id(mechanic))
                    mechanic["otherSources"].append({"id": row.get("id", ""), "name": _name(row),
                                                     "family": sheet})

    for row in tables.get("recipes", []):
        item = {"name": _name(row), "group": "Alien synthesis" if row.get("alien") else "Standard synthesis",
                "tier": row.get("tier"), "alien": bool(row.get("alien"))}
        _limit(item, "maxLevel", row.get("max_level"))
        entities["recipes"][row["id"]] = item

    for row in tables.get("modules", []):
        item = {"name": _name(row), "group": row.get("slot_type") or "Modules",
                "alien": bool(row.get("alien")), "levelsByTier": {}}
        _limit(item, "maxTier", row.get("max_tier"))
        for tier in row.get("tiers", []):
            if _positive(tier.get("max_level")):
                item["levelsByTier"][str(tier["tier_order"])] = tier["max_level"]
        entities["modules"][row["id"]] = item

    for row in tables.get("research", []):
        method = row.get("method", "")
        item = {"name": _name(row), "group": row.get("type") or "Research", "type": row.get("type", ""),
                "tier": row.get("tier"), "method": method,
                "field": "amount_have" if method == "Level" else "resources_in"}
        if method == "Level":
            _limit(item, "maxLevel", row.get("max_level"))
        elif method != "Unbound":
            item["maxLevel"] = 1
        # ResearchUpgrade.calc_cost can scale cost by its owning area's settings.
        # No universal resources_in cap can be inferred from the row alone.
        entities["research"][row["id"]] = item
        records[row["id"]] = {"category": "Research", "group": item["group"],
                              "source": "interface/research/LevelBasedResearchUpgrade.gd" if method == "Level"
                              else "interface/research/ResearchUpgrade.gd"}
        if row.get("tier") is not None:
            records[row["id"]]["subgroup"] = f"Tier {row['tier']}"

    for row in tables.get("achievements", []):
        item = {"name": _name(row), "category": row.get("category", "Achievements"),
                "group": row.get("category", "Achievements"), "tier": row.get("tier"), "screen": row.get("screen", 0)}
        achievements[row["id"]] = item
        records[row["id"]] = {"category": "Achievements", "group": item["group"],
                              "subgroup": f"Screen {item['screen'] + 1} · Tier {item['tier']}",
                              "source": "interface/achievements/AchievementIcon.gd"}

    for row in tables.get("crew", []):
        entities["crew"][row["id"]] = {"name": _name(row), "group": "Crew members"}
        for stat in row.get("stats", []):
            identifier = stat["stat"]
            entities["crewSkills"][identifier] = {"name": _humanize(identifier)}
        for upgrade in row.get("upgrades", []):
            item = {"name": _name(upgrade)}
            _limit(item, "maxLevel", upgrade.get("max_level"))
            entities["crewUpgrades"][upgrade["id"]] = item

    for row in tables.get("cores", []):
        item = {"name": _name(row), "group": row.get("type") or "Cores"}
        _limit(item, "maxTier", max((tier.get("tier", 0) for tier in row.get("tiers", [])), default=0))
        entities["cores"][row["id"]] = item
    for row in tables.get("void_shards", []):
        item = {"name": _name(row), "group": row.get("slot_type") or "Void shards", "tier": row.get("tier")}
        _limit(item, "maxResonance", row.get("max_resonance"))
        entities["shards"][row["id"]] = item
    for row in tables.get("main_ships", []):
        entities["ships"][row["id"]] = {"name": _name(row), "group": "Main ships"}

    # ForwardBasePanel names dynamically created buildings as base ID + building ID.
    buildings = {row["id"]: row for row in tables.get("base_buildings", [])}
    for base in tables.get("forward_bases", []):
        group = _name(base)
        records[base["id"]] = {"category": "Progression", "group": group,
                               "source": "interface/forward_base/ForwardBasePanel.gd"}
        for item in base.get("buildings", []):
            identifier = base["id"] + item["building"]
            records[identifier] = {"category": "Progression", "group": group,
                                   "subgroup": "Buildings", "source": "interface/forward_base/Building.gd"}
            entities["upgrades"][identifier] = {
                "name": _name(buildings.get(item["building"], {"id": item["building"]})), "group": group}
        for item in base.get("upgrades", []):
            identifier = item["upgrade"]
            records[identifier] = {**records.get(identifier, {}), "category": "Progression",
                                   "group": group, "subgroup": "Upgrades"}

    for row in tables.get("core_milestones", []):
        core = entities["cores"].get(row.get("parent_core"), {})
        records[row["id"]] = {"category": "Progression", "group": "Core milestones",
                              "subgroup": core.get("name", "Core milestones")}

    galaxies = {row["id"]: row for row in tables.get("fleet_galaxies", [])}
    for identifier, row in galaxies.items():
        group = f"Galaxy {identifier.removeprefix('galaxy')} · {_name(row)}"
        entities["fleet"][identifier] = {"name": _name(row), "group": group}
        for save_name, info in records.items():
            if info.get("galaxyId") == identifier:
                info.update(category="Fleet", group=group)
                entities["fleet"][save_name] = {"name": _name(row), "group": group}
        # AdjacentUpgradeGrid creates galaxy_id + '_' + cell.id, not upgrade ID.
        for grid_row in row.get("artifact_upgrades", []):
            for cell in grid_row.get("row", []):
                save_name = f"{identifier}_{cell['id']}"
                upgrade = entities["upgrades"].get(cell.get("upgrade"), {})
                item = {"name": upgrade.get("name", _humanize(cell["id"])), "group": group}
                _limit(item, "maxLevel", cell.get("max_level_override") or upgrade.get("maxLevel"))
                entities["upgrades"][save_name] = item
                records[save_name] = {"category": "Fleet", "group": group, "subgroup": "Artifact upgrades",
                                      "source": "fleet/interface/AdjacentUpgradeButton.gd"}

    for row in tables.get("fleet_events", []):
        identifier = row["id"]
        match = re.match(r"g(\d+)([a-z]*)_", identifier)
        galaxy = "galaxy" + match[1] if match else None
        group = entities["fleet"].get(galaxy, {}).get("group", "Fleet events")
        item = {"name": row.get("long_name") or _name(row), "group": group}
        if galaxy:
            item["galaxy"] = galaxy
        contribution = entities["upgrades"].get(row.get("contribution_upgrade"), {})
        _limit(item, "maxContributionLevel", contribution.get("maxLevel"))
        entities["fleet"][identifier] = item
        records[identifier] = {"category": "Fleet", "group": group, "subgroup": "Events",
                               "source": "fleet/interface/FleetEvent.gd"}

    for row in tables.get("unstable_transit", []):
        save_name = "btnUTLevel" + row["id"]
        item = {"name": _name(row), "group": "Unstable transit"}
        entities["fleet"][save_name] = item
        records[save_name] = {"category": "Fleet", "group": item["group"],
                              "source": "fleet/interface/UTLevelButton.gd"}
    for sheet, group in (("fleet_ships", "Fleet ships"), ("fleet_mods", "Fleet modifications"), ("fleet_abilities", "Fleet abilities")):
        for row in tables.get(sheet, []):
            entities["fleet"][row["id"]] = {"name": _name(row), "group": group}

    return {"records": dict(sorted(records.items())), "entities": entities, "achievements": achievements,
            "crewMastery": {"upgradeCosts": mastery_costs},
            "quickUpgrades": quick_upgrades, "mechanics": mechanics,
            "specPoints": build_spec_metadata(source, tables),
            "nestedBoosts": build_nested_metadata(tables),
            "recipeBoosts": build_recipe_metadata(tables),
            "challengeBoosts": build_challenge_metadata(source, tables)}
