You can use the editor here: https://poulwann.github.io/Unnamed-Space-Idle-Save-Editor/

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
finite. The Max synth button fills above the repair threshold, so using it again
will reintroduce extreme resource balances.
