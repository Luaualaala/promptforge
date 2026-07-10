/*
 * Prompt Forge — native ComfyUI panel.
 *
 * Registers a "Prompt Forge" button (top menu when the API allows it, plus a
 * floating fallback button) that opens a right-side drawer for editing the
 * state of a PromptForgeComposer node:
 *   - find or create a Composer node
 *   - scene bar (add / duplicate / delete / enable / rename)
 *   - field editing per scene + global
 *   - model profile / output mode / negative severity
 *   - live compiled preview + prompt health, no queue needed
 *   - LLM enhance / full draft via the package's own backend routes
 *     (/promptforge/llm — no bridge server, no CORS, key stays server-side)
 *   - template library persisted server-side (/promptforge/templates)
 *   - project JSON import/export (also the migration path from the old
 *     standalone prompt-forge.html app)
 *   - wildcard {a|b|c} variant generation
 *   - target routing: write prompts directly into text-encode nodes
 *
 * Every edit recompiles via the shared core (promptforge_compiler.js) and
 * writes state_json, compiled_positive, compiled_negative and metadata_json
 * into the node's widgets, then marks the canvas dirty. State therefore
 * lives inside the workflow file and survives save/reload with no server.
 */
import { app } from "/scripts/app.js";

console.log("[PromptForge.Panel] extension file loaded");

let PF = null; // shared core namespace, loaded in setup()

