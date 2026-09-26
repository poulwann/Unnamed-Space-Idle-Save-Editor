#!/usr/bin/env python3
"""Extract editor metadata from recovered CastleDB data and Godot save owners."""

import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
from category_metadata import build_metadata


CATEGORIES = ["Resources", "Achievements", "Inventory", "Progression", "Crew", "Fleet", "Research", "Settings", "Other"]
SHEET_CATEGORIES = {
    "resources": "Resources", "achievements": "Achievements",
    "main_ships": "Inventory", "cores": "Inventory", "weapons": "Inventory",
    "recipes": "Inventory", "modules": "Inventory", "void_shards": "Inventory",
    "crew": "Crew", "crew_group": "Crew", "splicing": "Crew",
    "research": "Research", "fleet_abilities": "Fleet", "fleet_ships": "Fleet",
    "fleet_mods": "Fleet", "fleet_galaxies": "Fleet", "fleet_events": "Fleet",
    "unstable_transit": "Fleet",
}
ROOT_CATEGORIES = {
    "PlayerInfo.gd": "Resources", "Modules.gd": "Inventory", "Recipes.gd": "Inventory",
    "Power.gd": "Progression", "Challenges.gd": "Progression", "VeilController.gd": "Progression",
    "Themes.gd": "Settings", "Dialogue.gd": "Progression",
}
PATH_CATEGORIES = {
    "fleet/": "Fleet", "interface/achievements/": "Achievements",
    "interface/crew/": "Crew", "interface/research/": "Research",
    "interface/harmony/": "Inventory", "interface/synth/": "Inventory",
    "interface/core/": "Inventory", "interface/loadouts/": "Inventory",
    "interface/power/": "Progression", "interface/compute/": "Progression",
    "interface/forward_base/": "Progression", "interface/prestige/": "Progression",
    "interface/reinforce/": "Progression", "interface/veil_shift/": "Progression",
    "interface/warp/": "Progression", "interface/titan_weapon/": "Progression",
    "interface/ai/": "Progression", "interface/events/": "Progression",
    "upgrades/": "Progression", "battle/": "Progression", "player/": "Progression",
    "background_battle/": "Progression", "interface/settings/": "Settings",
}
FIELD_LABELS = {
    "resources_load": ("Resource balances", "Spendable resource amounts, keyed by resource ID.", "Resources"),
    "resource_totals_gained_load": ("Lifetime resource gains", "Cumulative gains; distinct from current spendable balances.", "Resources"),
    "recipes_load": ("Synthesis recipes", "Recipe ID to locked, level, num_crafted_this_level, next_level_at, cost and result_amount.", "Inventory"),
    "modules_load": ("Synthesis modules", "Module ID to locked, level, tier, active and removed.", "Inventory"),
    "inventory_data": ("Shard inventory", "Slot name to null or a shard object; name is the shard ID, resonance is its level, protect prevents disposal.", "Inventory"),
    "harmony_data": ("Equipped shards", "Equipment-slot name to null or a shard object.", "Inventory"),
    "cores": ("Equipped cores", "Ordered core objects including core_id and tier; preserve other saved properties.", "Inventory"),
    "cores_info_load": ("Core unlocks and tiers", "Core ID to unlock and tier state.", "Inventory"),
    "ships_load": ("Ship unlocks", "Main-ship ID to its saved unlock state.", "Inventory"),
    "crew_load": ("Crew members", "Crew ID to rank, stats, upgrades and automation state; nested upgrades store level.", "Crew"),
    "amount_have": ("Amount / level", "For achievements only: 0 means incomplete and 1 means complete. Loading completed achievements does not grant AI points or extra rewards.", "Progression"),
    "save_name": ("Save record ID", "Exact game node name used to locate the record during loading; do not rename casually.", "Other"),
}


def humanize(value):
    value = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", str(value))
    return value.replace("_", " ").strip() or "Unnamed"


