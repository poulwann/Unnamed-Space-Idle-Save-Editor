"""Recipe-level boost choices derived from CastleDB and Recipes.gd."""

import math


MODES = ("materialCosts", "craftTime", "output", "fixturePoints")


def _whole(value, label):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0 or int(value) != value
            or value > 2**53 - 1):
        raise ValueError(f"{label} must be a nonnegative safe whole number")
    return int(value)


def build_recipe_metadata(tables):
    """Return categoryMetadata.recipeBoosts; the caller owns catalog assembly."""
    recipes = []
    seen = set()
    for row in tables["recipes"]:
        identifier = row["id"]
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            raise ValueError("Recipe IDs must be unique nonempty strings")
        seen.add(identifier)
        cap = _whole(row["max_level"], f"{identifier} maximum level")
        fixture_rate = _whole(row["fixture_points_per_level"], f"{identifier} fixture points")
        synth_rate = _whole(row["synth_points_per_level"], f"{identifier} synth points")
        if not isinstance(row["alien"], bool):
            raise ValueError(f"{identifier} alien flag must be boolean")
        rewards = []
        for reward in row["level_rewards"]:
            level = _whole(reward["level"], f"{identifier} reward level")
            amount = reward["amount"]
            if (isinstance(amount, bool) or not isinstance(amount, (int, float))
                    or not math.isfinite(amount)):
                raise ValueError(f"{identifier} reward amount must be finite")
            if reward["type"] in ("SynthPoints", "FixturePoints"):
                _whole(amount, f"{identifier} point reward")
            rewards.append({"level": level, "type": reward["type"],
                            "amount": amount, "target": reward.get("target", "")})
        costs = [{"resource": cost["resource"], "amount": cost["amount"]}
                 for cost in row["cost"]]
        resources = {cost["resource"] for cost in costs}
        reachable = [reward for reward in rewards if reward["level"] <= cap]
        reductions = [reward for reward in reachable
                      if reward["type"] in ("SubtractCost", "DivideCost")
                      and reward["target"] in resources]
        supported = {
            "materialCosts": any(reward["target"] != "Time" for reward in reductions),
            "craftTime": any(reward["target"] == "Time" for reward in reductions),
            "output": any(reward["type"] == "IncreaseOutput" for reward in reachable),
            # set_fixture_points excludes alien recipes, including their rewards.
            "fixturePoints": not row["alien"] and (fixture_rate > 0 or any(
                reward["type"] == "FixturePoints" for reward in reachable)),
        }
        recipes.append({
            "id": identifier, "name": row.get("name") or identifier,
            "maxLevel": cap, "alien": row["alien"],
            "synthPointsPerLevel": synth_rate, "fixturePointsPerLevel": fixture_rate,
            "costs": costs, "resultAmount": row["result_amount"], "rewards": rewards,
            "modes": [mode for mode in MODES if supported[mode]],
        })
    return {"source": "Recipes.gd", "saveName": "Recipes", "collection": "recipes_load",
            "modes": list(MODES), "recipes": recipes}