// --------------------------------------------------------------- helpers ----
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (k.startsWith("on")) node[k] = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
  }
  children.forEach((c) => {
    if (c == null) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// Some models put a literal line break inside a JSON string value instead of
// escaping it as \n, which makes JSON.parse reject an otherwise-fine object.
// Walk the text tracking string context and escape raw control characters
// only where they actually appear inside a quoted value.
function sanitizeJsonText(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n" || ch === "\r") {
        out += "\\n";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1"); // trailing commas some models add
}

// Extract the JSON object from a chatty model response and parse it,
// retrying with sanitizeJsonText() if the first attempt fails.
function parseDraftJSON(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("model did not return JSON — try again or switch models");
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    try {
      return JSON.parse(sanitizeJsonText(match[0]));
    } catch (e2) {
      throw new Error("model returned malformed JSON (" + e2.message + ") — try again or switch models");
    }
  }
}

function getComposerNodes() {
  return (app.graph?._nodes || []).filter((n) => n.comfyClass === "PromptForgeComposer" || n.type === "PromptForgeComposer");
}

function getWidget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

function getTextEncodeNodes() {
  // Any node with a string "text" widget counts as a text-encode target
  // (CLIPTextEncode, Flux/SD3/Qwen text encoders, Show Text, …).
  return (app.graph?._nodes || []).filter((n) => {
    if (n.comfyClass === "PromptForgeComposer" || n.type === "PromptForgeComposer") return false;
    const w = getWidget(n, "text");
    return w && typeof w.value === "string";
  });
}

// ----------------------------------------------------------- panel state ----
let panel = null;
let currentNodeId = null; // LiteGraph node id of the selected Composer
let uiTab = "global"; // "global" | sceneId
let state = null; // working PromptForgeState (mirrors the node's state_json)
let llmConfig = null; // public LLM config from the backend (no key)
let templates = []; // server-side template library
const POS_TARGET_KEY = "PromptForge.posTarget";
const NEG_TARGET_KEY = "PromptForge.negTarget";
const LLM_THEME_KEY = "PromptForge.llmTheme";
const PANEL_WIDTH_KEY = "PromptForge.panelWidth";

function currentNode() {
  if (currentNodeId == null) return null;
  return app.graph?.getNodeById?.(currentNodeId) || null;
}

function loadStateFromNode(node) {
  const w = getWidget(node, "state_json");
  if (w && typeof w.value === "string" && w.value.trim()) {
    try {
      const res = PF.validateAndRepair(JSON.parse(w.value));
      if (res.issues.length) console.warn("[PromptForge.Panel] state repaired:", res.issues);
      return res.state;
    } catch (e) {
      console.warn("[PromptForge.Panel] node state_json unreadable — starting fresh.", e);
    }
  }
  return PF.makeDefaultState();
}

function writeToNode() {
  const node = currentNode();
  if (!node || !state) return null;
  const compiled = PF.compilePromptForgeState(state, {
    forcedPositive: getWidget(node, "forced_positive")?.value || "",
    forcedNegative: getWidget(node, "forced_negative")?.value || "",
    forcedPosition: getWidget(node, "forced_position")?.value || "prepend",
  });
  const set = (name, value) => {
    const w = getWidget(node, name);
    if (w) w.value = value;
  };
  set("state_json", JSON.stringify(state));
  // Forced text lives in its own widgets and is re-combined by the Python
  // node, so the compiled widgets carry the state-only compile.
  const stateOnly = PF.compilePromptForgeState(state, {});
  set("compiled_positive", stateOnly.positive);
  set("compiled_negative", stateOnly.negative);
  const meta = stateOnly.metadata;
  meta.scenes = stateOnly.scenes; // lets the node emit scene_json without recompiling
  set("metadata_json", JSON.stringify(meta));
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
  return compiled;
}

// Write an LLM-enhanced positive straight into the compiled widget. Mirrors
// v1 semantics: the output is replaced, the fields are untouched, and any
// later field edit recompiles over it.
function writeEnhancedToNode(text) {
  const node = currentNode();
  if (!node) return;
  const w = getWidget(node, "compiled_positive");
  if (w) w.value = text;
  node.setDirtyCanvas?.(true, true);
  const pos = panel?.querySelector("#pf-prev-pos");
  if (pos) pos.textContent = text;
}

// ------------------------------------------------------------ rendering ----
const refresh = debounce(() => {
  writeToNode();
  renderPreview();
  renderGraphHelper();
}, 250);

function commitAndRender() {
  writeToNode();
  renderPanel();
}

// Applies non-destructive per-model recommendations when the user picks a
// profile from the dropdown. Only touches settings directly grounded in the
// profile's own researched fields (negativePolicy, promptStyle) — never
// runs on load, and never disables the dropdowns, so the user can override
// either value immediately after.
function applyProfileRecommendedSettings(profile) {
  if (!profile) return;
  const SEVERITY_LADDER = ["off", "minimal", "normal", "strict", "nuclear"];
  if (SEVERITY_LADDER.includes(profile.negativePolicy)) {
    state.settings.negativeSeverity = profile.negativePolicy;
  }
  if (profile.promptStyle === "natural_language") {
    // T5/DiT-style encoders read one continuous description. BREAK-block
    // chunking exploits the CLIP 75-token chunk limit and has no equivalent
    // here — it would just inject the literal word "BREAK" into the prose.
    state.settings.outputMode = "single";
  }
}

function renderPanel() {
  if (!panel) return;
  const body = panel.querySelector("#pf-body");
  body.innerHTML = "";

  // -------- composer picker --------
  body.appendChild(el("h4", { text: "Composer node" }));
  const composers = getComposerNodes();
  const pickRow = el("div", { class: "pf-row" });
  const sel = el("select", {
    onchange: () => {
      currentNodeId = parseInt(sel.value, 10);
      state = loadStateFromNode(currentNode());
      uiTab = "global";
      renderPanel();
    },
  });
  composers.forEach((n) => {
    const o = new Option(`#${n.id} ${n.title || "Prompt Forge Composer"}`, n.id);
    sel.appendChild(o);
  });
  if (currentNodeId == null && composers.length) {
    currentNodeId = composers[0].id;
    state = loadStateFromNode(composers[0]);
  }
  if (currentNodeId != null) sel.value = String(currentNodeId);
  pickRow.appendChild(sel);
  pickRow.appendChild(
    el("button", {
      class: "pf-primary",
      text: composers.length ? "+ new" : "Create Prompt Forge Composer node",
      onclick: () => {
        try {
          const node = window.LiteGraph.createNode("PromptForgeComposer");
          if (!node) throw new Error("node class not registered — is the Python package installed?");
          const canvas = app.canvas;
          node.pos = canvas?.ds
            ? [-canvas.ds.offset[0] + 120, -canvas.ds.offset[1] + 120]
            : [120, 120];
          app.graph.add(node);
          currentNodeId = node.id;
          state = loadStateFromNode(node);
          uiTab = "global";
          commitAndRender();
        } catch (e) {
          setStatus("Could not create node: " + e.message, true);
        }
      },
    })
  );
  body.appendChild(pickRow);

  if (!composers.length && currentNodeId == null) {
    body.appendChild(
      el("div", { class: "pf-muted", text: "No Composer node in this graph yet — create one to start." })
    );
    renderGraphHelper();
    return;
  }
  if (!state) state = loadStateFromNode(currentNode()) || PF.makeDefaultState();

  // -------- scene bar --------
  body.appendChild(el("h4", { text: "Scenes" }));
  const tabs = el("div", { class: "pf-tabs" });
  const mkTab = (label, id, extraClass) => {
    const t = el("div", {
      class: "pf-tab" + (uiTab === id ? " active" : "") + (extraClass || ""),
      text: label,
      onclick: () => {
        uiTab = id;
        if (id !== "global") state.activeSceneId = id;
        commitAndRender();
      },
    });
    tabs.appendChild(t);
    return t;
  };
  mkTab("Global", "global");
  state.scenes.forEach((s) => {
    const t = mkTab(s.name, s.id, s.enabled ? "" : " off");
    t.title = "double-click to rename";
    t.ondblclick = () => {
      const v = prompt("Scene name:", s.name);
      if (v !== null) {
        s.name = v.trim() || s.name;
        commitAndRender();
      }
    };
  });
  tabs.appendChild(
    el("div", {
      class: "pf-tab",
      text: "+",
      onclick: () => {
        const scene = PF.makeScene({
          name: "Scene " + (state.scenes.length + 1),
          fields: PF.DEFAULT_SCENE_FIELD_TYPES.map((t) => ({ type: t })),
        });
        state.scenes.push(scene);
        uiTab = scene.id;
        state.activeSceneId = scene.id;
        commitAndRender();
      },
    })
  );
  body.appendChild(tabs);

  const scene = uiTab === "global" ? null : state.scenes.find((s) => s.id === uiTab);
  if (scene) {
    const tools = el("div", { class: "pf-row" });
    tools.appendChild(
      el("button", {
        text: scene.enabled ? "disable" : "enable",
        onclick: () => {
          scene.enabled = !scene.enabled;
          commitAndRender();
        },
      })
    );
    tools.appendChild(
      el("button", {
        text: "duplicate",
        onclick: () => {
          const c = PF.duplicateScene(state, scene.id);
          if (c) {
            uiTab = c.id;
            state.activeSceneId = c.id;
          }
          commitAndRender();
        },
      })
    );
    const idx = state.scenes.findIndex((s) => s.id === scene.id);
    tools.appendChild(
      el("button", {
        text: "◀",
        disabled: idx === 0 ? "true" : undefined,
        onclick: () => {
          PF.moveScene(state, scene.id, -1);
          commitAndRender();
        },
      })
    );
    tools.appendChild(
      el("button", {
        text: "▶",
        disabled: idx === state.scenes.length - 1 ? "true" : undefined,
        onclick: () => {
          PF.moveScene(state, scene.id, 1);
          commitAndRender();
        },
      })
    );
    tools.appendChild(
      el("button", {
        text: "delete",
        onclick: () => {
          if (state.scenes.length <= 1) return setStatus("Keep at least one scene.", true);
          if (!confirm(`Delete scene "${scene.name}"?`)) return;
          state.scenes = state.scenes.filter((s) => s.id !== scene.id);
          if (state.activeSceneId === scene.id) state.activeSceneId = state.scenes[0].id;
          uiTab = state.scenes[0].id;
          commitAndRender();
        },
      })
    );
    body.appendChild(tools);
  }

  // -------- fields --------
  const fields = scene ? scene.fields : state.global.fields;
  const negs = scene ? scene.negativeFields : state.global.negativeFields;
  body.appendChild(el("h4", { text: (scene ? scene.name : "Global") + " — fields" }));
  renderFieldList(body, fields, false);
  const addRow = el("div", { class: "pf-row" });
  const typeSel = el("select");
  PF.FIELD_TYPES.filter((t) => !["negative", "forced_negative"].includes(t)).forEach((t) =>
    typeSel.appendChild(new Option(PF.TYPE_LABELS[t] || t, t))
  );
  typeSel.value = "custom";
  addRow.appendChild(typeSel);
  addRow.appendChild(
    el("button", {
      text: "+ field",
      onclick: () => {
        fields.push(PF.makeField({ type: typeSel.value, scope: scene ? "scene" : "global" }));
        commitAndRender();
      },
    })
  );
  addRow.appendChild(
    el("button", {
      text: "+ negative",
      onclick: () => {
        negs.push(PF.makeField({ type: "negative", scope: scene ? "scene" : "global" }));
        commitAndRender();
      },
    })
  );
  addRow.appendChild(
    el("button", {
      text: "🎲 randomize",
      title: "fill unlocked inspiration fields with random ideas",
      onclick: () => {
        randomizeScene();
        commitAndRender();
      },
    })
  );
  body.appendChild(addRow);
  renderCharacterQuickSelect(body, fields, scene);
  if (negs.length) {
    body.appendChild(el("h4", { text: "Negative fields" }));
    renderFieldList(body, negs, true);
  }

  // -------- settings --------
  body.appendChild(el("h4", { text: "Profile & output" }));
  const setRow = el("div", { class: "pf-row" });
  const profSel = el("select", {
    onchange: () => {
      state.settings.modelProfile = profSel.value;
      applyProfileRecommendedSettings(PF.getProfile(profSel.value));
      commitAndRender(); // re-render so negative-severity/output-mode dropdowns show the new values
    },
  });
  PF.listProfiles().forEach((p) => profSel.appendChild(new Option(p.label, p.id)));
  profSel.value = state.settings.modelProfile;
  const modeSel = el("select", {
    onchange: () => {
      state.settings.outputMode = modeSel.value;
      refresh();
    },
  });
  [["single", "single scene"], ["scenes_joined", "scenes joined"], ["break_blocks", "BREAK blocks"]].forEach(
    ([v, l]) => modeSel.appendChild(new Option(l, v))
  );
  modeSel.value = state.settings.outputMode;
  const sevSel = el("select", {
    onchange: () => {
      state.settings.negativeSeverity = sevSel.value;
      refresh();
    },
  });
  ["off", "minimal", "normal", "strict", "nuclear"].forEach((v) => sevSel.appendChild(new Option("neg: " + v, v)));
  sevSel.value = state.settings.negativeSeverity;
  setRow.appendChild(profSel);
  setRow.appendChild(modeSel);
  setRow.appendChild(sevSel);
  body.appendChild(setRow);
  if (state.settings.outputMode === "scenes_joined") {
    const joinSel = el("select", {
      onchange: () => {
        state.settings.sceneJoiner = joinSel.value;
        refresh();
      },
    });
    ["comma", "newline", "BREAK"].forEach((v) => joinSel.appendChild(new Option("joiner: " + v, v)));
    joinSel.value = state.settings.sceneJoiner;
    body.appendChild(el("div", { class: "pf-row" }, joinSel));
  }

  // -------- preview + lint --------
  body.appendChild(el("h4", { text: "Live preview (no queue needed)" }));
  body.appendChild(el("div", { class: "pf-preview", id: "pf-prev-pos" }));
  body.appendChild(el("div", { class: "pf-preview neg", id: "pf-prev-neg" }));
  body.appendChild(el("div", { id: "pf-lint" }));
  body.appendChild(
    el("div", { class: "pf-row" },
      el("button", {
        text: "copy positive",
        onclick: () => copyText(PF.compilePromptForgeState(state, {}).positive),
      }),
      el("button", {
        text: "copy negative",
        onclick: () => copyText(PF.compilePromptForgeState(state, {}).negative),
      })
    )
  );

  // -------- negative cleaner --------
  renderNegativeCleaner(body);

  // -------- LLM --------
  renderLLMSection(body);

  // -------- variants --------
  body.appendChild(el("h4", { text: "Wildcard variants" }));
  body.appendChild(
    el("div", { class: "pf-muted", text: "Re-rolls {a|b|c} choices in unlocked fields. 'use' writes that variant into the node." })
  );
  const varRow = el("div", { class: "pf-row" });
  const varCount = el("input", { type: "number", value: "4", min: "1", max: "20" });
  varRow.appendChild(varCount);
  varRow.appendChild(
    el("button", {
      text: "Generate variants",
      onclick: () => {
        const n = Math.max(1, Math.min(20, parseInt(varCount.value, 10) || 4));
        const variants = PF.generateVariants(state, {}, n);
        const box = panel.querySelector("#pf-variants");
        box.innerHTML = "";
        variants.forEach((v) => {
          const row = el("div", { class: "pf-variant" });
          row.appendChild(el("div", { class: "pf-variant-text", text: v.positive }));
          row.appendChild(
            el("div", { class: "pf-row" },
              el("button", { text: "copy", onclick: () => copyText(v.positive) }),
              el("button", {
                text: "use",
                title: "write this variant into compiled_positive",
                onclick: () => {
                  writeEnhancedToNode(v.positive);
                  setStatus(`Variant ${v.index} written to the node.`);
                },
              })
            )
          );
          box.appendChild(row);
        });
      },
    })
  );
  body.appendChild(varRow);
  body.appendChild(el("div", { id: "pf-variants" }));

  // -------- templates --------
  renderTemplateSection(body, scene);

  // -------- project import/export --------
  body.appendChild(el("h4", { text: "Project import / export" }));
  body.appendChild(
    el("div", {
      class: "pf-muted",
      text: "Exports the full Prompt Forge state as JSON. Import also accepts exports from the old standalone prompt-forge.html app (migration path).",
    })
  );
  const ioRow = el("div", { class: "pf-row" });
  ioRow.appendChild(
    el("button", {
      text: "Export project JSON",
      onclick: () => {
        const blob = new Blob([PF.exportProject(state)], { type: "application/json" });
        const a = el("a", { download: "promptforge_project.json" });
        a.href = URL.createObjectURL(blob);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      },
    })
  );
  const fileInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const res = PF.importProject(String(reader.result));
        state = res.state;
        uiTab = "global";
        commitAndRender();
        setStatus("Project imported." + (res.issues.length ? ` (${res.issues.length} repair note(s) — see console)` : ""));
        if (res.issues.length) console.warn("[PromptForge.Panel] import repairs:", res.issues);
      } catch (e) {
        setStatus("Import failed: " + e.message, true);
      }
      fileInput.value = "";
    };
    reader.readAsText(file);
  };
  ioRow.appendChild(el("button", { text: "Import project JSON…", onclick: () => fileInput.click() }));
  ioRow.appendChild(fileInput);
  body.appendChild(ioRow);

  // -------- target routing --------
  body.appendChild(el("h4", { text: "Target routing (direct write fallback)" }));
  body.appendChild(
    el("div", {
      class: "pf-muted",
      text: "Prefer wiring the Composer outputs into your encoders. This writes text straight into a node's text widget instead.",
    })
  );
  const encoders = getTextEncodeNodes();
  const posSel = el("select", { id: "pf-target-pos" });
  const negSel = el("select", { id: "pf-target-neg" });
  posSel.appendChild(new Option("Positive target: none", ""));
  negSel.appendChild(new Option("Negative target: none", ""));
  encoders.forEach((n) => {
    const label = `#${n.id} ${n.title || n.comfyClass || n.type}`;
    posSel.appendChild(new Option("→ " + label, n.id));
    negSel.appendChild(new Option("→ " + label, n.id));
  });
  const savedPos = sessionStorage.getItem(POS_TARGET_KEY);
  const savedNeg = sessionStorage.getItem(NEG_TARGET_KEY);
  if (savedPos && [...posSel.options].some((o) => o.value === savedPos)) posSel.value = savedPos;
  if (savedNeg && [...negSel.options].some((o) => o.value === savedNeg)) negSel.value = savedNeg;
  posSel.onchange = () => sessionStorage.setItem(POS_TARGET_KEY, posSel.value);
  negSel.onchange = () => sessionStorage.setItem(NEG_TARGET_KEY, negSel.value);
  body.appendChild(el("div", { class: "pf-row" }, posSel));
  body.appendChild(el("div", { class: "pf-row" }, negSel));
  body.appendChild(
    el("div", { class: "pf-row" },
      el("button", {
        text: "Write prompts into targets",
        onclick: () => {
          const compiled = writeToNode() || PF.compilePromptForgeState(state, {});
          let wrote = 0;
          [[posSel.value, compiled.positive], [negSel.value, compiled.negative]].forEach(([id, text]) => {
            if (!id) return;
            const n = app.graph?.getNodeById?.(parseInt(id, 10));
            const w = n && getWidget(n, "text");
            if (!w) {
              setStatus(`Target #${id} disappeared — re-detect targets.`, true);
              return;
            }
            w.value = text;
            n.setDirtyCanvas?.(true, true);
            wrote++;
          });
          if (wrote) setStatus(`Wrote into ${wrote} target(s).`);
        },
      })
    )
  );

  // -------- graph helper + status --------
  body.appendChild(el("h4", { text: "Graph check" }));
  body.appendChild(el("div", { id: "pf-graph-helper" }));
  body.appendChild(el("div", { class: "pf-status", id: "pf-status" }));

  writeToNode();
  renderPreview();
  renderGraphHelper();
}