def plain(value):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\[/?(?:b|i|u|s|center|left|right|fill|color|font|font_size|url|outline_size|outline_color)(?:=[^\]]*)?\]", "", value).strip()


def category_for_path(path):
    if path in ROOT_CATEGORIES:
        return ROOT_CATEGORIES[path]
    for prefix, category in PATH_CATEGORIES.items():
        if path.startswith(prefix):
            return category
    return None


def source_files(source, suffix):
    return sorted(p for p in source.rglob("*" + suffix)
                  if not any(part.startswith(".") for part in p.relative_to(source).parts))


def record_categories(source, tables):
    """Resolve persisted scripts through scene instances and script inheritance.

    Ambiguous node names are deliberately omitted, not assigned an arbitrary category.
    Data IDs below are used only for families whose creation code sets the node name
    to that ID (AchievementsArea, ResearchUpgradeArea, FleetEvent, upgrade areas).
    """
    scripts = {p.relative_to(source).as_posix(): p.read_text() for p in source_files(source, ".gd")}
    classes = {}
    for path, text in scripts.items():
        match = re.search(r"^class_name\s+(\w+)", text, re.M)
        if match:
            classes[match[1]] = path
    uid_paths = {p.read_text().strip(): p.relative_to(source).as_posix()[:-4]
                 for p in source_files(source, ".gd.uid")}

    def resolve_script(path, seen=None):
        seen = set() if seen is None else seen
        if path in seen or path not in scripts:
            return None
        seen.add(path)
        text = scripts[path]
        if re.search(r"^func (?:save|get_save_data)\(", text, re.M) and '"save_name"' in text:
            return path
        match = re.search(r'^extends\s+(?:"res://([^"\n]+)"|(\w+))', text, re.M)
        if match:
            parent = match[1] or classes.get(match[2])
            if parent:
                return resolve_script(parent, seen)
        return None

    scenes = {}
    for path in source_files(source, ".tscn"):
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
            nodes.append((attrs.get("name"), refs.get(script[1]) if script else None,
                          refs.get(instance[1]) if instance else None))
        scenes[path.relative_to(source).as_posix()] = nodes

    def scene_script(path, seen=None):
        seen = set() if seen is None else seen
        if path in seen or not scenes.get(path):
            return None
        seen.add(path)
        _, script, instance = scenes[path][0]
        return script or (scene_script(instance, seen) if instance else None)

    candidates = defaultdict(set)
    for path, nodes in scenes.items():
        for name, script, instance in nodes:
            script = script or (scene_script(instance) if instance else None)
            owner = resolve_script(script)
            if owner:
                category = category_for_path(path) or category_for_path(script) or category_for_path(owner)
                if category and name:
                    candidates[name].add(category)

    project = (source / "project.godot").read_text()
    autoload = re.search(r"^\[autoload\]\n(.*?)(?=^\[|\Z)", project, re.M | re.S)
    if autoload:
        for name, location in re.findall(r'^(\w+)="\*([^"\n]+)"', autoload[1], re.M):
            path = location.removeprefix("res://") if location.startswith("res://") else uid_paths.get(location)
            owner = resolve_script(path)
            category = category_for_path(path) if path else None
            if owner and category:
                candidates[name].add(category)

    result = {name: next(iter(categories)) for name, categories in candidates.items() if len(categories) == 1}
    # Direct ID naming: AchievementsArea.gd:19, ResearchUpgradeArea.gd:290,
    # FleetEvent.gd:104, CoreMilestoneIcon.gd:57, LimitedUpgradeArea.gd:39,
    # GridAccumulationUpgrades.gd:23. Core upgrades with slot suffixes are not guessed.
    for sheet, category in [("upgrades", "Progression"), ("upgrades2", "Progression"),
                            ("core_milestones", "Progression"), ("research", "Research"),
                            ("fleet_events", "Fleet"), ("achievements", "Achievements")]:
        for row in tables.get(sheet, []):
            result[row["id"]] = category
    # UTLevelButton.gd:21 explicitly prefixes its data ID.
    for row in tables.get("unstable_transit", []):
        result["btnUTLevel" + row["id"]] = "Fleet"
    return dict(sorted(result.items()))


