You can use the editor here: https://poulwann.github.io/Unnamed-Space-Idle-Save-Editor/

## Individual resource maxima

In **Resources**, use **Max balance** on the particular material or currency you
want to change. The former combined synth and warp/base presets are now separate
per-resource actions. Coverage includes synthesis materials and ingredients,
Salvage, Void Matter, Void Energy, Synth Points, warp currencies, base materials,
components, and their supported banked balances.

Each balance action fills only that resource to `1.7976931348623157e307`, adds a
missing balance, and never lowers a higher one. Other balances, layouts, upgrades,
unlocks, and lifetime totals remain unchanged. Confirmation and one-step undo
apply. This is an editor ceiling, **not a safe gameplay maximum**: subsequent
calculations can overflow.

## Focused speeds, points, and recipe progression

Open **Resources → Focused actions** for independent controls:

| Control                         | Source-backed change                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Synth speed upgrades            | Cap the nine dedicated Synth-category speed upgrades that are already available. Their combined multiplier from zero is about ×30.899. |
| Fixture speed upgrades          | Cap four dedicated upgrades; their combined multiplier from zero is ×16.                                                               |
| Starting specialization bonuses | Cap six single-effect upgrades, granting up to 15 additional starting points.                                                          |
| Full specialization funding     | Raise unlocked fighter compute tiers to support the full 255-point specialization budget, then reconcile unspent points.               |
| Starting Data Core bonuses      | Cap five ordinary warp upgrades, granting up to 21 additional starting cores.                                                          |
| Synth Points                    | Fill this balance alone to the resource editor ceiling.                                                                                |
| Recipe material costs           | Raise relevant unlocked recipe levels to their source limits.                                                                          |
| Recipe craft time               | Independently select recipes with time-reduction rewards.                                                                              |
| Recipe output                   | Independently select recipes with output-increase rewards.                                                                             |
| Earned Fixture Points           | Cap eligible unlocked non-alien recipes and reconcile points from levels and reached point rewards.                                    |

These actions edit the saved authorities used by the game, not an invented
`PlayerInfo.stats` value or the unused upgrade `effect_multiplier` field.
Missing or locked upgrades are not created or unlocked.

Specialization points are recomputed as
`floor(total fighter tiers / tiers per point) + starting points - spent points`.
Funding preserves purchased specializations, allocations, and ongoing progress.
It uses the current source-derived divisor and bonuses; it refuses states that
cannot reach the budget while keeping fighter costs and tier work finite.
It does not manufacture prerequisite research or support disabled Titan fighter
specialization. Five points already spent leave 250 available when the earned
total is 255.

Data Cores are also derived: starting bonuses plus eligible cleared sectors,
minus allocations unless universal cores are active. The starting-bonus action
does not overwrite sector history or research allocations. An enormous raw
`ResearchDataCore` balance would be overwritten and can stall auto-allocation.

Recipe levels are a shared authority. Material-cost, time, and output selections
are separate, but raising a recipe can also grant its other level rewards,
including unlocks. The preview lists these coupled rewards. Cached costs and
output, craft progress, and historical Synth Point awards are not fabricated.
Fixture Points use the game's recalculation formula; reconciliation can lower
the current balance. Ordinary loading does not always recalculate these points.

## Boosts and costs

**Boosts & costs** indexes 391 source-defined mechanics in the recovered data.
Search accepts mechanic names, IDs, and contributing source names such as
**Combat Enhancer**. Expand **Sources, limits and exclusions** to inspect the
contributors rather than assuming a universal maximum exists.

- **Max dedicated upgrades** selects single-effect, source-capped ordinary
  upgrades with a supported runtime owner.
- **Max with coupled effects** also includes upgrades that affect other mechanics
  or unlock progression. Their effects require explicit confirmation.
- Module actions cap only active, unlocked, non-removed saved modules. Dedicated
  mode excludes coupling across both current and final tiers.
- Shard actions operate on equipped, applicable shards and their source resonance
  or regional dissonance limits. Inventory, slot colors, links, charging state,
  equipment, and unlocks are preserved.
- Challenge actions complete only the selected challenge's finite reward tiers.
  They preserve higher endless progress, other challenges, active-run settings,
  and sector histories, and reject editing the selected active challenge.