// ------------------------------------------------------------------- LLM ----
function renderLLMSection(body) {
  body.appendChild(el("h4", { text: "LLM enhance (optional)" }));
  const cfg = llmConfig || {};
  const provSel = el("select");
  [["local", "Local server"], ["anthropic", "Anthropic API"]].forEach(([v, l]) =>
    provSel.appendChild(new Option(l, v))
  );
  provSel.value = cfg.provider || "local";

  const fmtSel = el("select");
  [["openai", "OpenAI-compatible (/v1/chat/completions)"], ["ollama", "Ollama native (/api/chat)"]].forEach(
    ([v, l]) => fmtSel.appendChild(new Option(l, v))
  );
  fmtSel.value = cfg.local_format || "openai";
  const urlIn = el("input", { type: "text", placeholder: "http://127.0.0.1:11434" });
  urlIn.value = cfg.local_url || "";
  const modelIn = el("input", { type: "text", placeholder: "model name, e.g. qwen2.5:14b" });
  modelIn.value = cfg.local_model || "";

  const antModelIn = el("input", { type: "text", placeholder: "claude-sonnet-5" });
  antModelIn.value = cfg.anthropic_model || "";
  const antKeyIn = el("input", {
    type: "password",
    placeholder: cfg.anthropic_key_set ? "key saved on server — blank keeps it" : "sk-ant-… (stored server-side only)",
  });

  const localBox = el("div", null,
    el("div", { class: "pf-row" }, fmtSel),
    el("div", { class: "pf-row" }, urlIn, modelIn),
  );
  const antBox = el("div", null,
    el("div", { class: "pf-row" }, antModelIn, antKeyIn),
    el("div", { class: "pf-muted", text: "The key is stored in ComfyUI's Prompt Forge data folder, never in exports or workflows." }),
  );
  const showBoxes = () => {
    localBox.style.display = provSel.value === "local" ? "" : "none";
    antBox.style.display = provSel.value === "anthropic" ? "" : "none";
  };
  provSel.onchange = showBoxes;
  showBoxes();

  const themeIn = el("input", { type: "text", placeholder: "theme / idea (optional) — e.g. solarpunk, noir detective" });
  themeIn.id = "pf-llm-theme";
  // Kept in sessionStorage, not just a fresh DOM default: the panel body is
  // rebuilt on every field edit, and the browser tab clears this on close —
  // "remember while ComfyUI is open, forget after" as requested.
  themeIn.value = sessionStorage.getItem(LLM_THEME_KEY) || "";
  themeIn.oninput = () => sessionStorage.setItem(LLM_THEME_KEY, themeIn.value);

  const saveConfig = async () => {
    llmConfig = await api("/promptforge/config", {
      provider: provSel.value,
      local_format: fmtSel.value,
      local_url: urlIn.value.trim(),
      local_model: modelIn.value.trim(),
      anthropic_model: antModelIn.value.trim(),
      anthropic_key: antKeyIn.value.trim(), // blank = keep existing
    });
    antKeyIn.value = "";
    antKeyIn.placeholder = llmConfig.anthropic_key_set ? "key saved on server — blank keeps it" : "sk-ant-…";
  };

  body.appendChild(el("div", { class: "pf-row" }, provSel));
  body.appendChild(localBox);
  body.appendChild(antBox);
  body.appendChild(el("div", { class: "pf-row" }, themeIn));
  body.appendChild(
    el("div", { class: "pf-row" },
      el("button", {
        class: "pf-primary",
        text: "Enhance output via LLM",
        onclick: async () => {
          try {
            await saveConfig();
            await enhancePrompt(themeIn.value.trim());
          } catch (e) {
            setLLMStatus("Error: " + e.message, true);
          }
        },
      }),
      el("button", {
        text: "Generate full draft with AI",
        onclick: async () => {
          try {
            await saveConfig();
            await generateFullDraft(themeIn.value.trim());
          } catch (e) {
            setLLMStatus("Error: " + e.message, true);
          }
        },
      })
    )
  );
  body.appendChild(el("div", { class: "pf-status", id: "pf-llm-status" }));
  body.appendChild(
    el("div", {
      class: "pf-muted",
      text: "Draft fills the active scene + global fields from one AI call. Locked fields are never overwritten. Enhance rewrites only the compiled output, not your fields.",
    })
  );
}

