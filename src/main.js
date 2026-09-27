import {
  decodeSave,
  encodeSave,
  parseJson,
  stringifyJson,
  isNumeric,
  numericText,
  makeNumeric,
} from "./codec.js";
import catalog from "./catalog.json";
import "./style.css";
import {
  addResourceAmount,
  fillResourceAmount,
  MAX_RESOURCE_AMOUNT,
} from "./resource-amounts.js";
import {
  buildCategoryEntries,
  getFieldPolicy,
  collectActionFields,
  planFieldAction,
} from "./category-model.js";
import {
  OVERFLOW_REPAIR_EXPONENT,
  planOverflowRepairs,
} from "./save-repair.js";

const $ = (selector) => document.querySelector(selector);
const app = $("#app");
const state = {
  records: null,
  format: "godot4",
  filename: "",
  baseline: "",
  history: [],
  future: [],
  view: "All records",
  query: "",
  busy: false,
  invalid: new Set(),
  resourceOpen: new Map(),
  resourceFillTarget: "1e12",
  categoryOpen: new Map(),
  fieldIncrement: "1",
  fieldTarget: "1",
  bulkFields: new Map(),
};
const achievements = new Map(
  catalog.achievements.map((item) => [item.id, item]),
);
const resourceCatalog = new Map(
  catalog.resources.map((item) => [item.id, item]),
);
// Recipe outputs and non-Time inputs come from recovered CastleDB data.
const maxMaterialIds = catalog.resources
  .filter(
    (item) =>
      item.recipeId ||
      item.usedBy.length ||
      ["Salvage", "VoidMatter", "VoidEnergy"].includes(item.id),
  )
  .map((item) => item.id);
// CastleDB's Warp/Base types include every building input/output. PlayerInfo.gd
// banks base components under "Banked" + resource ID on prestige.
const maxWarpBaseIds = catalog.resources
  .filter(
    (item) =>
      item.type === "Warp" ||
      item.type === "Base" ||
      (item.id.startsWith("Banked") &&
        resourceCatalog.get(item.id.slice(6))?.type === "Base"),
  )
  .map((item) => item.id);
const formats = {
  godot4: "Godot 4 encrypted",
  godot3: "Godot 3 encrypted",
  compressed: "Compressed export",
  base64: "Base64 text",
  plain: "Plain JSON records",
};
const views = [
  "All records",
  "Resources",
  "Achievements",
  "Inventory",
  "Progression",
  "Crew",
  "Fleet",
  "Research",
  "Settings",
  "Other",
];
const own = (object, key) => Object.hasOwn(object, key);
const objectLike = (value) =>
  value !== null && typeof value === "object" && !isNumeric(value);
const define = (object, key, value) =>
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
const snapshot = () => stringifyJson(state.records);
const dirty = () => state.records && snapshot() !== state.baseline;
const pretty = (text) =>
  String(text)
    .replace(/_load$/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, onClick, cls = "button subtle") {
  const el = node("button", cls, text);
  el.type = "button";
  el.addEventListener("click", onClick);
  return el;
}
function notice(message, error = false) {
  const el = $("#notice");
  el.textContent = message;
  el.className = `notice ${error ? "error" : ""}`;
  el.hidden = false;
}
function canNavigate() {
  if (!state.invalid.size) return true;
  notice("Correct the highlighted invalid values before continuing.", true);
  return false;
}
function commit(action, rerender = false) {
  const before = snapshot();
  action();
  if (before !== snapshot()) {
    state.history.push(before);
    if (state.history.length > 40) state.history.shift();
    state.future = [];
  }
  updateToolbar();
  if (rerender) renderWorkspace();
}
function undo(redo = false) {
  if (!canNavigate()) return;
  const source = redo ? state.future : state.history,
    target = redo ? state.history : state.future;
  if (!source.length) return;
  target.push(snapshot());
  state.records = parseJson(source.pop());
  renderWorkspace();
  updateToolbar();
  notice(redo ? "Change restored." : "Change undone.");
}
function category(record) {
  const name = String(record.save_name ?? "");
  if (achievements.has(name)) return "Achievements";
  if (own(catalog.categoryMetadata.records, name))
    return catalog.categoryMetadata.records[name].category;
  if (own(catalog.recordCategories, name))
    return catalog.recordCategories[name];
  if (own(catalog.labels, name)) return catalog.labels[name].category;
  if (/inventory|recipe|module|shard|loadout|voiddevice|equipment/i.test(name))
    return "Inventory";
  if (/crew|splice|sleeve/i.test(name)) return "Crew";
  if (/fleet|galaxy|transit/i.test(name)) return "Fleet";
  if (/research|compute/i.test(name)) return "Research";
  if (/theme|config|setting/i.test(name)) return "Settings";
  if (
    /upgrade|core|sector|battle|warp|challenge|reactor|reinforce|prestige|playerinfo/i.test(
      name,
    )
  )
    return "Progression";
  return "Other";
}
function recordName(record, index) {
  if (record.save_name !== undefined) return String(record.save_name);
  if (own(record, "version")) return "Game version";
  if (own(record, "compatibility_version")) return "Compatibility version";
  if (own(record, "timestamp")) return "Save timestamp";
  return `Record ${index + 1}`;
}
function matches(text) {
  return String(text).toLowerCase().includes(state.query.toLowerCase());
}
function labelInfo(key) {
  return (
    (own(catalog.labels, key) ? catalog.labels[key] : null) ||
    resourceCatalog.get(key) ||
    achievements.get(key)
  );
}
function playerIndex() {
  return state.records.findIndex(
    (r) => r.save_name === "PlayerInfo" || own(r, "resources_load"),
  );
}
function at(path) {
  return path.reduce((value, key) => value[key], state.records);
}
function put(path, value) {
  const parent = at(path.slice(0, -1));
  define(parent, path.at(-1), value);
}
function updateToolbar() {
  const loaded = !!state.records;
  $("#workspace").inert = state.busy;
  $("#navigation").inert = state.busy;
  $("#save").disabled = !loaded || state.busy || !!state.invalid.size;
  $("#raw").disabled = !loaded || state.busy;
  $("#repair-overflow").disabled =
    !loaded || state.busy || !!state.invalid.size;
  $("#undo").disabled = !loaded || !state.history.length || state.busy;
  $("#redo").disabled = !loaded || !state.future.length || state.busy;
  $("#open").disabled = state.busy;
  $("#search").disabled = !loaded;
  $("#file-name").textContent = loaded ? state.filename : "No save open";
  $("#file-state").textContent = state.busy
    ? "Working…"
    : loaded
      ? `${formats[state.format] || state.format} · ${state.records.length.toLocaleString()} records${dirty() ? " · Unsaved changes" : " · Unchanged"}`
      : "Your save stays on this device";
  $("#dirty-dot").classList.toggle("changed", !!dirty());
}

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#" aria-label="SpaceIdle Save Workshop"><span class="brand-mark">S<span>↗</span></span><span>SPACEIDLE<small>SAVE WORKSHOP</small></span></a>
    <div class="file-info"><span id="dirty-dot" class="dot"></span><div><strong id="file-name">No save open</strong><small id="file-state">Your save stays on this device</small></div></div>
    <div class="top-actions"><button id="open" class="button">Open .save</button><button id="save" class="button primary" disabled>Save as… <span>↗</span></button></div>
  </header>
  <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
  <div class="shell">
    <aside class="sidebar"><div class="side-caption">WORKSPACE</div><nav id="navigation" aria-label="Save categories"></nav><div class="side-bottom"><span class="privacy-dot"></span> LOCAL & PRIVATE<p>No uploads. No account.<br>Keep a backup of your original save.</p></div></aside>
    <main>
      <div class="workspace-toolbar"><div class="search-wrap"><span>⌕</span><input id="search" type="search" placeholder="Search names, IDs, fields, or values…" aria-label="Search save fields" disabled><kbd>/</kbd></div><div class="tools"><button id="undo" class="icon-button" title="Undo" aria-label="Undo" disabled>↶</button><button id="redo" class="icon-button" title="Redo" aria-label="Redo" disabled>↷</button><button id="raw" class="button subtle" disabled>JSON editor</button></div></div>
      <div id="workspace"></div>
    </main>
  </div>
  <input id="file-input" type="file" accept=".save,.txt,.json,.OLDENGINEsave" hidden>
  <dialog id="edit-dialog"><form method="dialog" class="dialog-form"><div class="dialog-heading"><div><div class="eyebrow">ADVANCED EDITOR</div><h2 id="dialog-title"></h2></div><button value="cancel" class="icon-button" aria-label="Close dialog">×</button></div><p id="dialog-help" class="muted"></p><label id="key-label" hidden>Field name<input id="field-key" type="text" autocomplete="off"></label><textarea id="json-text" spellcheck="false" aria-label="JSON value"></textarea><p id="json-error" role="alert" class="error-text"></p><div class="dialog-actions"><button value="cancel" class="button">Cancel</button><button id="apply-json" type="button" class="button primary">Apply changes</button></div></form></dialog>