def resource_catalog(tables):
    """Group synthesis by recipes, then retain the remaining CastleDB types."""
    recipes = {row["result"]: row for row in tables["recipes"] if row.get("result_type") == "resource"}
    inputs = {
        result: list(dict.fromkeys(cost["resource"] for cost in recipe.get("cost", [])
                                   if cost["resource"] != "Time"))
        for result, recipe in recipes.items()
    }
    used_by = defaultdict(list)
    for result, ingredients in inputs.items():
        for ingredient in ingredients:
            used_by[ingredient].append(result)
    raw_inputs = used_by.keys() - recipes.keys()
    type_names = {
        "Dropped": "Dropped resources", "Power": "Power", "Time": "Time",
        "Synth Point": "Synthesis points", "Fixture Point": "Fixture points", "AI Point": "AI points",
        "Consumable": "Consumables", "Research": "Research", "Prestige": "Prestige",
        "Reinforce": "Reinforcement", "Base": "Base materials", "Warp": "Warp", "Crew": "Crew",
        "Spacemas": "Spacemas", "Spaceversary": "Spaceversary", "Spacezard": "Spacezard",
        "Fighters": "Fighters", "Compute": "Compute", "Fleet": "Fleet", "Specimen": "Specimens",
    }

    def type_name(resource_type):
        galaxy = re.fullmatch(r"Galaxy(\d+)", resource_type)
        return f"Galaxy {int(galaxy[1])}" if galaxy else type_names.get(resource_type, humanize(resource_type))

    def type_id(resource_type):
        return "type-" + re.sub(r"[^a-z0-9]+", "-", resource_type.lower()).strip("-")

    resources = []
    for row in tables["resources"]:
        identifier = row["id"]
        recipe = recipes.get(identifier)
        alien = bool(recipe and recipe.get("alien", False))
        role = ("Alien synthesis material" if alien else "Standard synthesis material") if recipe else (
            "Raw synthesis ingredient" if identifier in raw_inputs else type_name(row["type"]))
        resources.append({
            "id": identifier, "name": plain(row.get("name")) or humanize(identifier),
            "description": plain(row.get("description")) or plain(recipe.get("description") if recipe else None),
            "type": row["type"], "tier": row["tier"], "recipeId": recipe["id"] if recipe else None,
            "alien": alien, "inputs": inputs.get(identifier, []), "usedBy": used_by.get(identifier, []),
            "role": role,
        })

    groups = []

    def add_group(identifier, name, description, members, by_tier=False):
        subgroups = {}
        for item in members:
            key = recipes[item["id"]]["tier"] if by_tier else item["type"]
            subgroups.setdefault(key, []).append(item["id"])
        if by_tier:
            keys = sorted(subgroups)
        else:
            # Preserve source type order, except numbered galaxies must sort numerically.
            keys = [key for key in subgroups if not re.fullmatch(r"Galaxy\d+", key)]
            keys += sorted((key for key in subgroups if re.fullmatch(r"Galaxy\d+", key)),
                           key=lambda key: int(key[6:]))
        if subgroups:
            groups.append({
                "id": identifier, "name": name, "description": description,
                "subgroups": [
                    {"id": f"{identifier}-tier-{key}" if by_tier else f"{identifier}-{type_id(key)}",
                     "name": f"Tier {key}" if by_tier else type_name(key), "resourceIds": subgroups[key]}
                    for key in keys
                ],
            })

    add_group("raw-materials", "Raw synthesis ingredients",
              "Recipe inputs that are not produced by any synthesis recipe. Recipe time is excluded.",
              (item for item in resources if item["id"] in raw_inputs))
    add_group("synthesis", "Standard synthesis materials",
              "Resource outputs of non-alien synthesis recipes, grouped by recipe tier.",
              (item for item in resources if item["recipeId"] and not item["alien"]), by_tier=True)
    add_group("alien-synthesis", "Alien synthesis materials",
              "Resource outputs of alien synthesis recipes, grouped by recipe tier.",
              (item for item in resources if item["recipeId"] and item["alien"]), by_tier=True)
    remaining = {}
    for item in resources:
        if item["recipeId"] or item["id"] in raw_inputs:
            continue
        resource_type = item["type"]
        if resource_type in ("Synth Point", "Fixture Point", "AI Point"):
            key = "Points"
        elif resource_type == "Fleet" or re.fullmatch(r"Galaxy\d+", resource_type):
            key = "Fleet"
        else:
            key = resource_type
        remaining.setdefault(key, []).append(item)
    for resource_type, members in remaining.items():
        add_group(type_id(resource_type), type_name(resource_type),
                  "Remaining resources grouped by their CastleDB resource type.", members)
    return resources, groups