function setLLMStatus(msg, isErr) {
  const s = panel?.querySelector("#pf-llm-status");
  if (!s) return;
  s.textContent = msg;
  s.className = "pf-status " + (isErr ? "err" : "ok");
}

function lockedFieldSummary() {
  const out = [];
  const scan = (fields, where) => (fields || []).forEach((f) => {
    if (f.locked && f.text.trim()) out.push(where + " " + f.type + ' = "' + f.text + '"');
  });
  scan(state.global.fields, "global");
  scan(state.global.negativeFields, "global");
  const scene = PF.getActiveScene(state);
  scan(scene.fields, "scene");
  scan(scene.negativeFields, "scene");
  return out;
}

async function enhancePrompt(theme) {
  setLLMStatus("Sending…");
  const compiled = PF.compilePromptForgeState(state, {});
  const profile = PF.getProfile(state.settings.modelProfile);
  const styleInstruction = profile.promptStyle === "natural_language"
    ? "Output ONLY a natural-language descriptive prompt suitable for Flux/Krea/SD3. No explanation, no markdown."
    : "Output ONLY a comma-separated Danbooru-style tag prompt suitable for SDXL/Pony/Illustrious. No explanation, no markdown.";
  const locked = lockedFieldSummary();
  const lockNote = locked.length
    ? "\nThese elements are locked and must appear essentially unchanged: " + locked.join("; ") + "."
    : "";
  const themeNote = theme ? '\nThe creative direction: "' + theme + '" — depict it concretely.' : "";
  const sys = "You are an expert Stable Diffusion / ComfyUI prompt engineer. Expand and refine the given draft into a stronger image prompt. " +
    styleInstruction +
    "\nHard rules:\n- Literal, concrete visual description only. No metaphor or narration.\n- Every phrase must describe something a camera or renderer could depict." +
    themeNote + lockNote;
  const res = await api("/promptforge/llm", { system: sys, user: compiled.positive || "(empty draft)" });
  const text = (res.text || "").trim();
  if (!text) throw new Error("model returned empty text");
  writeEnhancedToNode(text);
  setLLMStatus("Done. (Fields untouched — compiled output only.)");
}

