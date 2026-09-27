You can use the editor here: https://poulwann.github.io/Unnamed-Space-Idle-Save-Editor/

## Max warp and base resources

In **Resources**, select **Max warp + base resources** to fill these 32 balances:

- Warp Essence, Warp Residuum, and all seven warp Skeins.
- Building materials and parts for Bases 1–6, including Base 5 alien materials.
- Battle, Compute, Synth, Warp, Mastery, and Fleet components, plus all six banked
  component balances.

The selection follows the recovered game's `Warp` and `Base` resource types,
base-building inputs/outputs, and `PlayerInfo.gd`'s banked-component naming.
It excludes unrelated prestige currencies and consumables.

Like Max synth, this fills to `1.7976931348623157e307`, adds missing balances,
never lowers higher ones, and ignores search filters. Only balances change:
base layouts, upgrades, unlocks, and lifetime totals are untouched. Confirmation
is required, and the entire action is undoable.

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
finite. Both Max resource buttons fill above the repair threshold, so using either
will reintroduce extreme resource balances.
