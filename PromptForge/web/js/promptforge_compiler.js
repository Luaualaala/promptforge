/*
 * Prompt Forge — pure state -> prompt compiler.
 * Classic script, attaches to globalThis.PromptForge. No DOM access, no
 * network: everything here must run identically in the browser page, the
 * ComfyUI frontend, and Node (tests).
 *
 * Main entry:
 *   PromptForge.compilePromptForgeState(state, options) -> {
 *     positive, negative, positivePreview, negativePreview,
 *     metadata (object), scenes ([{id,name,enabled,positive,negative}]),
 *     sourceMap ([{text, fieldId, sceneId, source, start, end}])
 *   }
 *
 * options (all optional — used by the Composer node / panel):
 *   forcedPositive, forcedNegative : STRING
 *   forcedPosition                 : "prepend" | "append"
 *   externals: { positiveA, positiveB, negativeA, metadata } raw STRING values
 *   rng                            : function() -> [0,1) for wildcard picks
 */
(function (global) {
  "use strict";
  const PF = (global.PromptForge = global.PromptForge || {});

  // ------------------------------------------------------- text helpers ----
  // Split a comma-separated phrase list, but never inside (...) groups so
  // weighted tags like "(wet hair:1.2)" survive as one phrase. Preserves
  // case, quotes, and non-ASCII text exactly (spec 18.1).
  function splitPhrases(text) {
    const out = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out
      .map(function (p) {
        return p.trim();
      })
      .filter(function (p) {
        return p.length > 0;
      });
  }
  PF.splitPhrases = splitPhrases;

  function cleanupText(text) {
    return splitPhrases(String(text == null ? "" : text)).join(", ");
  }
  PF.cleanupText = cleanupText;

  function looksWeighted(phrase) {
    return /^\(.*:\s*[\d.]+\s*\)$/.test(phrase.trim());
  }

  function applyWeight(phrase, weight, profile) {
    if (!profile.supportsWeights || profile.weightSyntax === "none") return phrase;
    if (typeof weight !== "number" || !isFinite(weight) || weight === 1) return phrase;
    if (looksWeighted(phrase)) return phrase; // user already weighted it manually
    const w = Math.round(weight * 100) / 100;
    return "(" + phrase + ":" + w + ")";
  }
  PF.applyWeight = applyWeight;

  // -------------------------------------------------------- wildcards ----
  // {sunny|stormy|foggy} -> one option. pickFirst forces the first option
  // (used for locked fields so they never vary between variants).
  function expandWildcards(text, rng, pickFirst) {
    return String(text == null ? "" : text).replace(
      /\{([^{}]+)\}/g,
      function (m, body) {
        const options = body.split("|");
        if (options.length < 2) return m; // not a wildcard — leave untouched
        if (pickFirst) return options[0];
        const r = rng ? rng() : Math.random();
        return options[Math.max(0, Math.min(options.length - 1, Math.floor(r * options.length)))];
      }
    );
  }
  PF.expandWildcards = expandWildcards;

  function hasWildcards(text) {
    return /\{[^{}]*\|[^{}]*\}/.test(String(text == null ? "" : text));
  }
  PF.hasWildcards = hasWildcards;

  // Deterministic RNG for reproducible variants/tests.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  PF.mulberry32 = mulberry32;

  // ------------------------------------------------- ordering constants ----
  // A single numeric axis merges global fields, scene fields, forced text
  // and external inputs into one deterministic compile order (spec 4.4).
  const EXTERNAL_POSITION_KEYS = {
    forced_prepend: -100,
    before_character: 9.5,
    after_character: 10.5,
    before_scene: 19.5,
    after_scene: 75,
    before_quality: 79.5,
    forced_append: 1000,
  };
  PF.EXTERNAL_POSITIONS = Object.keys(EXTERNAL_POSITION_KEYS);

  const FORCED_PREPEND_KEY = -200;
  const FORCED_APPEND_KEY = 2000;

  // ------------------------------------------------------- scene compile ----
  // Returns ordered contribution items: { text, fieldId, sceneId, source, key }
  function collectSceneItems(state, scene, profile, options) {
    const items = [];

    function pushField(field, sceneId, sourcePrefix, scopeRank) {
      if (!field.enabled) return;
      const raw = cleanupText(field.text);
      if (!raw) return;
      splitPhrases(raw).forEach(function (phrase, i) {
        items.push({
          text: applyWeight(phrase, field.weight, profile),
          fieldId: field.id,
          sceneId: sceneId,
          source: sourcePrefix + "." + (field.label || field.type),
          key:
            (typeof field.position === "number"
              ? field.position
              : PF.TYPE_ORDER[field.type] || 70) +
            scopeRank * 0.01 +
            i * 0.0001,
        });
      });
    }

    // Forced text from the Composer node widgets / options.
    const forcedPos = cleanupText(options.forcedPositive || "");
    if (forcedPos) {
      const key =
        (options.forcedPosition || "prepend") === "append"
          ? FORCED_APPEND_KEY
          : FORCED_PREPEND_KEY;
      splitPhrases(forcedPos).forEach(function (phrase, i) {
        items.push({
          text: phrase,
          fieldId: "forced",
          sceneId: scene.id,
          source: "forced.positive",
          key: key + i * 0.0001,
        });
      });
    }

    (state.global.fields || []).forEach(function (f) {
      pushField(f, "global", "global", 0);
    });
    (scene.fields || []).forEach(function (f) {
      pushField(f, scene.id, "scene", 1);
    });

    // Generic external STRING inputs (never LoRA-specific — spec 13).
    const externals = options.externals || {};
    ["positiveA", "positiveB"].forEach(function (slot, slotIdx) {
      const rawVal = cleanupText(externals[slot] || "");
      if (!rawVal) return;
      const conf = (state.externals && state.externals[slot]) || {};
      const posName = EXTERNAL_POSITION_KEYS.hasOwnProperty(conf.position)
        ? conf.position
        : state.settings.externalPosition || "before_quality";
      const baseKey = EXTERNAL_POSITION_KEYS[posName];
      splitPhrases(rawVal).forEach(function (phrase, i) {
        items.push({
          text: phrase, // preserved exactly, incl. non-ASCII (13.5)
          fieldId: "external_" + slot,
          sceneId: scene.id,
          source: "external." + (conf.label || slot),
          key: baseKey + slotIdx * 0.001 + i * 0.0001,
        });
      });
    });

    items.sort(function (a, b) {
      return a.key - b.key;
    });
    return items;
  }

  function dedupeItems(items, enabled) {
    if (!enabled) return items;
    const seen = Object.create(null);
    return items.filter(function (it) {
      // Exact-match dedupe only — never fuzzy, never case-folded (spec 13.4/21).
      if (seen[it.text]) return false;
      seen[it.text] = true;
      return true;
    });
  }

  function compileSceneText(state, scene, profile, options) {
    const items = dedupeItems(
      collectSceneItems(state, scene, profile, options),
      state.settings.dedupePositive !== false
    );
    return {
      text: items
        .map(function (it) {
          return it.text;
        })
        .join(profile.separator || ", "),
      items: items,
    };
  }

  // ---------------------------------------------------- negative compile ----
  function compileNegative(state, profile, options, scenesInPlay) {
    const parts = []; // { text, source }
    function pushRaw(raw, source) {
      splitPhrases(cleanupText(raw)).forEach(function (p) {
        parts.push({ text: p, source: source });
      });
    }

    // 1. base global negatives
    (state.global.negativeFields || []).forEach(function (f) {
      if (f.enabled) pushRaw(f.text, "global." + (f.label || "negative"));
    });

    // 2. model-profile negatives via the severity ladder. "off" disables the
    // profile ladder entirely; user text above is always preserved.
    const severity =
      state.settings.negativeSeverity ||
      (profile.negativePolicy === "minimal" ? "minimal" : "normal");
    if (severity !== "off" && PF.NEG_SEVERITY && PF.NEG_SEVERITY[severity]) {
      pushRaw(PF.NEG_SEVERITY[severity], "profile." + severity);
    }

    // 3. scene negatives (only scenes that are part of the output)
    scenesInPlay.forEach(function (scene) {
      (scene.negativeFields || []).forEach(function (f) {
        if (f.enabled) pushRaw(f.text, "scene." + scene.name);
      });
    });

    // 4. forced negatives (Composer widget / options)
    if (options.forcedNegative) pushRaw(options.forcedNegative, "forced.negative");

    // 5. generic external negative input
    if (options.externals && options.externals.negativeA) {
      const label =
        (state.externals && state.externals.negativeA && state.externals.negativeA.label) ||
        "negativeA";
      pushRaw(options.externals.negativeA, "external." + label);
    }

    // Category toggles from the negative cleaner (categories live in the
    // linter module; resolved lazily so load order doesn't matter).
    let filtered = parts;
    const catsOff = state.settings.negativeCategoriesOff || [];
    if (catsOff.length && typeof PF.categorizeNegativeTerm === "function") {
      filtered = parts.filter(function (p) {
        const cat = PF.categorizeNegativeTerm(p.text);
        return !(cat && catsOff.includes(cat));
      });
    }

    const deduped = [];
    const seen = Object.create(null);
    filtered.forEach(function (p) {
      if (state.settings.dedupeNegative !== false && seen[p.text]) return;
      seen[p.text] = true;
      deduped.push(p);
    });

    return {
      text: deduped
        .map(function (p) {
          return p.text;
        })
        .join(", "),
      items: deduped,
    };
  }

  // ------------------------------------------------------------- compile ----
  function compilePromptForgeState(state, options) {
    options = options || {};
    const profile = PF.getProfile
      ? PF.getProfile(state.settings.modelProfile)
      : { separator: ", ", supportsWeights: false, weightSyntax: "none" };

    const outputMode = state.settings.outputMode || "single";
    const enabledScenes = state.scenes.filter(function (s) {
      return s.enabled;
    });
    const activeScene = PF.getActiveScene(state);

    let scenesInPlay;
    if (outputMode === "single") {
      scenesInPlay = [activeScene];
    } else {
      scenesInPlay = enabledScenes.length ? enabledScenes : [activeScene];
    }

    // Per-scene compile (global fields repeat inside every scene block).
    const sceneResults = scenesInPlay.map(function (scene) {
      const res = compileSceneText(state, scene, profile, options);
      return { scene: scene, text: res.text, items: res.items };
    });

    // Joiner between scene blocks.
    let joiner = ", ";
    if (outputMode === "break_blocks") {
      joiner = "\nBREAK\n";
    } else if (outputMode === "scenes_joined") {
      const j = state.settings.sceneJoiner || "comma";
      joiner =
        j === "newline"
          ? "\n"
          : j === "BREAK"
            ? "\nBREAK\n"
            : j === "custom"
              ? state.settings.sceneJoinerCustom || ", "
              : ", ";
    }

    // Assemble the final positive string while tracking source-map offsets.
    let positive = "";
    const sourceMap = [];
    sceneResults.forEach(function (res, idx) {
      if (idx > 0) positive += joiner;
      let cursor = positive.length;
      res.items.forEach(function (it, i) {
        if (i > 0) {
          positive += profile.separator || ", ";
          cursor = positive.length;
        }
        positive += it.text;
        sourceMap.push({
          text: it.text,
          fieldId: it.fieldId,
          sceneId: it.sceneId,
          source: it.source,
          start: cursor,
          end: positive.length,
        });
        cursor = positive.length;
      });
    });

    const negRes = compileNegative(state, profile, options, scenesInPlay);
    const negative = negRes.text;

    // Previews keep scene blocks visibly separated for display nodes.
    const positivePreview = sceneResults
      .map(function (res) {
        return "[" + res.scene.name + "]\n" + res.text;
      })
      .join("\n\n");
    const negativePreview =
      "[negative]\n" +
      (negRes.items.length
        ? negRes.items
            .map(function (p) {
              return p.text;
            })
            .join(", ")
        : "(none)");

    const metadata = {
      app: "promptforge",
      schema: state.version || 2,
      profile: profile.id,
      outputMode: outputMode,
      sceneJoiner: state.settings.sceneJoiner,
      activeSceneId: state.activeSceneId,
      scenes: state.scenes.map(function (s) {
        return { id: s.id, name: s.name, enabled: s.enabled };
      }),
      counts: {
        positiveChars: positive.length,
        negativeChars: negative.length,
        positiveWords: positive.trim() ? positive.trim().split(/\s+/).length : 0,
        approxTokens: Math.ceil(positive.length / 4),
        activeFields: sourceMap.length,
      },
      compiledAt: new Date().toISOString(),
    };
    if (options.externals && options.externals.metadata) {
      metadata.externalMetadata = String(options.externals.metadata);
    }

    return {
      positive: positive,
      negative: negative,
      positivePreview: positivePreview,
      negativePreview: negativePreview,
      metadata: metadata,
      sourceMap: sourceMap,
      scenes: sceneResults.map(function (res) {
        return {
          id: res.scene.id,
          name: res.scene.name,
          enabled: res.scene.enabled,
          positive: res.text,
          negative: negative,
        };
      }),
    };
  }
  PF.compilePromptForgeState = compilePromptForgeState;

  // ------------------------------------------------------------ variants ----
  // Produce N compiled variants by re-rolling {a|b|c} wildcards in unlocked
  // fields. Locked fields always resolve to their first option (10.x, 23.10).
  function generateVariants(state, options, n, seed) {
    options = options || {};
    const rng = mulberry32(typeof seed === "number" ? seed : Date.now() & 0x7fffffff);
    const variants = [];
    for (let i = 0; i < n; i++) {
      const clone = PF.deepClone(state);
      function expandFields(fields) {
        (fields || []).forEach(function (f) {
          f.text = expandWildcards(f.text, rng, f.locked);
        });
      }
      expandFields(clone.global.fields);
      expandFields(clone.global.negativeFields);
      clone.scenes.forEach(function (s) {
        expandFields(s.fields);
        expandFields(s.negativeFields);
      });
      const compiled = compilePromptForgeState(clone, options);
      variants.push({
        index: i + 1,
        positive: compiled.positive,
        negative: compiled.negative,
        state: clone,
      });
    }
    return variants;
  }
  PF.generateVariants = generateVariants;

  // ------------------------------------------------------------- diffing ----
  // Phrase-level diff between two prompts (10.3): which comma-separated
  // phrases were added / removed. Exact match only.
  function diffPrompts(oldText, newText) {
    const oldPhrases = splitPhrases(oldText || "");
    const newPhrases = splitPhrases(newText || "");
    const oldSet = Object.create(null);
    const newSet = Object.create(null);
    oldPhrases.forEach(function (p) {
      oldSet[p] = (oldSet[p] || 0) + 1;
    });
    newPhrases.forEach(function (p) {
      newSet[p] = (newSet[p] || 0) + 1;
    });
    const added = newPhrases.filter(function (p) {
      return !oldSet[p];
    });
    const removed = oldPhrases.filter(function (p) {
      return !newSet[p];
    });
    const kept = newPhrases.filter(function (p) {
      return !!oldSet[p];
    });
    return { added: added, removed: removed, kept: kept };
  }
  PF.diffPrompts = diffPrompts;
})(typeof globalThis !== "undefined" ? globalThis : this);