async function generateFullDraft(theme) {
  setLLMStatus("Generating…");
  const genrePool = [
    "nature and wildlife", "urban noir / detective", "cosmic / deep space", "underwater / oceanic",
    "historical / period piece", "steampunk", "post-apocalyptic wasteland", "mythology and folklore",
    "quiet slice-of-life", "gothic horror", "desert and wasteland", "arctic / frozen landscape",
    "dense jungle", "industrial / brutalist architecture", "pastoral countryside", "festival and celebration",
    "surreal / abstract", "high fantasy", "noir cyberpunk", "solarpunk / utopian eco-future",
  ];
  if (!theme) theme = genrePool[Math.floor(Math.random() * genrePool.length)];
  const profile = PF.getProfile(state.settings.modelProfile);
  const styleNote = profile.promptStyle === "natural_language"
    ? "Field values should be short natural-language phrases (a few words each), not full sentences."
    : "Field values should be short comma-separated Danbooru-style tags/phrases (2-5 words each).";
  const locked = lockedFieldSummary();
  const lockNote = locked.length
    ? "\nThese fields are fixed — invent the rest coherently with them: " + locked.join("; ") + "."
    : "";
  const sys = "You invent creative Stable Diffusion / ComfyUI image concepts. " + styleNote +
    "\nEvery field value must be literal, concrete visual description — no metaphor or narration." +
    "\nRespond with ONLY a single valid JSON object, no markdown fences, matching exactly:" +
    '\n{"subject":"","action":"","clothing":"","expression":"","style":"","medium":"","composition":"","camera":"","lighting":"","mood":"","background":"","environment":"","props":"","custom":"","quality":"","negative_additions":"","character":""}' +
    '\n- "character" is a short character tag line like "1girl, adult" or "" if no character.' +
    '\n- "clothing" is what the subject wears; "expression" is facial/emotional expression; "camera" is shot type/lens/angle (distinct from "composition", which is framing/layout).' +
    '\n- "mood" is atmosphere/tone; "environment" is broader setting detail beyond "background"; "props" are notable objects in scene; "custom" is any other distinctive visual detail worth adding.' +
    '\n- Leave a field "" if it genuinely does not apply — do not pad with filler.' +
    '\n- Every field value must be a single line — no literal line breaks; keep each one short (under ~12 words).' +
    "\n- Keep every character an adult; do not invent a minor." + lockNote;
  const res = await api("/promptforge/llm", {
    system: sys,
    user: "Invent one original image concept in this space: " + theme +
      ". Don't default to cyberpunk unless that's the genre given.",
  });
  const data = parseDraftJSON(res.text);
  const scene = PF.getActiveScene(state);
  // Whichever field of a given type already exists — scene or global — is
  // the one the user is looking at, so fill that one. Only fall back to a
  // fixed home collection when neither exists yet.
  const put = (type, text) => {
    if (!text || !String(text).trim()) return;
    let f = scene.fields.find((x) => x.type === type) || state.global.fields.find((x) => x.type === type);
    if (!f) {
      const home = PF.DEFAULT_GLOBAL_FIELD_TYPES.includes(type) ? state.global.fields : scene.fields;
      f = PF.makeField({ type, scope: home === state.global.fields ? "global" : "scene" });
      home.push(f);
    }
    if (f.locked) return;
    f.text = String(text).trim();
  };
  put("subject", data.subject);
  put("action", data.action);
  put("clothing", data.clothing);
  put("expression", data.expression);
  put("composition", data.composition);
  put("camera", data.camera);
  put("lighting", data.lighting);
  put("mood", data.mood);
  put("background", data.background);
  put("environment", data.environment);
  put("props", data.props);
  put("custom", data.custom);
  put("style", data.style);
  put("medium", data.medium);
  put("quality", data.quality);
  put("character", data.character);
  if (data.negative_additions && String(data.negative_additions).trim()) {
    const base = state.global.negativeFields[0];
    if (base && !base.locked) {
      base.text = base.text.trim()
        ? base.text + ", " + data.negative_additions
        : String(data.negative_additions);
    }
  }
  commitAndRender();
  setLLMStatus("Draft generated (genre: " + theme + ")." +
    (locked.length ? " Kept " + locked.length + " locked field(s)." : ""));
}

