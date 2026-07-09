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
 *   - target routing: write prompts directly into text-encode nodes
 *
 * Every edit recompiles via the shared core (promptforge_compiler.js — the
 * same code the standalone HTML uses) and writes state_json,
 * compiled_positive, compiled_negative and metadata_json into the node's
 * widgets, then marks the canvas dirty. State therefore lives inside the
 * workflow file and survives save/reload with no server.
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
const POS_TARGET_KEY = "PromptForge.posTarget";
const NEG_TARGET_KEY = "PromptForge.negTarget";

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
  body.appendChild(addRow);
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
      refresh();
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
      lintBox.appendChild(el("div", { class: "pf-muted", text: `… ${lint.warnings.length - 6} more in the standalone app` }));
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
  document.body.appendChild(panel);
}

function togglePanel() {
  if (!panel) buildPanel();
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
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
