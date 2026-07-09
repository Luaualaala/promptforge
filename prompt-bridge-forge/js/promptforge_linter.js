/*
 * Prompt Forge — prompt linter, contradiction detector, prompt health score,
 * and negative-prompt cleaner categories.
 * Classic script, attaches to globalThis.PromptForge. Pure functions only.
 * Warnings are informational — the linter never edits user text (spec 21).
 */
(function (global) {
  "use strict";
  const PF = (global.PromptForge = global.PromptForge || {});

  // ------------------------------------------------- contradiction rules ----
  const _rules = [];

  function registerPromptForgeLinterRule(rule) {
    if (!rule || !rule.id || !Array.isArray(rule.anyA) || !Array.isArray(rule.anyB)) {
      console.warn("[PromptForge] ignored bad linter rule", rule);
      return false;
    }
    _rules.push(rule);
    return true;
  }
  PF.registerPromptForgeLinterRule = registerPromptForgeLinterRule;

  // Built-ins register through the public hook (spec 23.39).
  [
    {
      id: "closeup_fullbody",
      severity: "warning",
      anyA: ["close-up", "closeup", "tight close-up", "portrait", "extreme close-up"],
      anyB: ["full body", "full-body", "head to toe", "fullbody"],
      message: "Close-up and full-body framing may fight.",
      suggestion: 'Use "dynamic full-body medium shot" or remove one.',
    },
    {
      id: "wide_closeup",
      severity: "warning",
      anyA: ["wide shot", "wide angle shot", "establishing shot"],
      anyB: ["extreme close-up", "tight close-up", "macro shot"],
      message: "Wide shot and extreme close-up both appear.",
      suggestion: "Pick one framing per scene.",
    },
    {
      id: "midday_night",
      severity: "warning",
      anyA: ["midday", "bright sun", "daylight", "bright midday sun", "noon sun"],
      anyB: ["night", "moonlit", "dark night", "midnight"],
      message: "Daylight and night lighting both appear.",
      suggestion: "Choose one time of day, or split into two scenes.",
    },
    {
      id: "anime_photoreal",
      severity: "info",
      anyA: ["photorealistic", "photoreal", "dslr", "realistic skin", "35mm film"],
      anyB: ["anime", "cel shaded", "cel-shaded", "cartoon", "manga style"],
      message: "Photoreal and anime style are both present. May be intentional — check it.",
      suggestion: "Lead with the style you actually want to dominate.",
    },
    {
      id: "solo_crowd",
      severity: "warning",
      anyA: ["solo", "1girl", "1boy", "alone", "single subject"],
      anyB: ["crowd", "crowded", "group of people", "many people"],
      message: "Solo subject and crowd both appear.",
      suggestion: "Move the crowd to the background field, e.g. 'crowd in background'.",
    },
    {
      id: "underwater_dry",
      severity: "warning",
      anyA: ["underwater", "submerged", "beneath the water"],
      anyB: ["dry hair", "dry clothes"],
      message: "Underwater scene with dry hair/clothes.",
      suggestion: "Use 'wet hair' or drop the dryness tag.",
    },
    {
      id: "backlit_face",
      severity: "info",
      anyA: ["backlit", "backlight", "silhouette"],
      anyB: ["face clearly visible", "detailed face", "detailed eyes"],
      message: "Backlit/silhouette can hide the face you asked to be detailed.",
      suggestion: "Add 'rim light with soft fill on face' to keep the face readable.",
    },
    {
      id: "facing_back",
      severity: "warning",
      anyA: ["facing camera", "looking at viewer", "facing viewer"],
      anyB: ["back view", "from behind", "seen from behind", "looking away"],
      message: "Facing the camera and back view both appear.",
      suggestion: "Use 'looking over shoulder' if you want both.",
    },
    {
      id: "standing_sitting",
      severity: "warning",
      anyA: ["standing"],
      anyB: ["sitting", "seated", "kneeling"],
      message: "Standing and sitting/kneeling both appear.",
      suggestion: "Pick one pose per scene.",
    },
    {
      id: "sitting_running",
      severity: "warning",
      anyA: ["sitting", "seated"],
      anyB: ["running", "sprinting"],
      message: "Sitting and running both appear.",
      suggestion: "Pick one action per scene.",
    },
    {
      id: "indoor_horizon",
      severity: "warning",
      anyA: ["indoors", "interior", "inside a room"],
      anyB: ["ocean horizon", "distant horizon", "open horizon"],
      message: "Indoor scene with an open-horizon background.",
      suggestion: "Use a window view, or move the scene outdoors.",
    },
    {
      id: "foggy_sharp",
      severity: "info",
      anyA: ["dense fog", "thick fog", "heavy mist"],
      anyB: ["sharp focus", "crystal clear", "ultra sharp"],
      message: "Dense fog and ultra-sharp clarity pull in opposite directions.",
      suggestion: "Try 'sharp focus on subject, fog in background'.",
    },
  ].forEach(registerPromptForgeLinterRule);

  PF.getLinterRules = function () {
    return _rules.slice();
  };

  // ------------------------------------------------------------ helpers ----
  function containsAny(haystackLower, needles) {
    for (let i = 0; i < needles.length; i++) {
      if (haystackLower.indexOf(needles[i].toLowerCase()) !== -1) return needles[i];
    }
    return null;
  }

  const CROP_RISK_WORDS = ["full body", "head to toe", "wide shot", "long legs"];
  const FRAMING_PROTECTION = ["cropped", "out of frame", "full body visible"];

  // -------------------------------------------------------------- lint ----
  // lintCompiled(state, compiled) -> { score, warnings: [{id, severity,
  // message, suggestion, sceneId}] }. Works per scene plus globally.
  function lintCompiled(state, compiled) {
    const warnings = [];
    const profile = PF.getProfile ? PF.getProfile(state.settings.modelProfile) : null;

    function checkTextBlock(text, sceneId, sceneName) {
      const lower = text.toLowerCase();
      _rules.forEach(function (rule) {
        const hitA = containsAny(lower, rule.anyA);
        const hitB = containsAny(lower, rule.anyB);
        if (hitA && hitB) {
          warnings.push({
            id: rule.id,
            severity: rule.severity || "warning",
            sceneId: sceneId,
            message:
              (sceneName ? "[" + sceneName + "] " : "") +
              rule.message +
              ' ("' + hitA + '" + "' + hitB + '")',
            suggestion: rule.suggestion || "",
          });
        }
      });
    }

    (compiled.scenes || []).forEach(function (s) {
      checkTextBlock(s.positive, s.id, s.name);
    });
    if (!compiled.scenes || compiled.scenes.length === 0) {
      checkTextBlock(compiled.positive || "", null, null);
    }

    // ------------------------------------------------ hygiene checks ----
    const posPhrases = PF.splitPhrases(compiled.positive || "");
    const counts = Object.create(null);
    posPhrases.forEach(function (p) {
      counts[p] = (counts[p] || 0) + 1;
    });
    const repeats = Object.keys(counts).filter(function (p) {
      return counts[p] > 1;
    });
    if (repeats.length) {
      warnings.push({
        id: "repeated_tags",
        severity: "info",
        sceneId: null,
        message:
          "Repeated phrase" + (repeats.length > 1 ? "s" : "") + ": " +
          repeats.slice(0, 4).join(" · ") + (repeats.length > 4 ? " …" : ""),
        suggestion: "Enable positive dedupe in settings, or remove duplicates.",
      });
    }

    const negPhrases = PF.splitPhrases(compiled.negative || "");
    const negCounts = Object.create(null);
    let negDupes = 0;
    negPhrases.forEach(function (p) {
      negCounts[p] = (negCounts[p] || 0) + 1;
      if (negCounts[p] === 2) negDupes++;
    });
    if (negDupes > 0) {
      warnings.push({
        id: "negative_dupes",
        severity: "info",
        sceneId: null,
        message: "Negative prompt contains " + negDupes + " duplicated term(s).",
        suggestion: "Run the negative cleaner or enable negative dedupe.",
      });
    }

    // per-scene structural checks on enabled fields only
    const scenesToCheck =
      state.settings.outputMode === "single"
        ? [PF.getActiveScene(state)]
        : state.scenes.filter(function (s) {
            return s.enabled;
          });

    scenesToCheck.forEach(function (scene) {
      const enabledFields = (scene.fields || []).filter(function (f) {
        return f.enabled && f.text.trim();
      });
      const globalEnabled = (state.global.fields || []).filter(function (f) {
        return f.enabled && f.text.trim();
      });
      const all = enabledFields.concat(globalEnabled);

      function hasType(types) {
        return all.some(function (f) {
          return types.includes(f.type);
        });
      }

      if (!hasType(["subject", "character"])) {
        warnings.push({
          id: "empty_subject",
          severity: "warning",
          sceneId: scene.id,
          message: "[" + scene.name + "] No subject or character text.",
          suggestion: "Add a subject so the model has something to draw.",
        });
      }
      if (!hasType(["composition", "camera"])) {
        warnings.push({
          id: "missing_camera",
          severity: "info",
          sceneId: scene.id,
          message: "[" + scene.name + "] No camera/composition guidance.",
          suggestion: "Add a shot size or angle for more control.",
        });
      }
      if (!hasType(["lighting"])) {
        warnings.push({
          id: "missing_lighting",
          severity: "info",
          sceneId: scene.id,
          message: "[" + scene.name + "] No lighting description.",
          suggestion: "Add lighting — it is the cheapest mood upgrade.",
        });
      }

      const styleCount = all.filter(function (f) {
        return f.type === "style";
      }).length;
      if (styleCount > 3) {
        warnings.push({
          id: "too_many_styles",
          severity: "warning",
          sceneId: scene.id,
          message: "[" + scene.name + "] " + styleCount + " style fields active — styles may fight.",
          suggestion: "Keep 1-2 dominant styles.",
        });
      }
    });

    // quality tag pile-up (across compiled positive)
    const qualityWords = [
      "masterpiece", "best quality", "high quality", "highly detailed", "8k",
      "4k", "uhd", "sharp focus", "award winning", "very aesthetic",
      "score_9", "score_8_up", "absurdres",
    ];
    const qualityHits = qualityWords.filter(function (w) {
      return (compiled.positive || "").toLowerCase().indexOf(w) !== -1;
    });
    if (qualityHits.length > 5) {
      warnings.push({
        id: "quality_spam",
        severity: "warning",
        sceneId: null,
        message: qualityHits.length + " quality tags stacked — diminishing returns.",
        suggestion: "Keep 2-3 quality tags at most.",
      });
    }

    // crop-risk words without framing protection
    const posLower = (compiled.positive || "").toLowerCase();
    const negLower = (compiled.negative || "").toLowerCase();
    const cropHit = containsAny(posLower, CROP_RISK_WORDS);
    if (cropHit && !containsAny(negLower + " " + posLower, FRAMING_PROTECTION)) {
      warnings.push({
        id: "crop_risk",
        severity: "info",
        sceneId: null,
        message: '"' + cropHit + '" often gets cropped by the model.',
        suggestion: 'Add "cropped, out of frame" to the negative prompt.',
      });
    }

    // profile-aware checks
    if (profile) {
      if (
        profile.negativePolicy === "minimal" &&
        (compiled.negative || "").length > 300
      ) {
        warnings.push({
          id: "huge_negative_for_profile",
          severity: "warning",
          sceneId: null,
          message:
            profile.label +
            " prefers minimal negatives — current negative is " +
            compiled.negative.length +
            " chars.",
          suggestion: 'Set negative severity to "minimal" for this profile.',
        });
      }
      if (profile.avoidTags && profile.avoidTags.length) {
        const avoidHit = containsAny(posLower, profile.avoidTags);
        if (avoidHit) {
          warnings.push({
            id: "profile_avoid_tag",
            severity: "warning",
            sceneId: null,
            message: '"' + avoidHit + '" is discouraged for the ' + profile.label + " profile.",
            suggestion: "Remove it or switch profiles.",
          });
        }
      }
      if (
        profile.maxSoftLength &&
        (compiled.positive || "").length > profile.maxSoftLength
      ) {
        warnings.push({
          id: "prompt_too_long",
          severity: "info",
          sceneId: null,
          message:
            "Positive prompt is " + compiled.positive.length + " chars — past the soft limit (" +
            profile.maxSoftLength + ") for " + profile.label + ".",
          suggestion: "Trim filler phrases; keep the load-bearing ones.",
        });
      }
      if (!profile.supportsWeights && /\([^()]+:\s*[\d.]+\s*\)/.test(compiled.positive || "")) {
        warnings.push({
          id: "weights_unsupported",
          severity: "warning",
          sceneId: null,
          message: profile.label + " does not use (tag:1.2) weight syntax.",
          suggestion: "Remove manual weights or switch to a tag-style profile.",
        });
      }
    }

    // unexpanded wildcards passing through to the model
    if (PF.hasWildcards(compiled.positive || "")) {
      warnings.push({
        id: "wildcards_present",
        severity: "info",
        sceneId: null,
        message: "Wildcard syntax {a|b|c} is still in the compiled prompt.",
        suggestion:
          "Use the variations generator to expand it, or keep it if your ComfyUI dynamic-prompt node handles it.",
      });
    }

    // ---------------------------------------------------------- score ----
    let score = 100;
    warnings.forEach(function (w) {
      score -= w.severity === "warning" ? 8 : 3;
    });
    score = Math.max(0, Math.min(100, score));

    return { score: score, warnings: warnings };
  }
  PF.lintCompiled = lintCompiled;

  // ================================================ negative cleaner ========
  PF.NEG_CATEGORIES = [
    {
      id: "quality",
      label: "Image quality",
      terms: [
        "low quality", "worst quality", "normal quality", "jpeg artifacts",
        "blurry", "lowres", "low resolution", "pixelated", "compression artifacts",
        "grainy", "noisy",
      ],
    },
    {
      id: "watermark",
      label: "Watermark / text / logo",
      terms: [
        "watermark", "text", "logo", "signature", "username", "artist name",
        "copyright", "stamp", "url",
      ],
    },
    {
      id: "anatomy",
      label: "Anatomy",
      terms: [
        "bad anatomy", "extra limbs", "missing limbs", "deformed", "mutated",
        "disfigured", "malformed", "extra arms", "extra legs", "fused limbs",
        "long neck", "bad proportions",
      ],
    },
    {
      id: "hands",
      label: "Hands",
      terms: [
        "bad hands", "extra fingers", "missing fingers", "deformed hands",
        "malformed hands", "fused fingers", "too many fingers", "extra digit",
        "fewer digits",
      ],
    },
    {
      id: "face",
      label: "Face / eyes",
      terms: [
        "bad face", "distorted face", "asymmetric eyes", "cross-eyed",
        "bad eyes", "extra eyes", "deformed face", "ugly face",
      ],
    },
    {
      id: "framing",
      label: "Cropping / framing",
      terms: [
        "cropped", "out of frame", "cut off", "cropped head", "cropped hands",
        "cropped feet", "close crop",
      ],
    },
    {
      id: "style",
      label: "Style exclusions",
      terms: [
        "cartoon", "anime", "3d", "render", "painting", "sketch", "monochrome",
        "greyscale", "grayscale", "photorealistic",
      ],
    },
    {
      id: "nsfw",
      label: "NSFW / exposure control",
      terms: [
        "nsfw", "nude", "nudity", "explicit", "cleavage", "underwear",
        "topless", "sexual",
      ],
    },
    {
      id: "junk",
      label: "Model-specific junk",
      terms: [
        "score_4", "score_5", "score_6", "source_furry", "source_pony",
        "duplicate", "error", "bad quality",
      ],
    },
  ];

  const _termToCategory = Object.create(null);
  PF.NEG_CATEGORIES.forEach(function (cat) {
    cat.terms.forEach(function (t) {
      _termToCategory[t.toLowerCase()] = cat.id;
    });
  });

  // Exact (case-insensitive) lookup only. Unknown terms return null and are
  // treated as user-custom: always preserved (spec 7.4).
  function categorizeNegativeTerm(term) {
    return _termToCategory[String(term).trim().toLowerCase()] || null;
  }
  PF.categorizeNegativeTerm = categorizeNegativeTerm;

  // Split a raw negative prompt into { categories: {catId: [terms]},
  // custom: [terms] } without losing anything.
  function groupNegative(rawText) {
    const groups = { custom: [] };
    PF.NEG_CATEGORIES.forEach(function (cat) {
      groups[cat.id] = [];
    });
    PF.splitPhrases(rawText || "").forEach(function (term) {
      const cat = categorizeNegativeTerm(term);
      if (cat) groups[cat].push(term);
      else groups.custom.push(term);
    });
    return groups;
  }
  PF.groupNegative = groupNegative;

  // cleanNegative: dedupe (exact), normalize commas/spacing, optionally drop
  // disabled categories. Custom/unknown terms always survive.
  function cleanNegative(rawText, categoriesOff) {
    categoriesOff = categoriesOff || [];
    const seen = Object.create(null);
    const out = [];
    PF.splitPhrases(rawText || "").forEach(function (term) {
      if (seen[term]) return; // exact dedupe only
      seen[term] = true;
      const cat = categorizeNegativeTerm(term);
      if (cat && categoriesOff.includes(cat)) return;
      out.push(term);
    });
    return out.join(", ");
  }
  PF.cleanNegative = cleanNegative;
})(typeof globalThis !== "undefined" ? globalThis : this);