// --------------------------------------------------------------- random ----
const inspirationPools = {
  subject: ["a red fox", "an old lighthouse keeper", "a chrome android geisha", "a wandering knight", "a street violinist"],
  lighting: ["golden hour rim light", "cold moonlight", "neon glow from signage", "soft overcast light", "candlelit warmth"],
  background: ["misty pine forest", "rain-slick city street", "endless dune sea", "cluttered artisan workshop", "aurora-lit tundra"],
  composition: ["low angle wide shot", "intimate close-up", "rule-of-thirds portrait", "symmetrical center framing", "over-the-shoulder view"],
  action: ["mid-leap", "casting a spell", "reading by lamplight", "sprinting through rain", "standing at a cliff edge"],
};
function randomizeScene() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const scene = PF.getActiveScene(state);
  const fields = uiTab === "global" ? state.global.fields : scene.fields;
  Object.keys(inspirationPools).forEach((type) => {
    let f = fields.find((x) => x.type === type && !x.locked);
    if (!f) f = state.global.fields.find((x) => x.type === type && !x.locked);
    if (f) f.text = pick(inspirationPools[type]);
  });
}

// -------------------------------------------------- negative cleaner ----
// Reconstructs the pre-category-filter term set (global negatives + profile
// severity ladder + in-play scene negatives — the same inputs
// compileNegative() in promptforge_compiler.js starts from, minus forced/
// external text) so every category shows up here even while toggled off.
function rawNegativeSourceText() {
  const profile = PF.getProfile(state.settings.modelProfile);
  const parts = [];
  (state.global.negativeFields || []).forEach((f) => { if (f.enabled) parts.push(f.text); });
  const severity = state.settings.negativeSeverity || (profile.negativePolicy === "minimal" ? "minimal" : "normal");
  if (severity !== "off" && PF.NEG_SEVERITY && PF.NEG_SEVERITY[severity]) parts.push(PF.NEG_SEVERITY[severity]);
  const scenesInPlay = state.settings.outputMode === "single"
    ? [PF.getActiveScene(state)]
    : state.scenes.filter((s) => s.enabled);
  scenesInPlay.forEach((s) => (s.negativeFields || []).forEach((f) => { if (f.enabled) parts.push(f.text); }));
  return parts.join(", ");
}

function renderNegativeCleaner(body) {
  body.appendChild(el("h4", { text: "Negative cleaner (grouped view)" }));
  body.appendChild(
    el("div", {
      class: "pf-muted",
      text: "Click a category to exclude it from the compiled negative. Unknown/custom terms always survive.",
    })
  );
  const box = el("div", { id: "pf-neg-groups" });
  body.appendChild(box);
  renderNegGroups(box);
}

function renderNegGroups(box) {
  box.innerHTML = "";
  const groups = PF.groupNegative(rawNegativeSourceText());
  const off = state.settings.negativeCategoriesOff || [];
  let any = false;
  PF.NEG_CATEGORIES.forEach((cat) => {
    const terms = groups[cat.id] || [];
    if (!terms.length) return;
    any = true;
    const isOff = off.includes(cat.id);
    const row = el("div", { class: "pf-row" });
    row.appendChild(
      el("button", {
        class: isOff ? "" : "pf-on",
        text: (isOff ? "excluded — " : "included — ") + cat.label + ` (${terms.length})`,
        title: terms.join(", "),
        onclick: () => {
          const idx = state.settings.negativeCategoriesOff.indexOf(cat.id);
          if (idx === -1) state.settings.negativeCategoriesOff.push(cat.id);
          else state.settings.negativeCategoriesOff.splice(idx, 1);
          refresh();
          renderNegGroups(box);
        },
      })
    );
    box.appendChild(row);
  });
  if (groups.custom.length) {
    any = true;
    box.appendChild(
      el("div", { class: "pf-muted", text: `Custom/unknown (always kept): ${groups.custom.join(", ")}` })
    );
  }
  if (!any) {
    box.appendChild(el("div", { class: "pf-muted", text: "No negative terms yet." }));
  }
}

