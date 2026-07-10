/*
 * Prompt Forge — state schema v2, validation/repair, migration, import/export.
 *
 * Plain classic script: attaches everything to globalThis.PromptForge.
 * Loadable three ways, all without a build step:
 *   1. <script src="..."> from prompt-forge.html (file:// friendly)
 *   2. dynamic import() from the ComfyUI panel module (a script with no
 *      import/export statements is a valid ES module)
 *   3. eval'd inside Node for the test runner
 */
(function (global) {
  "use strict";
  const PF = (global.PromptForge = global.PromptForge || {});

  PF.STATE_VERSION = 2;

  // ---------------------------------------------------------------- ids ----
  let _uidCounter = 0;
  function uid(prefix) {
    _uidCounter = (_uidCounter + 1) % 0xffff;
    return (
      (prefix || "id") +
      "_" +
      Date.now().toString(36) +
      Math.floor(Math.random() * 0xffff).toString(36) +
      _uidCounter.toString(36)
    );
  }
  PF.uid = uid;

  // ------------------------------------------------------------- fields ----
  // Positive compile order lives here so state + compiler + UI agree on it.
  PF.FIELD_TYPES = [
    "forced_positive",
    "character",
    "subject",
    "action",
    "clothing",
    "expression",
    "style",
    "medium",
    "composition",
    "camera",
    "lighting",
    "mood",
    "background",
    "environment",
    "props",
    "custom",
    "quality",
    "negative",
    "forced_negative",
  ];

  PF.TYPE_ORDER = {
    forced_positive: 0,
    character: 10,
    subject: 20,
    action: 25,
    clothing: 27,
    expression: 28,
    style: 30,
    medium: 35,
    composition: 40,
    camera: 45,
    lighting: 50,
    mood: 55,
    background: 60,
    environment: 65,
    props: 68,
    custom: 70,
    quality: 80,
    negative: 0,
    forced_negative: 90,
  };

  PF.TYPE_LABELS = {
    forced_positive: "Forced lead-in",
    character: "Character",
    subject: "Subject",
    action: "Action",
    clothing: "Clothing",
    expression: "Expression",
    style: "Style",
    medium: "Medium",
    composition: "Composition",
    camera: "Camera",
    lighting: "Lighting",
    mood: "Mood",
    background: "Background",
    environment: "Environment",
    props: "Props",
    custom: "Custom",
    quality: "Quality tags",
    negative: "Negative",
    forced_negative: "Forced negative",
  };

  function makeField(partial) {
    partial = partial || {};
    const type = PF.FIELD_TYPES.includes(partial.type) ? partial.type : "custom";
    return Object.assign(
      {
        id: uid("field"),
        type: type,
        label: partial.label || PF.TYPE_LABELS[type] || "Field",
        text: "",
        enabled: true,
        locked: false,
        scope: "scene",
        weight: 1.0,
        position:
          typeof partial.position === "number"
            ? partial.position
            : PF.TYPE_ORDER[type] !== undefined
              ? PF.TYPE_ORDER[type]
              : 70,
        mode: "tag",
        notes: "",
      },
      partial,
      { type: type }
    );
  }
  PF.makeField = makeField;

  function makeScene(partial) {
    partial = partial || {};
    const scene = Object.assign(
      {
        id: uid("scene"),
        name: "Scene",
        enabled: true,
        weight: 1.0,
        notes: "",
        status: "draft", // draft | ready | rendered | favorite (storyboard)
        color: "",
        fields: [],
        negativeFields: [],
        regions: [], // reserved for future regional prompting (23.12)
      },
      partial
    );
    scene.fields = (scene.fields || []).map(makeField);
    scene.negativeFields = (scene.negativeFields || []).map(function (f) {
      return makeField(Object.assign({ type: "negative" }, f));
    });
    return scene;
  }
  PF.makeScene = makeScene;

  // The classic prompt-forge.html field set, so a fresh scene feels familiar.
  PF.DEFAULT_SCENE_FIELD_TYPES = [
    "subject",
    "action",
    "composition",
    "lighting",
    "background",
  ];
  PF.DEFAULT_GLOBAL_FIELD_TYPES = ["character", "style", "medium", "quality"];

  PF.DEFAULT_NEGATIVE_BASE =
    "bad anatomy, extra limbs, low quality, blurry, watermark, deformed hands";

  function makeDefaultState() {
    const scene = makeScene({
      name: "Scene 1",
      fields: PF.DEFAULT_SCENE_FIELD_TYPES.map(function (t) {
        return { type: t };
      }),
    });
    return {
      version: PF.STATE_VERSION,
      settings: {
        modelProfile: "generic",
        outputMode: "single", // single | scenes_joined | break_blocks
        sceneJoiner: "BREAK", // comma | newline | BREAK | custom
        sceneJoinerCustom: "",
        dedupePositive: true,
        dedupeNegative: true,
        negativeSeverity: "normal", // minimal | normal | strict | nuclear
        negativeCategoriesOff: [], // negative-cleaner category ids toggled off
        externalPosition: "before_quality",
        syntaxPreview: "raw", // raw | natural | tags | debug
        density: "comfortable", // comfortable | compact | ultra
      },
      activeSceneId: scene.id,
      global: {
        fields: PF.DEFAULT_GLOBAL_FIELD_TYPES.map(function (t) {
          return makeField({ type: t, scope: "global" });
        }),
        negativeFields: [
          makeField({
            type: "negative",
            label: "Base negative",
            text: PF.DEFAULT_NEGATIVE_BASE,
            scope: "global",
          }),
        ],
      },
      scenes: [scene],
      externals: {
        // generic external STRING inputs — never LoRA-specific
        positiveA: { label: "", position: "before_quality" },
        positiveB: { label: "", position: "before_quality" },
        negativeA: { label: "" },
      },
      libraries: {
        characters: [],
        outfits: [],
        styles: [],
        cameras: [],
        lighting: [],
        locations: [],
        negativePresets: [],
        qualityPresets: [],
        templates: [],
      },
      history: [],
      snapshots: [],
    };
  }
  PF.makeDefaultState = makeDefaultState;

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  PF.deepClone = deepClone;

  // -------------------------------------------------- validation / repair ----
  // Repairs in place-ish (on a clone), collects readable issues, preserves
  // unknown keys instead of deleting them (spec 23.40).
  function validateAndRepair(input) {
    const issues = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      issues.push("State is not an object — replaced with defaults.");
      return { state: makeDefaultState(), issues: issues };
    }
    const state = deepClone(input);

    if (typeof state.version !== "number") {
      issues.push("Missing version — set to " + PF.STATE_VERSION + ".");
      state.version = PF.STATE_VERSION;
    }

    if (!state.settings || typeof state.settings !== "object") {
      issues.push("Missing settings — restored defaults.");
      state.settings = makeDefaultState().settings;
    } else {
      const def = makeDefaultState().settings;
      for (const k in def) {
        if (state.settings[k] === undefined) state.settings[k] = def[k];
      }
    }

    if (!state.global || typeof state.global !== "object") {
      issues.push("Missing global section — restored defaults.");
      state.global = { fields: [], negativeFields: [] };
    }
    if (!Array.isArray(state.global.fields)) state.global.fields = [];
    if (!Array.isArray(state.global.negativeFields)) state.global.negativeFields = [];

    if (!Array.isArray(state.scenes) || state.scenes.length === 0) {
      issues.push("No scenes — created Scene 1.");
      const scene = makeScene({ name: "Scene 1" });
      state.scenes = [scene];
      state.activeSceneId = scene.id;
    }

    function repairFieldArray(arr, where, negDefault) {
      return arr
        .filter(function (f) {
          if (!f || typeof f !== "object") {
            issues.push("Dropped a non-object field in " + where + ".");
            return false;
          }
          return true;
        })
        .map(function (f) {
          if (!f.id) {
            f.id = uid("field");
            issues.push("Field in " + where + " was missing an id — assigned one.");
          }
          if (typeof f.text !== "string") f.text = String(f.text == null ? "" : f.text);
          if (typeof f.enabled !== "boolean") f.enabled = true;
          if (typeof f.locked !== "boolean") f.locked = false;
          if (typeof f.weight !== "number" || !isFinite(f.weight)) f.weight = 1.0;
          if (!PF.FIELD_TYPES.includes(f.type)) {
            f.type = negDefault ? "negative" : "custom";
          }
          if (typeof f.position !== "number") {
            f.position = PF.TYPE_ORDER[f.type] !== undefined ? PF.TYPE_ORDER[f.type] : 70;
          }
          if (typeof f.label !== "string" || !f.label) {
            f.label = PF.TYPE_LABELS[f.type] || "Field";
          }
          if (typeof f.notes !== "string") f.notes = "";
          return f;
        });
    }

    state.global.fields = repairFieldArray(state.global.fields, "global", false);
    state.global.negativeFields = repairFieldArray(
      state.global.negativeFields,
      "global negatives",
      true
    );

    state.scenes = state.scenes
      .filter(function (s) {
        if (!s || typeof s !== "object") {
          issues.push("Dropped a non-object scene.");
          return false;
        }
        return true;
      })
      .map(function (s, i) {
        if (!s.id) {
          s.id = uid("scene");
          issues.push("Scene " + (i + 1) + " was missing an id — assigned one.");
        }
        if (typeof s.name !== "string" || !s.name) s.name = "Scene " + (i + 1);
        if (typeof s.enabled !== "boolean") s.enabled = true;
        if (typeof s.weight !== "number" || !isFinite(s.weight)) s.weight = 1.0;
        if (typeof s.notes !== "string") s.notes = "";
        if (!Array.isArray(s.fields)) s.fields = [];
        if (!Array.isArray(s.negativeFields)) s.negativeFields = [];
        if (!Array.isArray(s.regions)) s.regions = [];
        s.fields = repairFieldArray(s.fields, "scene '" + s.name + "'", false);
        s.negativeFields = repairFieldArray(
          s.negativeFields,
          "scene '" + s.name + "' negatives",
          true
        );
        return s;
      });

    if (
      !state.activeSceneId ||
      !state.scenes.some(function (s) {
        return s.id === state.activeSceneId;
      })
    ) {
      state.activeSceneId = state.scenes[0].id;
      issues.push("Active scene missing — pointed at first scene.");
    }

    if (!state.externals || typeof state.externals !== "object") {
      state.externals = makeDefaultState().externals;
    }
    const defExt = makeDefaultState().externals;
    for (const slot in defExt) {
      if (!state.externals[slot] || typeof state.externals[slot] !== "object") {
        state.externals[slot] = defExt[slot];
      }
    }

    if (!state.libraries || typeof state.libraries !== "object") {
      state.libraries = makeDefaultState().libraries;
    }
    const defLibs = makeDefaultState().libraries;
    for (const lib in defLibs) {
      if (!Array.isArray(state.libraries[lib])) state.libraries[lib] = [];
    }

    if (!Array.isArray(state.history)) state.history = [];
    if (!Array.isArray(state.snapshots)) state.snapshots = [];

    return { state: state, issues: issues };
  }
  PF.validateAndRepair = validateAndRepair;

  // ---------------------------------------------------------- migration ----
  // Convert the original prompt-forge.html localStorage data (draft object +
  // presets map, schema "v1") into a v2 state. Nothing is deleted by callers;
  // they keep the old keys as a legacy backup (spec 12.4).
  const LEGACY_FIELD_MAP = {
    f_subject: "subject",
    f_style: "style",
    f_medium: "medium",
    f_lighting: "lighting",
    f_comp: "composition",
    f_quality: "quality",
    f_background: "background",
  };

  function migrateLegacyDraft(draft) {
    const state = makeDefaultState();
    if (!draft || typeof draft !== "object") return state;
    const scene = state.scenes[0];

    function setFieldText(collection, type, text) {
      const f = collection.find(function (x) {
        return x.type === type;
      });
      if (f) f.text = text;
      else collection.push(makeField({ type: type, text: text }));
    }

    for (const key in LEGACY_FIELD_MAP) {
      const val = typeof draft[key] === "string" ? draft[key].trim() : "";
      if (!val) continue;
      const type = LEGACY_FIELD_MAP[key];
      if (PF.DEFAULT_GLOBAL_FIELD_TYPES.includes(type)) {
        setFieldText(state.global.fields, type, val);
      } else {
        setFieldText(scene.fields, type, val);
      }
    }

    if (typeof draft.f_negative === "string" && draft.f_negative.trim()) {
      state.global.negativeFields[0].text = draft.f_negative.trim();
    }

    if (draft.hasChar) {
      const genderTag =
        { female: "1girl", male: "1boy", nonbinary: "1other" }[draft.gender] || "";
      const ageTag =
        {
          young_adult: "young adult",
          adult: "adult",
          middle_aged: "middle-aged",
          elderly: "elderly",
        }[draft.age] || "";
      const charText = [genderTag, ageTag].filter(Boolean).join(", ");
      if (charText) setFieldText(state.global.fields, "character", charText);
    }

    if (draft.syntaxMode === "natural") {
      state.settings.modelProfile = "flux";
    }
    return state;
  }
  PF.migrateLegacyDraft = migrateLegacyDraft;

  // Turn one legacy preset (from promptforge_presets) into a v2 style-library
  // style/scene template so old presets remain usable.
  function migrateLegacyPreset(name, p) {
    const fields = [];
    for (const key in LEGACY_FIELD_MAP) {
      const short = key.slice(2); // legacy presets stored keys without the f_ prefix
      const val = typeof p[short] === "string" ? p[short].trim() : "";
      if (val) fields.push({ type: LEGACY_FIELD_MAP[key], text: val });
    }
    if (p.hasChar) {
      const genderTag =
        { female: "1girl", male: "1boy", nonbinary: "1other" }[p.gender] || "";
      if (genderTag) fields.push({ type: "character", text: genderTag });
    }
    return {
      id: uid("tpl"),
      name: name,
      kind: "legacy_preset",
      negative: typeof p.negative === "string" ? p.negative : "",
      fields: fields,
      notes: "Migrated from Prompt Forge v1 preset.",
    };
  }
  PF.migrateLegacyPreset = migrateLegacyPreset;

  // ------------------------------------------------------ import/export ----
  function exportProject(state) {
    return JSON.stringify(
      {
        app: "promptforge",
        kind: "project",
        schema: PF.STATE_VERSION,
        exportedAt: new Date().toISOString(),
        state: state,
      },
      null,
      2
    );
  }
  PF.exportProject = exportProject;

  function importProject(jsonText) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      throw new Error("Not valid JSON: " + e.message);
    }
    // Accept either a wrapped project file or a bare state object.
    const raw = data && data.app === "promptforge" && data.state ? data.state : data;
    if (!raw || typeof raw !== "object" || (!raw.scenes && !raw.global)) {
      throw new Error(
        "This JSON does not look like a Prompt Forge project (no scenes/global section)."
      );
    }
    const res = validateAndRepair(raw);
    return res; // { state, issues }
  }
  PF.importProject = importProject;

  function exportPresetPack(name, items, profiles) {
    return JSON.stringify(
      {
        app: "promptforge",
        kind: "preset_pack",
        packVersion: 1,
        name: name || "Prompt Forge preset pack",
        author: "local user",
        profiles: profiles || [],
        exportedAt: new Date().toISOString(),
        items: items || [],
      },
      null,
      2
    );
  }
  PF.exportPresetPack = exportPresetPack;

  function importPresetPack(jsonText) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      throw new Error("Not valid JSON: " + e.message);
    }
    if (!data || data.kind !== "preset_pack" || !Array.isArray(data.items)) {
      throw new Error("This JSON is not a Prompt Forge preset pack.");
    }
    return data;
  }
  PF.importPresetPack = importPresetPack;

  // ----------------------------------------------------- scene utilities ----
  function getActiveScene(state) {
    return (
      state.scenes.find(function (s) {
        return s.id === state.activeSceneId;
      }) || state.scenes[0]
    );
  }
  PF.getActiveScene = getActiveScene;

  function duplicateScene(state, sceneId) {
    const idx = state.scenes.findIndex(function (s) {
      return s.id === sceneId;
    });
    if (idx === -1) return null;
    const copy = deepClone(state.scenes[idx]);
    copy.id = uid("scene");
    copy.name = copy.name + " copy";
    copy.fields.forEach(function (f) {
      f.id = uid("field");
    });
    copy.negativeFields.forEach(function (f) {
      f.id = uid("field");
    });
    state.scenes.splice(idx + 1, 0, copy);
    return copy;
  }
  PF.duplicateScene = duplicateScene;

  function moveScene(state, sceneId, dir) {
    const idx = state.scenes.findIndex(function (s) {
      return s.id === sceneId;
    });
    const to = idx + dir;
    if (idx === -1 || to < 0 || to >= state.scenes.length) return false;
    const tmp = state.scenes[idx];
    state.scenes[idx] = state.scenes[to];
    state.scenes[to] = tmp;
    return true;
  }
  PF.moveScene = moveScene;
})(typeof globalThis !== "undefined" ? globalThis : this);