def build(source):
    sheets = json.loads((source / "game_data.cdb").read_text())["sheets"]
    tables = {sheet["name"]: sheet.get("lines", []) for sheet in sheets}
    labels = {}

    def add_rows(rows, category):
        for row in rows:
            if not isinstance(row, dict):
                continue
            identifier = row.get("id")
            if isinstance(identifier, str) and identifier:
                name = plain(row.get("name")) or plain(row.get("description")) or humanize(identifier)
                description = plain(row.get("description"))
                previous = labels.get(identifier)
                if previous is None:
                    labels[identifier] = {"name": name, "description": description, "category": category}
                elif not previous["description"] and description:
                    previous["description"] = description
            for value in row.values():
                if isinstance(value, list):
                    add_rows(value, category)

    # Prioritize player-facing inventory names when IDs occur in multiple sheets.
    priority = ["resources", "achievements", "cores", "modules", "recipes", "void_shards",
                "main_ships", "fleet_ships", "fleet_mods", "crew", "crew_group", "splicing"]
    ordered = priority + [name for name in tables if name not in priority and "@" not in name]
    for name in ordered:
        add_rows(tables.get(name, []), SHEET_CATEGORIES.get(name, "Progression"))

    resources, resource_groups = resource_catalog(tables)
    for item in resources:
        labels[item["id"]] = {"name": item["name"], "description": item["description"], "category": "Resources"}
    achievements = [{"id": row["id"], "name": plain(row.get("name")) or humanize(row["id"]),
                     "description": plain(row.get("description")), "ai_points": row.get("ai_points", 0)}
                    for row in tables["achievements"]]
    for identifier, (name, description, category) in FIELD_LABELS.items():
        labels.setdefault(identifier, {"name": name, "description": description, "category": category})
    options = {name: [{"id": row["id"], "name": plain(row.get("name")) or humanize(row["id"])}
                      for row in tables[name]]
               for name in ("void_shards", "cores", "main_ships", "resources")}
    return {"achievements": achievements, "resources": resources, "resourceGroups": resource_groups,
            "labels": dict(sorted(labels.items())),
            "recordCategories": record_categories(source, tables), "categories": CATEGORIES,
            "options": options, "categoryMetadata": build_metadata(source, tables)}


def main():
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True,
                        help="Path to a separately recovered Godot project; not needed for normal editor builds.")
    parser.add_argument("--output", type=Path, default=project / "src/catalog.json")
    args = parser.parse_args()
    catalog = build(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Generated {args.output}: {len(catalog['achievements'])} achievements, "
          f"{len(catalog['resources'])} resources, {len(catalog['labels'])} labels, "
          f"{len(catalog['recordCategories'])} record categories")
    for group in catalog["resourceGroups"]:
        print(f"  {group['name']}: {sum(len(subgroup['resourceIds']) for subgroup in group['subgroups'])} resources, "
              f"{len(group['subgroups'])} subgroups")


if __name__ == "__main__":
    main()