// --------------------------------------------------- character quick-fill ----
// Not present in the current standalone-app markup (only referenced by the
// v1 migration code as a historical convention) — built fresh here using
// that same tag mapping so it stays consistent with how the app already
// interprets these tags on import.
const GENDER_TAGS = { female: "1girl", male: "1boy", androgynous: "1other" };
const AGE_TAGS = {
  young_adult: "young adult", adult: "adult",
  middle_aged: "middle-aged", elderly: "elderly",
};
function renderCharacterQuickSelect(body, fields, scene) {
  const box = el("div", { class: "pf-row", title: "Quick-fills the Character field with a starting tag — edit freely after." });
  const genderSel = el("select");
  genderSel.appendChild(new Option("gender: unspecified", ""));
  Object.keys(GENDER_TAGS).forEach((k) => genderSel.appendChild(new Option(k, k)));
  const ageSel = el("select");
  ageSel.appendChild(new Option("age: unspecified", ""));
  Object.keys(AGE_TAGS).forEach((k) => ageSel.appendChild(new Option(AGE_TAGS[k], k)));
  box.appendChild(genderSel);
  box.appendChild(ageSel);
  box.appendChild(
    el("button", {
      text: "→ Character",
      onclick: () => {
        const parts = [GENDER_TAGS[genderSel.value], AGE_TAGS[ageSel.value]].filter(Boolean);
        if (!parts.length) return setStatus("Pick a gender or age first.", true);
        let f = fields.find((x) => x.type === "character") || state.global.fields.find((x) => x.type === "character");
        if (!f) {
          f = PF.makeField({ type: "character", scope: scene ? "scene" : "global" });
          fields.push(f);
        }
        if (f.locked) return setStatus("Character field is locked.", true);
        f.text = parts.join(", ");
        commitAndRender();
      },
    })
  );
  body.appendChild(box);
}

// ------------------------------------------------------------- templates ----
function renderTemplateSection(body, scene) {
  body.appendChild(el("h4", { text: "Template library (shared across workflows)" }));
  const listBox = el("div", { id: "pf-templates" });

  const renderList = () => {
    listBox.innerHTML = "";
    if (!templates.length) {
      listBox.appendChild(el("div", { class: "pf-muted", text: "No saved templates yet." }));
      return;
    }
    templates.forEach((tpl, i) => {
      const row = el("div", { class: "pf-row" });
      row.appendChild(el("div", { class: "pf-tpl-name", text: tpl.name || "(unnamed)" }));
      row.appendChild(
        el("button", {
          text: "apply",
          title: "fill matching fields on the current tab (locked fields kept)",
          onclick: () => {
            const target = scene ? scene.fields : state.global.fields;
            (tpl.fields || []).forEach((tf) => {
              let f = target.find((x) => x.type === tf.type);
              if (!f) {
                f = PF.makeField({ type: tf.type });
                target.push(f);
              }
              if (!f.locked) f.text = tf.text || "";
            });
            if (tpl.negative && state.global.negativeFields[0] && !state.global.negativeFields[0].locked) {
              state.global.negativeFields[0].text = tpl.negative;
            }
            commitAndRender();
            setStatus(`Template "${tpl.name}" applied.`);
          },
        })
      );
      row.appendChild(
        el("button", {
          text: "×",
          onclick: async () => {
            if (!confirm(`Delete template "${tpl.name}"?`)) return;
            templates.splice(i, 1);
            try {
              await api("/promptforge/templates", templates);
            } catch (e) {
              setStatus("Could not save templates: " + e.message, true);
            }
            renderList();
          },
        })
      );
      listBox.appendChild(row);
    });
  };

  body.appendChild(
    el("div", { class: "pf-row" },
      el("button", {
        text: "Save current tab as template",
        onclick: async () => {
          const name = prompt("Template name:", scene ? scene.name : "Global fields");
          if (name === null) return;
          const src = scene ? scene.fields : state.global.fields;
          templates.push({
            id: "tpl_" + Date.now().toString(36),
            name: (name || "").trim() || "Template",
            kind: "panel_template",
            fields: src.filter((f) => f.text.trim()).map((f) => ({ type: f.type, text: f.text })),
            negative: "",
          });
          try {
            await api("/promptforge/templates", templates);
            setStatus("Template saved.");
          } catch (e) {
            setStatus("Could not save templates: " + e.message, true);
          }
          renderList();
        },
      })
    )
  );
  body.appendChild(listBox);
  renderList();
}