`;
const repairOverflow = button(
  "Repair overflow values",
  () => {
    if (!state.records || state.busy || !canNavigate()) return;
    try {
      const paths = planOverflowRepairs(state.records);
      if (!paths.length) {
        notice(
          `No numeric values with magnitude at or above 1e${OVERFLOW_REPAIR_EXPONENT} need repair.`,
        );
        return;
      }
      if (
        !confirm(
          `Reset ${paths.length} numeric value${paths.length === 1 ? "" : "s"} to 0?\n\nScans the entire save, regardless of category or search. Positive and negative values with magnitude at or above 1e${OVERFLOW_REPAIR_EXPONENT} are reset, including resource balances, lifetime totals, and other numeric fields.\n\nSmaller values, strings, and null entries are unchanged. This cannot reconstruct values already lost to overflow or prevent every future overflow. Keep a backup.\n\nThis is one undoable change.`,
        )
      )
        return;
      commit(() => {
        for (const path of paths) put(path, makeNumeric("0"));
      }, true);
      notice(
        `Repaired ${paths.length} overflow-risk value${paths.length === 1 ? "" : "s"} by resetting to 0. Undo restores the entire change.`,
      );
    } catch (error) {
      notice(`Overflow repair not applied: ${error.message}`, true);
    }
  },
  "button danger",
);
repairOverflow.id = "repair-overflow";
repairOverflow.title = `Reset numeric values with magnitude at or above 1e${OVERFLOW_REPAIR_EXPONENT} to 0 across the entire save. Includes values near 1e305. One undoable change.`;
$(".tools").insertBefore(repairOverflow, $("#raw"));

function renderNavigation() {
  const nav = $("#navigation");
  nav.replaceChildren();
  const categoryCounts = new Map();
  if (state.records)
    for (const entry of buildCategoryEntries(state.records, catalog, category))
      categoryCounts.set(
        entry.category,
        (categoryCounts.get(entry.category) || 0) + 1,
      );
  for (const view of views) {
    const count = !state.records
      ? "—"
      : view === "All records"
        ? state.records.length
        : view === "Resources"
          ? catalog.resources.length
          : view === "Achievements"
            ? catalog.achievements.length
            : categoryCounts.get(view) || 0;
    const el = button(
      "",
      () => {
        if (!canNavigate()) return;
        state.view = view;
        renderWorkspace();
      },
      `nav-item ${state.view === view ? "active" : ""}`,
    );
    el.append(node("span", "", view), node("span", "nav-count", String(count)));
    nav.append(el);
  }
}
function heading(title, description) {
  const wrap = node("div", "page-heading");
  wrap.append(
    node("div", "eyebrow", "SAVE WORKSHOP"),
    node("h1", "", title),
    node("p", "muted", description),
  );
  return wrap;
}
function renderWorkspace() {
  renderNavigation();
  const workspace = $("#workspace");
  workspace.replaceChildren();
  if (!state.records) {
    renderWelcome(workspace);
    return;
  }
  if (state.view === "Resources") {
    renderResources(workspace);
    return;
  }
  if (state.view === "Achievements") {
    renderAchievements(workspace);
    return;
  }
  renderRecords(workspace);
}
function renderWelcome(workspace) {
  const welcome = node("section", "welcome");
  welcome.append(
    node("div", "eyebrow", "YOUR PROGRESS. YOUR CONTROL."),
    node("h1", "", "A new perspective\non your universe."),
    node(
      "p",
      "welcome-copy",
      "Inspect and edit your SpaceIdle save. Resources, achievements, inventory, and every field in between. Entirely on your device.",
    ),
  );
  const drop = node("div", "drop-zone");
  drop.append(
    node("div", "file-symbol", "{ }"),
    node("h2", "", "Bring your progress aboard"),
    node(
      "p",
      "muted",
      "Drop a .save file here, or choose one from your computer.",
    ),
    button("Choose save file", openPicker, "button primary"),
    node("small", "muted", "Encrypted saves and text exports supported"),
  );
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    if (event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]);
  });
  welcome.append(drop);
  const cards = node("div", "feature-grid");
  for (const [number, title, description] of [
    [
      String(catalog.resources.length),
      "Resources & points",
      "Balances, currencies, materials, and consumables.",
    ],
    [
      String(catalog.achievements.length),
      "Achievements",
      "Every achievement from the recovered game catalog.",
    ],
    [
      "ALL",
      "Saved fields",
      "Grouped fields and scoped quick actions. Exact numbers and unknown data preserved.",
    ],
  ]) {
    const card = node("div", "feature-card");
    card.append(
      node("strong", "", number),
      node("h3", "", title),
      node("p", "muted", description),
    );
    cards.append(card);
  }
  welcome.append(
    cards,
    node(
      "p",
      "footnote",
      "Close the game before replacing a save. Export to a new file first; cloud sync or autosave can overwrite edits.",
    ),
  );
  workspace.append(welcome);
}
function categoryDisclosure(key, title, count, draw, nested = false) {
  const details = node(
    "details",
    nested
      ? "resource-subgroup category-subgroup"
      : "resource-group category-group",
  );
  details.dataset.groupKey = key;
  const summary = node("summary");
  summary.append(
    node("span", "resource-group-title", title),
    node("span", "badge", String(count)),
  );
  details.append(summary);
  let drawn = false;
  const populate = () => {
    if (!drawn) {
      drawn = true;
      draw(details);
    }
  };
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    state.categoryOpen.set(key, details.open);
    if (details.open) populate();
  });
  details.open = state.categoryOpen.get(key) ?? Boolean(state.query);
  if (details.open) populate();
  return details;
}
function categoryFoldControls(root) {
  const controls = node("div", "resource-fold-actions");
  for (const open of [true, false])
    controls.append(
      button(open ? "Expand groups" : "Collapse groups", () => {
        if (!canNavigate()) return;
        // Subgroups are lazy: open their parents first, then the newly drawn children.
        for (const selector of [".category-group", ".category-subgroup"]) {
          for (const details of root.querySelectorAll(selector)) {
            state.categoryOpen.set(details.dataset.groupKey, open);
            details.open = open;
            details.dispatchEvent(new Event("toggle"));
          }
        }
      }),
    );
  return controls;
}
function applyFieldAction(fields, action, target) {
  if (!canNavigate()) return;
  try {
    const current = fields.map((field) => ({
      ...field,
      policy: getFieldPolicy(state.records, catalog, field.path),
    }));
    const changes = planFieldAction(state.records, current, action, target);
    if (!changes.length) return notice("No changes needed.");
    const verb = {
      add: `Add ${target}`,
      fill: `Fill to ${target}`,
      max: "Set known maxima",
      true: "Set true",
      false: "Set false",
    }[action];
    const notes = [
      ...new Set(current.map((field) => field.policy?.note).filter(Boolean)),
    ];
    if (
      changes.length > 1 &&
      !confirm(
        `${verb} for ${changes.length} matching fields in this group?\n\nOnly the selected field is changed. Known caps are respected. Related rewards and derived fields are not recalculated.${notes.length ? `\n\n${notes.join("\n")}` : ""}\n\nThis is one undoable edit.`,
      )
    )
      return;
    commit(() => {
      for (const change of changes) put(change.path, change.value);
    }, true);
    notice(
      `${verb}: ${changes.length} field${changes.length === 1 ? "" : "s"} changed. Undo restores the entire action.`,
    );
  } catch (error) {
    notice(error.message, true);
  }
}
function categoryBulkControls(entries, key) {
  const bar = node("div", "category-bulk-controls");
  const choices = new Map();
  for (const entry of entries) {
    for (const field of collectActionFields(state.records, catalog, entry)) {
      const id = JSON.stringify([field.policy.kind, field.relativeKey]);
      if (!choices.has(id)) choices.set(id, []);
      choices.get(id).push(field);
    }
  }
  if (!choices.size) {
    bar.append(
      node(
        "p",
        "muted",
        "Open an entry for exact editing. No safe bulk field is available in this group.",
      ),
    );
    return bar;
  }
  const label = node("label", "bulk-field-label");
  label.append(node("span", "", "Bulk field"));
  const select = node("select");
  select.setAttribute("aria-label", "Bulk field");
  const placeholder = node("option", "", "Choose a field…");
  placeholder.value = "";
  select.append(placeholder);
  for (const [id, fields] of [...choices].sort((a, b) =>
    a[1][0].label.localeCompare(b[1][0].label),
  )) {
    const first = fields[0];
    const option = node(
      "option",
      "",
      `${first.label} · ${fields.length} field${fields.length === 1 ? "" : "s"}${first.policy.kind === "boolean" ? " · toggle" : ""}`,
    );
    option.value = id;
    select.append(option);
  }
  label.append(select);
  bar.append(label);
  const actions = node("div", "resource-quick-actions");
  const note = node("p", "muted bulk-note");
  const draw = () => {
    actions.replaceChildren();
    const fields = choices.get(select.value);
    state.bulkFields.set(key, select.value);
    if (!fields) {
      note.textContent =
        "Explicit field selection; actions affect only the entries shown in this group.";
      return;
    }
    if (fields[0].policy.kind === "boolean") {
      actions.append(
        button("Set true", () => applyFieldAction(fields, "true")),
        button("Set false", () => applyFieldAction(fields, "false")),
      );
    } else {
      actions.append(
        button("Add amount", () =>
          applyFieldAction(fields, "add", state.fieldIncrement),
        ),
        button("Fill to target", () =>
          applyFieldAction(fields, "fill", state.fieldTarget),
        ),
      );
      const max = button("Set known max", () =>
        applyFieldAction(fields, "max"),
      );
      max.disabled = !fields.every((field) => field.policy.max !== undefined);
      max.title = max.disabled
        ? "Not every selected field has a source-defined maximum."
        : "Fill to each field's source-defined maximum without decreasing existing values.";
      actions.append(max);
    }
    note.textContent =
      [
        ...new Set(fields.map((field) => field.policy.note).filter(Boolean)),
      ].join(" ") ||
      "Only this field changes; rewards and derived state are not recalculated.";
  };
  select.value = choices.has(state.bulkFields.get(key))
    ? state.bulkFields.get(key)
    : "";
  select.addEventListener("change", draw);
  draw();
  bar.append(actions, note);
  return bar;
}
function entryValue(entry) {
  const value = at(entry.path);
  return entry.omitFields?.length && objectLike(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => !entry.omitFields.includes(key),
        ),
      )
    : value;
}
function renderCategoryEntry(entry) {
  const value = entryValue(entry);
  const key = `entry:${entry.key}`;
  const details = node("details", "category-entry");
  details.dataset.entryKey = entry.key;
  const summary = node("summary");
  const title = node("span", "category-entry-title");
  title.append(
    node("strong", "", entry.title),
    node(
      "code",
      "",
      entry.path.slice(1).join(" / ") ||
        String(at(entry.path)?.save_name ?? "Save metadata"),
    ),
  );
  summary.append(
    title,
    node(
      "span",
      "badge",
      objectLike(value) ? `${Object.keys(value).length} fields` : "value",
    ),
  );
  details.append(summary);
  let drawn = false;
  const draw = () => {
    if (drawn) return;
    drawn = true;
    const body = node("div", "category-entry-body");
    const actions = node("div", "object-actions");
    actions.append(
      button(
        entry.omitFields?.length ? "Edit whole entry JSON" : "Edit JSON",
        () => editValue(entry.path, entry.title),
      ),
    );
    if (objectLike(at(entry.path)))
      actions.append(button("+ Add field", () => addEntry(entry.path)));
    actions.append(
      button("Remove", () => removeField(entry.path), "button danger"),
    );
    body.append(actions);
    const info = labelInfo(at(entry.path)?.save_name || entry.path.at(-1));
    if (info?.description) body.append(node("p", "muted", info.description));
    if (entry.omitFields?.length)
      body.append(
        node(
          "p",
          "muted",
          "Collection fields are shown in their own groups. Whole-entry JSON still includes them.",
        ),
      );
    if (objectLike(value)) {
      for (const [field, child] of Object.entries(value))
        body.append(
          renderField(
            field,
            child,
            [...entry.path, Array.isArray(value) ? Number(field) : field],
            1,
          ),
        );
    } else {
      body.append(renderField(entry.path.at(-1), value, entry.path, 1));
    }
    details.append(body);
  };
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    state.categoryOpen.set(key, details.open);
    if (details.open) draw();
  });
  details.open = state.categoryOpen.get(key) ?? false;
  if (details.open) draw();
  return details;
}
function renderRecords(workspace) {
  const descriptions = {
    Inventory:
      "Materials, modules, equipment and unlocks, organized by family and tier. Quick edits do not pay costs or award crafting rewards.",
    Progression:
      "Upgrades and progression systems, grouped by source family. Proven limits are respected; no arbitrary universal maximum is imposed.",
    Crew: "Crew members, ranks, stats and upgrades. Editing levels does not recalculate XP requirements, mastery or rank-point accounting.",
    Fleet:
      "Fleet systems, galaxies and events. Completion flags are independent; loading edited flags can trigger game effects. The editor does not rebuild battle state.",
    Research:
      "Research families and tiers. Known level limits are respected; the editor does not pay costs or recalculate related bonuses.",
    Settings:
      "Saved configuration grouped by system. Choose a specific field before applying a group-wide setting.",
    Other:
      "Remaining saved systems and metadata. Exact editing is retained; identifiers and timestamps have no automatic bulk actions.",
  };
  const header = heading(
    state.view,
    descriptions[state.view] ||
      "Every original record, grouped by category and source family. Record order, exact numbers and unknown fields are retained.",
  );
  header.append(
    button("+ Add record", () =>
      jsonDialog(
        "Add save record",
        '{"save_name":"RecordName"}',
        (value) => {
          if (!objectLike(value) || Array.isArray(value))
            throw new Error("A record must be a JSON object.");
          commit(() => state.records.push(value), true);
        },
        "Advanced: use exact game save_name and property names. Adding an unknown record does not create a game feature.",
      ),
    ),
  );
  workspace.append(header);
  const list = node("div", "category-groups");
  const toolbar = node("div", "resource-toolbar category-toolbar");
  for (const [text, property, id] of [
    ["Increment", "fieldIncrement", "category-increment"],
    ["Fill target", "fieldTarget", "category-fill-target"],
  ]) {
    const label = node("label", "fill-target-label", text);
    const input = node("input", "value-input numeric");
    input.id = id;
    input.type = "text";
    input.inputMode = "decimal";
    input.value = state[property];
    input.addEventListener("input", () => {
      state[property] = input.value;
    });
    label.append(input);
    toolbar.append(label);
  }
  toolbar.append(
    categoryFoldControls(list),
    node(
      "p",
      "muted",
      "Fill and max never reduce a value. Known caps are respected. Each bulk action is one undoable change.",
    ),
  );
  workspace.append(toolbar);
  const allEntries =
    state.view === "All records"
      ? state.records.map((record, index) => ({
          key: `record:${index}`,
          path: [index],
          title: labelInfo(record.save_name)?.name || recordName(record, index),
          category: category(record),
          group: category(record),
          subgroup:
            catalog.categoryMetadata.records[record.save_name]?.group ||
            "Saved records",
        }))
      : buildCategoryEntries(state.records, catalog, category).filter(
          (entry) => entry.category === state.view,
        );
  const filtered = allEntries.filter(
    (entry) =>
      !state.query ||
      matches(
        `${entry.title} ${entry.group} ${entry.subgroup || ""} ${stringifyJson(entryValue(entry))}`,
      ),
  );
  workspace.append(
    node(
      "p",
      "resource-result-count",
      `${filtered.length.toLocaleString()} of ${allEntries.length.toLocaleString()} entries · search scopes all group actions`,
    ),
    list,
  );
  const groups = new Map();
  for (const entry of filtered) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  for (const [name, entries] of groups) {
    const key = JSON.stringify([state.view, name]);
    list.append(
      categoryDisclosure(key, pretty(name), entries.length, (body) => {
        body.append(categoryBulkControls(entries, key));
        const subgroups = new Map();
        for (const entry of entries) {
          const name = entry.subgroup || "";
          if (!subgroups.has(name)) subgroups.set(name, []);
          subgroups.get(name).push(entry);
        }
        for (const [subgroup, children] of subgroups) {
          if (!subgroup) {
            for (const entry of children)
              body.append(renderCategoryEntry(entry));
          } else {
            const subkey = JSON.stringify([state.view, name, subgroup]);
            body.append(
              categoryDisclosure(
                subkey,
                subgroup,
                children.length,
                (inner) => {
                  inner.append(categoryBulkControls(children, subkey));
                  for (const entry of children)
                    inner.append(renderCategoryEntry(entry));
                },
                true,
              ),
            );
          }
        }
      }),
    );
  }
  if (!filtered.length)
    list.append(
      node(
        "p",
        "empty-panel",
        "No matching entries. Try a different search or category.",
      ),
    );
}
function editValue(path, title) {
  if (!canNavigate()) return;
  jsonDialog(
    title,
    stringifyJson(at(path), 2),
    (value) => {
      if (path.length === 1 && (!objectLike(value) || Array.isArray(value)))
        throw new Error("A record must remain a JSON object.");
      commit(() => put(path, value), true);
    },
    "Edit this value as JSON. Numbers retain their exact decimal representation. Changes affect only this value.",
  );
}
function addEntry(path) {
  if (!canNavigate()) return;
  const parent = at(path),
    array = Array.isArray(parent);
  jsonDialog(
    array ? "Append array item" : "Add object field",
    "null",
    (value, key) => {
      if (!array && (!key || own(parent, key)))
        throw new Error("Enter a new, non-empty field name.");
      commit(() => {
        if (array) parent.push(value);
        else define(parent, key, value);
      }, true);
    },
    "Choose a JSON value: number, string, boolean, null, object, or array. No other fields will change.",
    !array,
  );
}
function renderField(key, value, path, depth) {
  const info = labelInfo(key),
    title = info?.name || pretty(key);
  if (objectLike(value)) {
    const details = node("details", "object-field");
    const openKey = `field:${JSON.stringify(path)}`;
    const summary = node("summary");
    summary.append(
      node("span", "field-title", title),
      node("code", "", String(key)),
      node(
        "span",
        "badge",
        `${Array.isArray(value) ? "array" : "object"} · ${Object.keys(value).length}`,
      ),
    );
    details.append(summary);
    const body = node("div", "object-body");
    let drawn = false;
    const draw = () => {
      if (drawn) return;
      drawn = true;
      const controls = node("div", "object-actions");
      controls.append(
        button("Edit JSON", () => editValue(path, title)),
        button(Array.isArray(value) ? "+ Append item" : "+ Add field", () =>
          addEntry(path),
        ),
        button("Remove", () => removeField(path), "button danger"),
      );
      body.append(controls);
      if (!Object.keys(value).length)
        body.append(node("p", "muted", "Empty — add a field or item above."));
      for (const [childKey, childValue] of Object.entries(value))
        body.append(
          renderField(
            childKey,
            childValue,
            [...path, Array.isArray(value) ? Number(childKey) : childKey],
            depth + 1,
          ),
        );
      details.append(body);
    };
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      state.categoryOpen.set(openKey, details.open);
      if (details.open) draw();
    });
    if (
      state.categoryOpen.get(openKey) ??
      (depth === 0 || (state.query && matches(stringifyJson(value))))
    ) {
      details.open = true;
      draw();
    }
    return details;
  }
  const row = node("div", "field-row"),
    label = node("label", "field-label");
  const id = `field-${path.map((part) => encodeURIComponent(part)).join("-")}`;
  label.htmlFor = id;
  label.append(
    node("span", "field-title", title),
    node("code", "", String(key)),
  );
  if (info?.description)
    label.append(node("small", "field-description", info.description));
  const controls = node("div", "field-control");
  const input = valueInput(value, (next) => commit(() => put(path, next)), id);
  if (typeof value === "string" && input.tagName === "INPUT") {
    const parent = at(path.slice(0, -1));
    const choices =
      key === "name" && own(parent, "resonance")
        ? "void_shards"
        : key === "core_id"
          ? "cores"
          : key === "ship" || key === "ship_at_reset"
            ? "main_ships"
            : key === "resource"
              ? "resources"
              : null;
    if (choices) input.setAttribute("list", `choices-${choices}`);
  }
  controls.append(input);
  const options = button("···", () => editValue(path, title), "icon-button");
  options.title = `Edit ${key} as JSON / change type`;
  options.setAttribute("aria-label", `Edit ${key} as JSON`);
  const remove = button(
    "×",
    () => removeField(path),
    "icon-button remove-field",
  );
  remove.title = `Remove ${key}`;
  remove.setAttribute("aria-label", `Remove ${key}`);
  controls.append(options, remove);
  row.append(label, controls);
  const policy = getFieldPolicy(state.records, catalog, path);
  if (policy?.note)
    label.append(node("small", "field-description", policy.note));
  if (policy?.kind === "number") {
    const wrap = node("div", "field-with-actions");
    const quick = node("div", "resource-quick-actions field-quick-actions");
    const fields = [{ path, policy, relativeKey: String(key), label: title }];
    const step = policy.step || "1";
    quick.append(
      button(`+${step}`, () => applyFieldAction(fields, "add", step)),
      button("Fill target", () =>
        applyFieldAction(fields, "fill", state.fieldTarget),
      ),
    );
    if (policy.max !== undefined) {
      const max = button("Set max", () => applyFieldAction(fields, "max"));
      max.title = `Source-defined maximum: ${policy.max}`;
      quick.append(max);
    }
    wrap.append(row, quick);
    return wrap;
  }
  return row;
}
function removeField(path) {
  if (!canNavigate() || !confirm(`Remove ${path.at(-1)}? Undo is available.`))
    return;
  commit(() => {
    const parent = at(path.slice(0, -1));
    if (Array.isArray(parent)) parent.splice(Number(path.at(-1)), 1);
    else delete parent[path.at(-1)];
  }, true);
}
function valueInput(value, onChange, id) {
  if (typeof value === "boolean") {
    const wrap = node("label", "toggle-wrap"),
      input = node("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = value;
    const caption = node("span", "", value ? "Enabled" : "Disabled");
    input.addEventListener("change", () => {
      onChange(input.checked);
      caption.textContent = input.checked ? "Enabled" : "Disabled";
    });
    wrap.append(input, caption);
    return wrap;
  }
  if (value === null)
    return button("null · Edit JSON", () =>
      notice(
        "Use the adjacent ··· button to replace null with any JSON value.",
      ),
    );
  const numeric = isNumeric(value) || typeof value === "number";
  const input = node(
    typeof value === "string" && (value.includes("\n") || value.length > 100)
      ? "textarea"
      : "input",
    numeric ? "value-input numeric" : "value-input",
  );
  input.id = id;
  if (input.tagName === "INPUT") input.type = "text";
  input.spellcheck = false;
  input.value = numeric ? numericText(value) : String(value);
  input.setAttribute("aria-label", id);
  if (numeric) input.inputMode = "decimal";
  input.addEventListener("change", () => {
    if (!input.isConnected) return;
    try {
      const wasInvalid = state.invalid.has(input);
      const next = numeric ? makeNumeric(input.value.trim()) : input.value;
      input.setCustomValidity("");
      input.classList.remove("invalid");
      state.invalid.delete(input);
      onChange(next);
      if (wasInvalid) notice("Value corrected.");
      updateToolbar();
    } catch (error) {
      input.classList.add("invalid");
      input.setCustomValidity(error.message);
      state.invalid.add(input);
      notice(`Invalid number: ${error.message}`, true);
      updateToolbar();
    }
  });
  return input;
}
function resourceBalance(id) {
  const values = state.records[playerIndex()].resources_load || {};
  return own(values, id) ? values[id] : makeNumeric("0");
}

function applyResourceAction(ids, mode, maxScope) {
  if (!canNavigate()) return;
  try {
    const target =
      mode === "max"
        ? MAX_RESOURCE_AMOUNT
        : $("#resource-fill-target").value.trim();
    // Precompute the entire transaction: an invalid value cannot leave a
    // partially edited group. Arithmetic never passes through JS Number.
    const edits = ids.map((id) => {
      const current = resourceBalance(id);
      return [
        id,
        mode === "add"
          ? addResourceAmount(current, "1e9")
          : fillResourceAmount(current, target),
      ];
    });
    const record = state.records[playerIndex()];
    const changed = edits.filter(
      ([id, value]) =>
        (!own(record.resources_load || {}, id) && numericText(value) !== "0") ||
        stringifyJson(resourceBalance(id)) !== stringifyJson(value),
    );
    if (!changed.length) {
      notice(
        "No change needed. Existing balances already meet the fill target.",
      );
      return;
    }
    const description =
      mode === "add"
        ? "Add 1e9 to"
        : mode === "max"
          ? "Fill to resource target for"
          : `Fill to ${target} for`;
    if (
      ids.length > 1 &&
      !confirm(
        mode === "max"
          ? `Fill ${changed.length} balances to ${MAX_RESOURCE_AMOUNT}?\n\nIncludes ${maxScope}, regardless of search. Missing balances will be added; higher balances are not reduced. Layouts, recipes, upgrades, unlocks, and lifetime totals stay unchanged.\n\nThis is one tenth of the largest finite Godot float, leaving arithmetic headroom. It is not a gameplay cap; later calculations can still overflow. Repair overflow values will reset balances at this target. Keep a backup.\n\nThis is one undoable change.`
          : `${description} ${changed.length} resources in this shown group? Missing balances will be added. Higher balances are never reduced by Fill. This is one undoable change.`,
      )
    )
      return;
    const focusId = document.activeElement?.id;
    const scrollTop = window.scrollY;
    commit(() => {
      if (!own(record, "resources_load")) define(record, "resources_load", {});
      for (const [id, value] of changed)
        define(record.resources_load, id, value);
    }, true);
    if (focusId)
      document.getElementById(focusId)?.focus({ preventScroll: true });
    window.scrollTo({ top: scrollTop });
    notice(
      `${description} ${changed.length} resource${changed.length === 1 ? "" : "s"}. Balances only; undo restores the entire change.`,
    );
  } catch (error) {
    notice(`Resource action not applied: ${error.message}`, true);
  }
}

function resourceActionButtons(ids, suffix, bulk = false) {
  const actions = node("div", "resource-quick-actions");
  const eligible = ids.filter((id) => isNumeric(resourceBalance(id)));
  const add = button(
    bulk ? `+1e9 to ${eligible.length} shown` : "+1e9",
    () => applyResourceAction(eligible, "add"),
    "button subtle",
  );
  const fill = button(
    bulk ? `Fill ${eligible.length} shown to target` : "Fill to target",
    () => applyResourceAction(eligible, "fill"),
    "button subtle",
  );
  add.id = `resource-add-${suffix}`;
  fill.id = `resource-fill-${suffix}`;
  add.title = "Add exactly 1,000,000,000 to each balance.";
  fill.title = `Raise lower balances to the chosen target (${state.resourceFillTarget}); never reduce higher balances. This is not a game maximum.`;
  add.disabled = fill.disabled = eligible.length === 0;
  actions.append(add, fill);
  return actions;
}

function renderResourceRow(id, pi) {
  const record = state.records[pi],
    values = record.resources_load || {};
  const entry = resourceCatalog.get(id);
  const row = node("div", "resource-row");
  row.dataset.resourceId = id;
  const label = node("div", "resource-label");
  label.append(
    node("strong", "", entry?.name || pretty(id)),
    node("code", "", id),
  );
  const tags = node("div", "resource-tags");
  if (entry?.role) tags.append(node("span", "badge", entry.role));
  if (entry?.recipeId)
    tags.append(node("span", "badge tier-badge", `Tier ${entry.tier}`));
  if (tags.childElementCount) label.append(tags);
  if (entry?.description)
    label.append(node("small", "field-description", entry.description));
  if (entry?.inputs?.length) {
    label.append(
      node(
        "small",
        "recipe-inputs",
        `Crafted from: ${entry.inputs
          .map((input) => resourceCatalog.get(input)?.name || input)
          .join(", ")}`,
      ),
    );
  } else if (entry?.usedBy?.length) {
    label.append(
      node(
        "small",
        "recipe-inputs",
        `Used in ${entry.usedBy.length} synthesis recipes`,
      ),
    );
  }
  const controls = node("div", "resource-controls");
  const balance = node("div", "resource-balance");
  balance.append(
    node("span", "badge", own(values, id) ? "In save" : "Not saved"),
  );
  const value = resourceBalance(id);
  if (objectLike(value) || value === null) {
    balance.append(
      button("Edit value", () => editValue([pi, "resources_load", id], id)),
    );
  } else {
    balance.append(
      valueInput(
        value,
        (next) =>
          commit(() => {
            if (!own(record, "resources_load"))
              define(record, "resources_load", {});
            define(record.resources_load, id, next);
            balance.querySelector(".badge").textContent = "In save";
          }),
        `resource-${id}`,
      ),
    );
  }
  controls.append(balance, resourceActionButtons([id], id));
  row.append(label, controls);
  return row;
}

function resourceDisclosure(key, name, count, nested = false) {
  const details = node(
    "details",
    nested ? "resource-subgroup" : "resource-group",
  );
  details.dataset.groupId = key;
  details.open = !!state.query || (state.resourceOpen.get(key) ?? false);
  const summary = node("summary");
  summary.append(
    node("span", "resource-group-title", name),
    node("span", "badge", `${count} resource${count === 1 ? "" : "s"}`),
  );
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (details.isConnected) state.resourceOpen.set(key, details.open);
  });
  return details;
}

function renderResources(workspace) {
  workspace.append(
    heading(
      "Resources & points",
      "Game-defined materials and recipe tiers. Change individual balances or a whole group; lifetime totals, recipes, and unlocks stay unchanged.",
    ),
  );
  const pi = playerIndex();
  if (pi < 0) {
    workspace.append(
      node(
        "div",
        "empty-panel",
        "This save has no PlayerInfo resource record. All existing data remains editable under All records.",
      ),
    );
    return;
  }
  const values = state.records[pi].resources_load || {};
  const controls = node("div", "resource-toolbar");
  const fillLabel = node("label", "fill-target-label", "Fill target");
  const target = node("input", "value-input numeric");
  target.id = "resource-fill-target";
  target.type = "text";
  target.value = state.resourceFillTarget;
  target.spellcheck = false;
  target.setAttribute("aria-label", "Resource fill target");
  target.addEventListener("change", () => {
    try {
      fillResourceAmount(makeNumeric("0"), target.value.trim());
      state.resourceFillTarget = target.value.trim();
      target.setCustomValidity("");
      target.classList.remove("invalid");
      for (const item of document.querySelectorAll('[id^="resource-fill-"]')) {
        if (item.tagName === "BUTTON")
          item.title = `Raise lower balances to ${state.resourceFillTarget}; never reduce higher balances. Not a game maximum.`;
      }
    } catch (error) {
      target.setCustomValidity(error.message);
      target.classList.add("invalid");
      notice(`Invalid fill target: ${error.message}`, true);
    }
  });
  fillLabel.append(target);
  const folds = node("div", "resource-fold-actions");
  for (const [text, open] of [
    ["Expand all", true],
    ["Collapse all", false],
  ]) {
    folds.append(
      button(text, () => {
        if (!canNavigate()) return;
        for (const details of workspace.querySelectorAll(
          ".resource-group, .resource-subgroup",
        )) {
          details.open = open;
          state.resourceOpen.set(details.dataset.groupId, open);
        }
      }),
    );
  }
  const maxMaterials = button(
    "Max synth materials + salvage + void",
    () =>
      applyResourceAction(
        maxMaterialIds,
        "max",
        "all standard and alien synth materials, raw ingredients, Salvage, Void Matter, and Void Energy",
      ),
    "button primary",
  );
  maxMaterials.id = "resource-max-materials";
  maxMaterials.title = `Fill all ${maxMaterialIds.length} synth material, raw ingredient, Salvage, Void Matter, and Void Energy balances to ${MAX_RESOURCE_AMOUNT} (one tenth of the numeric maximum), regardless of search. One undoable change.`;
  const maxWarpBase = button(
    "Max warp + base resources",
    () =>
      applyResourceAction(
        maxWarpBaseIds,
        "max",
        "Warp Essence, Warp Residuum, all seven Skeins, building materials and parts for Bases 1–6, and all six component types plus their banked balances",
      ),
    "button primary",
  );
  maxWarpBase.id = "resource-max-warp-base";
  maxWarpBase.title = `Fill all ${maxWarpBaseIds.length} warp currency, base material, part, component, and banked component balances to ${MAX_RESOURCE_AMOUNT}, regardless of search. One undoable change.`;
  controls.append(
    fillLabel,
    maxMaterials,
    maxWarpBase,
    folds,
    node(
      "p",
      "muted resource-max-note",
      `Max buttons fill their full resource sets to ${MAX_RESOURCE_AMOUNT}, regardless of search. Higher balances stay unchanged. This is one tenth of the numeric maximum, not a gameplay cap; overflow remains possible. Repair resets balances at this target. Keep a backup.`,
    ),
  );
  workspace.append(controls);
  const unknown = Object.keys(values).filter((id) => !resourceCatalog.has(id));
  const groups = [...catalog.resourceGroups];
  if (unknown.length)
    groups.push({
      id: "unknown",
      name: "Other saved resources",
      description:
        "Fields from your save that are not in this game version's catalog.",
      subgroups: [
        { id: "unknown", name: "Other saved resources", resourceIds: unknown },
      ],
    });
  const groupList = node("div", "resource-groups");
  let shownCount = 0;
  for (const group of groups) {
    const subsets = group.subgroups
      .map((subgroup) => ({
        ...subgroup,
        resourceIds: subgroup.resourceIds.filter((id) => {
          const entry = resourceCatalog.get(id);
          return (
            !state.query ||
            matches(
              `${id} ${entry?.name || ""} ${entry?.description || ""} ${entry?.role || ""} ${entry?.type || ""} ${group.name} ${subgroup.name} ${own(values, id) ? stringifyJson(values[id]) : ""}`,
            )
          );
        }),
      }))
      .filter((subgroup) => subgroup.resourceIds.length);
    const ids = subsets.flatMap((subgroup) => subgroup.resourceIds);
    if (!ids.length) continue;
    shownCount += ids.length;
    const details = resourceDisclosure(group.id, group.name, ids.length);
    const intro = node("div", "resource-group-intro");
    intro.append(
      node("p", "muted", group.description),
      resourceActionButtons(ids, `group-${group.id}`, true),
    );
    details.append(intro);
    for (const subgroup of subsets) {
      // Retain tier headings while searching, even when only one tier matches.
      const nested = group.subgroups.length > 1;
      const holder = nested
        ? resourceDisclosure(
            `${group.id}/${subgroup.id}`,
            subgroup.name,
            subgroup.resourceIds.length,
            true,
          )
        : node("div", "resource-group-rows");
      if (nested)
        holder.append(
          resourceActionButtons(
            subgroup.resourceIds,
            `group-${group.id}-${subgroup.id}`,
            true,
          ),
        );
      for (const id of subgroup.resourceIds)
        holder.append(renderResourceRow(id, pi));
      details.append(holder);
    }
    groupList.append(details);
  }
  workspace.append(
    node(
      "p",
      "resource-result-count",
      `${shownCount} resource${shownCount === 1 ? "" : "s"} in ${groupList.childElementCount} group${groupList.childElementCount === 1 ? "" : "s"}${state.query ? " · Matching groups opened automatically. Group actions affect only shown results; Max buttons ignore search." : " · Expand a group to edit its balances."}`,
    ),
  );
  if (!shownCount)
    groupList.append(node("p", "empty-panel", "No matching resources."));
  workspace.append(groupList);
}
function applyAchievementAction(items, complete) {
  if (!canNavigate()) return;
  const wanted = new Set(items.map((item) => item.id));
  const found = new Set();
  const changes = [];
  for (const [index, record] of state.records.entries()) {
    if (!wanted.has(record.save_name)) continue;
    found.add(record.save_name);
    if (
      !isNumeric(record.amount_have) ||
      Number(numericText(record.amount_have)) !== Number(complete)
    )
      changes.push(index);
  }
  const additions = complete ? items.filter((item) => !found.has(item.id)) : [];
  const affected = new Set([
    ...changes.map((index) => state.records[index].save_name),
    ...additions.map((item) => item.id),
  ]).size;
  if (!affected) return notice("No achievement changes needed.");
  if (
    affected > 1 &&
    !confirm(
      `${complete ? "Complete" : "Reset"} ${affected} shown achievements?\n\nOnly completion (0 or 1) changes. AI points, items and other rewards are not granted or removed.\n\nThis is one undoable edit.`,
    )
  )
    return;
  commit(() => {
    for (const index of changes)
      put([index, "amount_have"], makeNumeric(complete ? "1" : "0"));
    if (additions.length) {
      const timestamp = state.records.findIndex((record) =>
        own(record, "timestamp"),
      );
      state.records.splice(
        timestamp < 0 ? state.records.length : timestamp,
        0,
        ...additions.map((item) => ({
          save_name: item.id,
          amount_have: makeNumeric("1"),
        })),
      );
    }
  }, true);
  notice(
    `${affected} achievement${affected === 1 ? "" : "s"} ${complete ? "completed" : "reset"}. Rewards were not changed.`,
  );
}
function achievementActions(items) {
  const bar = node("div", "category-bulk-controls achievement-bulk-controls");
  bar.append(
    node("span", "muted", `${items.length} shown`),
    button("Complete shown", () => applyAchievementAction(items, true)),
    button("Reset shown", () => applyAchievementAction(items, false)),
  );
  return bar;
}
function renderAchievementCard(item, record) {
  const complete =
    record &&
    isNumeric(record.amount_have) &&
    Number(numericText(record.amount_have)) > 0;
  const card = node(
    "section",
    `achievement-card ${complete ? "completed" : ""}`,
  );
  card.dataset.achievementId = item.id;
  const top = node("div", "achievement-top");
  top.append(
    node("span", "badge", complete ? "Completed" : "Incomplete"),
    node("span", "badge", `${item.ai_points ?? 0} AI points`),
  );
  card.append(
    top,
    node("h3", "", item.name || pretty(item.id)),
    node("code", "", item.id),
  );
  if (item.description) card.append(node("p", "muted", item.description));
  const toggle = node("label", "toggle-wrap");
  const input = node("input");
  input.type = "checkbox";
  input.checked = Boolean(complete);
  input.setAttribute("aria-label", `${item.name || item.id} completed`);
  input.addEventListener("change", () => {
    const requested = input.checked;
    input.checked = Boolean(complete);
    applyAchievementAction([item], requested);
  });
  toggle.append(
    input,
    node(
      "span",
      "",
      complete ? "Completed" : record ? "Incomplete" : "Not in save",
    ),
  );
  card.append(toggle);
  return card;
}
function renderAchievements(workspace) {
  workspace.append(
    heading(
      "Achievements",
      "Grouped by achievement family and tier. Complete or reset only the shown achievements. Loading completed achievements applies their effects, but does not grant AI points, items or other extra rewards.",
    ),
  );
  const records = new Map(
    state.records
      .filter((record) => achievements.has(record.save_name))
      .map((record) => [record.save_name, record]),
  );
  const filtered = catalog.achievements.filter((item) => {
    const info = catalog.categoryMetadata.achievements[item.id];
    return (
      !state.query ||
      matches(
        `${item.id} ${item.name} ${item.description} ${info?.group || ""} ${info?.screen || ""} Tier ${info?.tier ?? ""}`,
      )
    );
  });
  const list = node("div", "category-groups");
  const toolbar = node("div", "resource-toolbar");
  toolbar.append(
    categoryFoldControls(list),
    node(
      "p",
      "muted",
      "Completion uses only 0 or 1. Group actions follow the current search and are fully undoable.",
    ),
  );
  workspace.append(
    toolbar,
    node(
      "p",
      "resource-result-count",
      `${filtered.length} of ${catalog.achievements.length} achievements · search scopes all group actions`,
    ),
    list,
  );
  const groups = new Map();
  for (const item of filtered) {
    const group =
      catalog.categoryMetadata.achievements[item.id]?.group || "Achievements";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for (const [name, items] of groups) {
    list.append(
      categoryDisclosure(
        JSON.stringify(["Achievements", name]),
        pretty(name),
        items.length,
        (body) => {
          body.append(achievementActions(items));
          const tiers = new Map();
          for (const item of items) {
            const tier = catalog.categoryMetadata.achievements[item.id]?.tier;
            const title = tier === undefined ? "Untiered" : `Tier ${tier}`;
            if (!tiers.has(title)) tiers.set(title, []);
            tiers.get(title).push(item);
          }
          for (const [tier, children] of [...tiers].sort((a, b) =>
            a[0].localeCompare(b[0], undefined, { numeric: true }),
          )) {
            body.append(
              categoryDisclosure(
                JSON.stringify(["Achievements", name, tier]),
                tier,
                children.length,
                (inner) => {
                  inner.append(achievementActions(children));
                  const grid = node("div", "achievement-grid");
                  for (const item of children)
                    grid.append(
                      renderAchievementCard(item, records.get(item.id)),
                    );
                  inner.append(grid);
                },
                true,
              ),
            );
          }
        },
      ),
    );
  }
  if (!filtered.length)
    list.append(node("p", "empty-panel", "No matching achievements."));
}

let applyDialog = null;
function jsonDialog(title, text, onApply, help, fieldKey = false) {
  if (!canNavigate()) return;
  $("#dialog-title").textContent = title;
  $("#json-text").value = text;
  $("#dialog-help").textContent = help;
  $("#json-error").textContent = "";
  $("#key-label").hidden = !fieldKey;
  $("#field-key").value = "";
  applyDialog = onApply;
  $("#edit-dialog").showModal();
}
$("#apply-json").addEventListener("click", () => {
  try {
    const value = parseJson($("#json-text").value);
    applyDialog(value, $("#field-key").value);
    $("#edit-dialog").close();
  } catch (error) {
    $("#json-error").textContent = error.message;
  }
});
$("#raw").addEventListener("click", () => {
  if (!canNavigate()) return;
  jsonDialog(
    "All save records",
    stringifyJson(state.records, 2),
    (records) => {
      if (
        !Array.isArray(records) ||
        !records.length ||
        records.some((r) => !objectLike(r) || Array.isArray(r)) ||
        !own(records[0], "version")
      )
        throw new Error(
          "Use an array of record objects, with the version record first.",
        );
      commit(() => {
        state.records = records;
      }, true);
    },
    "The array is an editing view of the original JSON-lines stream. Keep record order, version records, and save_name identifiers intact. Unknown fields and exact numbers are preserved.",
  );
});
async function openPicker() {
  if (state.busy || !canNavigate()) return;
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "SpaceIdle save",
            accept: {
              "application/octet-stream": [
                ".save",
                ".txt",
                ".json",
                ".OLDENGINEsave",
              ],
            },
          },
        ],
      });
      await loadFile(await handle.getFile());
    } catch (error) {
      if (error.name !== "AbortError") notice(error.message, true);
    }
  } else $("#file-input").click();
}
async function loadFile(file) {
  if (state.busy || !canNavigate()) return;
  if (dirty() && !confirm("Discard unsaved changes and open another save?"))
    return;
  state.busy = true;
  updateToolbar();
  try {
    if (file.size > 64 * 1024 * 1024)
      throw new Error("This file exceeds the 64 MiB save limit.");
    const decoded = await decodeSave(new Uint8Array(await file.arrayBuffer()));
    state.records = decoded.records;
    state.format = decoded.format;
    state.filename = file.name;
    state.baseline = snapshot();
    state.history = [];
    state.future = [];
    state.categoryOpen.clear();
    state.bulkFields.clear();
    state.query = "";
    state.invalid.clear();
    $("#search").value = "";
    renderWorkspace();
    notice(
      `Opened ${file.name}. ${state.records.length.toLocaleString()} records are ready to edit. Your original file has not been changed.`,
    );
  } catch (error) {
    notice(`Could not open save: ${error.message}`, true);
  } finally {
    state.busy = false;
    updateToolbar();
  }
}
async function saveFile() {
  if (!state.records || state.busy || !canNavigate()) return;
  const suggestedName =
    state.filename.replace(/(?:\.save|\.txt|\.json|\.OLDENGINEsave)$/i, "") +
    ".edited.save";
  let handle;
  try {
    for (const record of state.records) {
      if (
        achievements.has(record.save_name) &&
        (!isNumeric(record.amount_have) ||
          ![0, 1].includes(Number(numericText(record.amount_have))))
      ) {
        throw new Error(
          `${record.save_name}: achievement amount_have must be 0 or 1. Higher values can hang the game on load.`,
        );
      }
    }
    if (window.showSaveFilePicker)
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: "SpaceIdle save file",
            accept: { "application/octet-stream": [".save"] },
          },
        ],
      });
    state.busy = true;
    updateToolbar();
    const bytes = await encodeSave(state.records, state.format);
    if (handle) {
      const stream = await handle.createWritable();
      try {
        await stream.write(bytes);
        await stream.close();
      } catch (error) {
        await stream.abort().catch(() => {});
        throw error;
      }
    } else {
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      );
      const link = node("a");
      link.href = url;
      link.download = suggestedName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    if (handle) state.baseline = snapshot();
    notice(
      handle
        ? `Saved ${handle.name}. Original encoding preserved.`
        : "Download prepared. This browser does not support a Save As picker; enable “Ask where to save each file” in browser settings to choose its location.",
    );
  } catch (error) {
    if (error.name !== "AbortError")
      notice(`Could not save: ${error.message}`, true);
  } finally {
    state.busy = false;
    updateToolbar();
  }
}
$("#open").addEventListener("click", openPicker);
$("#save").addEventListener("click", saveFile);
$("#file-input").addEventListener("change", (event) => {
  if (event.target.files[0]) loadFile(event.target.files[0]);
  event.target.value = "";
});
$("#undo").addEventListener("click", () => undo());
$("#redo").addEventListener("click", () => undo(true));
$("#search").addEventListener("input", (event) => {
  if (!canNavigate()) return;
  state.query = event.target.value;
  renderWorkspace();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty() || state.invalid.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !/INPUT|TEXTAREA/.test(event.target.tagName) &&
    !$("#edit-dialog").open
  ) {
    event.preventDefault();
    $("#search").focus();
  }
});
for (const [group, entries] of Object.entries(catalog.options)) {
  const list = node("datalist");
  list.id = `choices-${group}`;
  for (const entry of entries) {
    const option = node("option", "", entry.name);
    option.value = entry.id;
    list.append(option);
  }
  app.append(list);
}
renderWorkspace();
updateToolbar();
