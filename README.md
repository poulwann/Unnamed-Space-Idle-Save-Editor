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