// --------------------------------------------------------------- preview ----
function renderFieldList(body, fields, isNeg) {
  fields.forEach((f, i) => {
    const box = el("div", { class: "pf-field" + (isNeg ? " neg" : "") + (f.enabled ? "" : " disabled") });
    const head = el("div", { class: "pf-field-head" });
    head.appendChild(el("span", { class: "pf-type", text: f.type + (f.label !== (PF.TYPE_LABELS[f.type] || "") ? " · " + f.label : "") }));
    head.appendChild(
      el("button", {
        class: f.enabled ? "pf-on" : "",
        text: f.enabled ? "on" : "off",
        onclick: () => {
          f.enabled = !f.enabled;
          commitAndRender();
        },
      })
    );
    head.appendChild(
      el("button", {
        class: f.locked ? "pf-on" : "",
        text: "🔒",
        title: "lock — protected from AI edits/variations",
        onclick: () => {
          f.locked = !f.locked;
          commitAndRender();
        },
      })
    );
    head.appendChild(
      el("button", {
        text: "↑",
        disabled: i === 0 ? "true" : undefined,
        onclick: () => {
          [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
          commitAndRender();
        },
      })
    );
    head.appendChild(
      el("button", {
        text: "↓",
        disabled: i === fields.length - 1 ? "true" : undefined,
        onclick: () => {
          [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
          commitAndRender();
        },
      })
    );
    const w = el("input", { class: "pf-w", type: "number", step: "0.05", min: "0", title: "weight" });
    w.value = f.weight;
    w.onchange = () => {
      f.weight = parseFloat(w.value) || 1;
      refresh();
    };
    head.appendChild(w);
    head.appendChild(
      el("button", {
        text: "×",
        onclick: () => {
          fields.splice(i, 1);
          commitAndRender();
        },
      })
    );
    box.appendChild(head);
    const ta = el("textarea", { rows: "1" });
    ta.value = f.text;
    ta.oninput = () => {
      f.text = ta.value;
      refresh();
    };
    box.appendChild(ta);
    body.appendChild(box);
  });
  if (!fields.length && !isNeg) {
    body.appendChild(el("div", { class: "pf-muted", text: "No fields on this tab yet." }));
  }
}

function renderPreview() {
  const pos = panel?.querySelector("#pf-prev-pos");
  const neg = panel?.querySelector("#pf-prev-neg");
  const lintBox = panel?.querySelector("#pf-lint");
  if (!pos || !state) return;
  const compiled = PF.compilePromptForgeState(state, {});
  pos.textContent = compiled.positive || "(empty positive prompt)";
  neg.textContent = compiled.negative || "(empty negative prompt)";
  if (lintBox) {
    lintBox.innerHTML = "";
    const lint = PF.lintCompiled(state, compiled);
    lintBox.appendChild(el("div", { class: "pf-muted", text: `Prompt health: ${lint.score}/100` }));
    lint.warnings.slice(0, 6).forEach((wrn) => {
      lintBox.appendChild(el("div", { class: "pf-lint " + (wrn.severity === "info" ? "info" : ""), text: wrn.message }));
    });
    if (lint.warnings.length > 6) {
      lintBox.appendChild(el("div", { class: "pf-muted", text: `… ${lint.warnings.length - 6} more warnings` }));
    }
  }
}

function renderGraphHelper() {
  const boxEl = panel?.querySelector("#pf-graph-helper");
  if (!boxEl) return;
  boxEl.innerHTML = "";
  const node = currentNode();
  const line = (ok, text) =>
    boxEl.appendChild(el("div", { class: "pf-check", text: (ok ? "✓ " : "⚠ ") + text }));
  line(!!node, node ? `Composer node #${node.id} found` : "No Composer node selected");
  if (node) {
    const posLinked = node.outputs?.[0]?.links?.length > 0;
    const negLinked = node.outputs?.[1]?.links?.length > 0;
    line(posLinked, posLinked ? "positive output wired" : "positive output not wired");
    line(negLinked, negLinked ? "negative output wired" : "negative output not wired");
  }
  const enc = getTextEncodeNodes().length;
  line(enc > 0, enc + " text-encode node(s) detected");
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => setStatus("Copied."),
    () => setStatus("Clipboard blocked by the browser.", true)
  );
}

function setStatus(msg, isErr) {
  const s = panel?.querySelector("#pf-status");
  if (!s) return;
  s.textContent = msg;
  s.className = "pf-status " + (isErr ? "err" : "ok");
  setTimeout(() => {
    if (s.textContent === msg) s.textContent = "";
  }, 4000);
}

function buildPanel() {
  panel = el("div", { id: "pf-panel" });
  const head = el(
    "h3",
    null,
    "PROMPT",
    el("span", { text: "." }),
    "FORGE ",
    el("button", {
      text: "↻ rescan graph",
      style: "float:right; margin-left:6px;",
      onclick: () => renderPanel(),
    }),
    el("button", {
      text: "✕",
      style: "float:right;",
      onclick: () => panel.classList.remove("open"),
    })
  );
  panel.appendChild(head);
  panel.appendChild(el("div", { id: "pf-body" }));

  const savedWidth = parseInt(sessionStorage.getItem(PANEL_WIDTH_KEY), 10);
  if (savedWidth) panel.style.width = savedWidth + "px";

  // Drag the left edge to resize. The panel is anchored with right:8px, so
  // growing its width (via getBoundingClientRect, not a stored delta — the
  // panel may already be at its min/max clamp) naturally extends it leftward.
  const handle = el("div", { id: "pf-resize-handle", title: "drag to resize" });
  handle.onmousedown = (downEvent) => {
    downEvent.preventDefault();
    const startX = downEvent.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    handle.classList.add("dragging");
    const onMove = (moveEvent) => {
      const delta = startX - moveEvent.clientX; // dragging left (negative clientX delta) grows the panel
      panel.style.width = startWidth + delta + "px";
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      sessionStorage.setItem(PANEL_WIDTH_KEY, Math.round(panel.getBoundingClientRect().width));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  panel.appendChild(handle);

  document.body.appendChild(panel);
}

async function togglePanel() {
  if (!panel) buildPanel();
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
    // Best-effort server data; the panel works without it.
    try { if (!llmConfig) llmConfig = await api("/promptforge/config"); } catch (e) { console.warn("[PromptForge.Panel] config load failed:", e); }
    try { templates = (await api("/promptforge/templates")) || []; } catch (e) { console.warn("[PromptForge.Panel] templates load failed:", e); }
    const node = currentNode();
    if (node) state = loadStateFromNode(node);
    renderPanel();
  }
}

// ----------------------------------------------------------- registration ----
app.registerExtension({
  name: "PromptForge.Panel",
  async setup() {
    // Load the shared core. These files are classic scripts (they attach to
    // globalThis.PromptForge) — importing them as modules executes them fine.
    const base = new URL(".", import.meta.url);
    try {
      await import(new URL("promptforge_state.js", base));
      await import(new URL("promptforge_profiles.js", base));
      await import(new URL("promptforge_linter.js", base));
      await import(new URL("promptforge_compiler.js", base));
      PF = globalThis.PromptForge;
    } catch (e) {
      console.error("[PromptForge.Panel] failed to load core scripts:", e);
      return;
    }
    if (!PF?.compilePromptForgeState) {
      console.error("[PromptForge.Panel] core loaded but compiler missing — panel disabled.");
      return;
    }

    // Panel stylesheet.
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("promptforge_ui.css", base).href;
    document.head.appendChild(link);

    // Menu button: use the modern menu API when present, otherwise (or
    // additionally, it is harmless) a floating button.
    let menuButtonAdded = false;
    try {
      // ComfyUI >= 1.x button group API
      const { ComfyButton } = await import("/scripts/ui/components/button.js");
      const btn = new ComfyButton({
        icon: "anvil",
        tooltip: "Prompt Forge",
        content: "Prompt Forge",
        action: togglePanel,
      });
      app.menu?.settingsGroup?.element?.before?.(btn.element);
      menuButtonAdded = !!btn.element?.isConnected;
    } catch (e) {
      /* older frontend — fall through to floating button */
    }
    if (!menuButtonAdded) {
      const fbtn = el("button", { id: "pf-toggle-btn", text: "⚒ Prompt Forge", onclick: togglePanel });
      document.body.appendChild(fbtn);
    }
    console.log("[PromptForge.Panel] ready (menu button: " + menuButtonAdded + ")");
  },
});
