/*
 * Prompt Forge — model profiles / syntax dialects + registry hooks.
 * Classic script, attaches to globalThis.PromptForge. No dependencies.
 */
(function (global) {
  "use strict";
  const PF = (global.PromptForge = global.PromptForge || {});

  // Negative-severity ladders shared by tag-style profiles. User custom
  // negatives are always kept on top of whichever ladder step is active.
  const NEG_SEVERITY = {
    minimal: "watermark, text, low quality",
    normal:
      "watermark, text, low quality, bad anatomy, extra limbs, blurry, cropped",
    strict:
      "watermark, text, logo, low quality, worst quality, bad anatomy, extra limbs, extra fingers, bad hands, distorted face, blurry, cropped, out of frame",
    nuclear:
      "watermark, text, logo, signature, low quality, worst quality, jpeg artifacts, bad anatomy, extra limbs, extra fingers, missing fingers, bad hands, malformed hands, distorted face, asymmetric eyes, blurry, cropped, out of frame, deformed, mutated, disfigured, ugly, duplicate",
  };
  PF.NEG_SEVERITY = NEG_SEVERITY;

  const BUILTIN_PROFILES = [
    {
      id: "generic",
      label: "Generic",
      promptStyle: "tags",
      separator: ", ",
      supportsWeights: true,
      weightSyntax: "paren", // (phrase:1.2)
      negativePolicy: "normal",
      qualityPreset: [],
      avoidTags: [],
      maxSoftLength: 2000,
      notes: "Neutral defaults. Weights allowed, normal negatives.",
    },
    {
      id: "sdxl",
      label: "SDXL",
      promptStyle: "tags",
      separator: ", ",
      supportsWeights: true,
      weightSyntax: "paren",
      negativePolicy: "normal",
      qualityPreset: ["masterpiece", "best quality", "highly detailed"],
      avoidTags: [],
      maxSoftLength: 1800,
      notes: "Tag style, weighted tags OK, negatives useful.",
    },
    {
      id: "pony",
      label: "Pony / Illustrious",
      promptStyle: "tags",
      separator: ", ",
      supportsWeights: true,
      weightSyntax: "paren",
      negativePolicy: "strict",
      qualityPreset: ["score_9", "score_8_up", "best quality"],
      avoidTags: [],
      maxSoftLength: 1800,
      notes: "Tag-heavy, score tags common, strong negatives accepted.",
    },
    {
      id: "flux",
      label: "Flux",
      promptStyle: "natural_language",
      separator: ", ",
      supportsWeights: false,
      weightSyntax: "none",
      negativePolicy: "minimal",
      qualityPreset: [],
      avoidTags: ["score_9", "score_8_up", "masterpiece", "best quality"],
      maxSoftLength: 1200,
      notes:
        "Prefers natural language. Avoid negative-prompt soup and stacked quality tags.",
    },
    {
      id: "krea2",
      label: "Krea 2",
      promptStyle: "natural_language",
      separator: ", ",
      supportsWeights: false,
      weightSyntax: "none",
      negativePolicy: "minimal",
      qualityPreset: [],
      avoidTags: ["score_9", "score_8_up", "masterpiece"],
      maxSoftLength: 1000,
      notes:
        "Natural language, documented sweet spots ~30-140 words. Minimal negatives.",
    },
    {
      id: "qwen_image",
      label: "Qwen Image",
      promptStyle: "natural_language",
      separator: ", ",
      supportsWeights: false,
      weightSyntax: "none",
      negativePolicy: "minimal",
      qualityPreset: [],
      avoidTags: [],
      maxSoftLength: 1500,
      notes: "Natural language, handles longer descriptive prompts.",
    },
    {
      id: "anima",
      label: "Anima",
      promptStyle: "natural_language",
      separator: ", ",
      supportsWeights: false,
      weightSyntax: "none",
      negativePolicy: "minimal",
      qualityPreset: [],
      avoidTags: ["score_9", "score_8_up", "masterpiece", "best quality"],
      maxSoftLength: 1500,
      // Optional base tags are opt-in only (spec 5.2) — never auto-added.
      optionalBaseTags: ["D4rkL1nes", "@gpt-image-2", "MythAn1m3"],
      notes: "DiT-based anime model — prefers natural language like Flux/Krea/Qwen; (tag:1.2) weight syntax is read as literal text, not a weight instruction. Optional base tags only if user enables them.",
    },
    {
      id: "custom",
      label: "Custom",
      promptStyle: "tags",
      separator: ", ",
      supportsWeights: true,
      weightSyntax: "paren",
      negativePolicy: "normal",
      qualityPreset: [],
      avoidTags: [],
      maxSoftLength: 2000,
      notes: "User-editable profile. Saved with the project.",
    },
  ];

  const _profiles = {};
  BUILTIN_PROFILES.forEach(function (p) {
    _profiles[p.id] = p;
  });

  // ------------------------------------------------------ registry hooks ----
  // Built-ins register through the same pathway as custom profiles (23.39).
  function registerPromptForgeProfile(profile) {
    if (!profile || typeof profile !== "object" || !profile.id) {
      console.warn("[PromptForge] ignored bad profile registration", profile);
      return false;
    }
    _profiles[profile.id] = Object.assign(
      {},
      _profiles.generic || BUILTIN_PROFILES[0],
      profile
    );
    return true;
  }
  PF.registerPromptForgeProfile = registerPromptForgeProfile;

  function getProfile(id) {
    return _profiles[id] || _profiles.generic;
  }
  PF.getProfile = getProfile;

  function listProfiles() {
    return Object.keys(_profiles).map(function (k) {
      return _profiles[k];
    });
  }
  PF.listProfiles = listProfiles;

  // Custom profile overrides stored in a project can be applied on load.
  function applyCustomProfileOverride(override) {
    if (!override || typeof override !== "object") return;
    _profiles.custom = Object.assign({}, _profiles.custom, override, {
      id: "custom",
    });
  }
  PF.applyCustomProfileOverride = applyCustomProfileOverride;
})(typeof globalThis !== "undefined" ? globalThis : this);