Uncapped, dynamically limited, derived, and unsupported owner-specific sources
remain visible without inventing a maximum or mutating the wrong save record.
Effects can still depend on the ship, challenge, and loadout. Capping contributors
is not a guarantee of the largest possible final stat.

### Real cost and output mechanisms

| Mechanism                | Recovered-source effect at its reward cap                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Base Carry challenge     | Divide Base 1–5 building costs by 312,500,000.                                                                                    |
| Three Base 6 renovations | Each divides Base 6 building costs by 50; together by 125,000. Their other bonuses/unlocks are coupled.                           |
| Power Hungry challenge   | Divide reactor boost level costs by 10,000,000,000 and multiply the drain-scaling stat by 0.2373046875. Engine Boost is excluded. |
| Synth Purity challenge   | ×32 synthesis XP and ×32 output, coupled.                                                                                         |
| Core Computing challenge | Increase the compute effect exponent from 0.5 to 0.7; this is not a weapon-price discount.                                        |

Power Hungry's six literal `-0.1` growth modifications already apply at zero
completions; they are not another reduction per reward tier. The Compute Enhancer
level-20 milestone and Capital Utilities innate each change **ComputationPower**
cost growth from 1.5 to 1.3. They overwrite the same modifier rather than stacking,
and neither discounts weapon cores. These milestone/ship sources are listed for
inspection, not independently granted by an ordinary upgrade button.

### Why Laser Cannon reaches e305

There is no Laser Cannon or universal core-price divider in the inspected
recovered version. Its five tiers have exponential costs but linear direct
damage gains. Tier 5 has:

- Next-level cost: `3e75 × 1.5^level` Salvage.
- Unboosted damage: `3.75e11 + 3.75e10 × level`.
- At level 1303: about `8.40e304` for only a 0.076% raw damage increase.

Ten times more Salvage buys only about 5.68 additional tier-5 levels. Level 110
is the last Laser Cannon milestone, not a level cap. Extreme core levels can
overflow prices and make load-time upgrade replay prohibitively slow.

Use separate damage mechanisms instead of expecting a price discount:

- A source-maxed active **Combat Enhancer** reaches internal tier 6, level 10,
  giving ×60,816 damage **and shields**; use its explicitly coupled module action.
- Capped damage upgrades and valid milestone choices provide independent bonuses.
- `1e12` **Banked Battle Components** gives a ×59,049 damage/shields contribution
  under the recovered formula. This resource has no source maximum and can be
  replaced by the next prestige's banking operation.
- Higher core tiers and later Capital/Titan weapon systems are distinct
  progression/loadout changes, not discounts. The editor does not silently equip
  them or grant ship innates.

## Crew mastery points

**Mastery Components** are base resources, not the crew's **Mastery Points**.
Use **Max crew mastery points** in either **Resources** or **Crew**.

The game recalculates unspent `MasteryPoint` from the sum of
`Crew.crew_load[*].mastery`, minus the cost of purchased mastery upgrades.
A huge resource balance alone does not survive that reconciliation.

The dedicated action funds all 33 active mastery upgrades: 64 total earned
points in the recovered game. It raises the lowest unlocked crew mastery levels
only as needed, preserves higher earned mastery, and sets unspent points to
earned minus spent. For example, 18 points already spent leaves 46 available.
The unused `crew_mastery_womp` tier is excluded.

This changes mastery levels and their derived bonuses, but not ranks, skill XP,
locked crew, purchased upgrades, or lifetime totals. It can lower an inconsistent
previously edited point balance. It does not unlock missing crew or buy upgrades.
Confirmation and one-step undo apply to the entire change.

## Repair overflow-risk values

Open a save and select **Repair overflow values** beside the JSON editor. After
confirmation, every numeric value with magnitude at or above `1e304` is reset to
`0`. This includes values near `1e305`, negative extremes, and numbers beyond
Godot's finite range.

Repair scans the entire save, including resources, lifetime totals, and other
numeric fields, regardless of category or search. Smaller values, strings, and
`null` entries are unchanged. The whole action can be undone or redone.

Keep a backup and save the repaired result to a new file. Repair cannot recover
values already lost to overflow or guarantee that future calculations remain
finite. Individual resource maxima fill above the repair threshold, so using one
will reintroduce an extreme balance. Source-capped progression actions do not
use that resource ceiling.
