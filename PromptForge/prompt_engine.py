"""
Prompt Forge — queue-time state -> prompt compiler (Python).

This is a deliberate subset port of web/js/promptforge_compiler.js: field
ordering, scenes/output modes, weights, dedupe and the negative severity
ladder are ported; the negative-cleaner category filter and source map are
JS-only (the panel handles those before queue time).

The JS compiler is canonical — tests/test_composer.py keeps the two in parity.
"""

TYPE_ORDER = {
    "forced_positive": 0, "character": 10, "subject": 20, "action": 25,
    "clothing": 27, "expression": 28, "style": 30, "medium": 35,
    "composition": 40, "camera": 45, "lighting": 50, "mood": 55,
    "background": 60, "environment": 65, "props": 68, "custom": 70,
    "quality": 80, "negative": 0, "forced_negative": 90,
}

EXTERNAL_POSITION_KEYS = {
    "forced_prepend": -100.0, "before_character": 9.5, "after_character": 10.5,
    "before_scene": 19.5, "after_scene": 75.0, "before_quality": 79.5,
    "forced_append": 1000.0,
}

# Mirrors PF.NEG_SEVERITY in web/js/promptforge_profiles.js.
NEG_SEVERITY = {
    "minimal": "watermark, text, low quality",
    "normal": "watermark, text, low quality, bad anatomy, extra limbs, blurry, cropped",
    "strict": ("watermark, text, logo, low quality, worst quality, bad anatomy, extra limbs, "
               "extra fingers, bad hands, distorted face, blurry, cropped, out of frame"),
    "nuclear": ("watermark, text, logo, signature, low quality, worst quality, jpeg artifacts, "
                "bad anatomy, extra limbs, extra fingers, missing fingers, bad hands, malformed hands, "
                "distorted face, asymmetric eyes, blurry, cropped, out of frame, deformed, mutated, "
                "disfigured, ugly, duplicate"),
}

# Only what the queue-time compiler needs from each profile.
# DiT-based text encoders (T5-style) read (tag:1.2) as literal text, not a
# weight instruction — anima is DiT-based, same as flux/krea2/qwen_image.
PROFILE_WEIGHTS = {
    "generic": True, "sdxl": True, "pony": True, "custom": True,
    "flux": False, "krea2": False, "qwen_image": False, "anima": False,
}

# Whether a profile prefers natural language (used to pick LLM instructions).
PROFILE_NATURAL_LANGUAGE = {
    "flux": True, "krea2": True, "qwen_image": True,
}


def split_phrases(text):
    """Comma-split that never splits inside (...) groups; trims and drops empties."""
    out, depth, cur = [], 0, ""
    for ch in str(text or ""):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [p.strip() for p in out if p.strip()]


def _apply_weight(phrase, weight, supports_weights):
    if not supports_weights or not isinstance(weight, (int, float)) or weight == 1:
        return phrase
    if phrase.startswith("(") and phrase.endswith(")") and ":" in phrase:
        return phrase  # already manually weighted
    w = round(float(weight) * 100) / 100
    w_str = ("%g" % w)
    return f"({phrase}:{w_str})"


def compile_state(state, externals=None, forced_positive="", forced_negative="",
                  forced_position="prepend"):
    """Subset port of PromptForge.compilePromptForgeState. Returns a dict."""
    externals = externals or {}
    settings = state.get("settings", {}) or {}
    profile_id = settings.get("modelProfile", "generic")
    supports_weights = PROFILE_WEIGHTS.get(profile_id, True)
    dedupe_pos = settings.get("dedupePositive", True) is not False
    dedupe_neg = settings.get("dedupeNegative", True) is not False

    scenes = [s for s in state.get("scenes", []) if isinstance(s, dict)] or [{}]
    output_mode = settings.get("outputMode", "single")
    active_id = state.get("activeSceneId")
    active = next((s for s in scenes if s.get("id") == active_id), scenes[0])
    if output_mode == "single":
        in_play = [active]
    else:
        in_play = [s for s in scenes if s.get("enabled", True)] or [active]

    ext_conf = state.get("externals", {}) or {}

    def field_items(fields, scope_rank):
        items = []
        for f in fields or []:
            if not isinstance(f, dict) or not f.get("enabled", True):
                continue
            text = ", ".join(split_phrases(f.get("text", "")))
            if not text:
                continue
            base_key = f.get("position")
            if not isinstance(base_key, (int, float)):
                base_key = TYPE_ORDER.get(f.get("type", "custom"), 70)
            for i, phrase in enumerate(split_phrases(text)):
                items.append((base_key + scope_rank * 0.01 + i * 0.0001,
                              _apply_weight(phrase, f.get("weight", 1.0), supports_weights)))
        return items

    def scene_text(scene):
        items = []
        fp = ", ".join(split_phrases(forced_positive))
        if fp:
            key = 2000.0 if forced_position == "append" else -200.0
            items += [(key + i * 0.0001, p) for i, p in enumerate(split_phrases(fp))]
        items += field_items((state.get("global", {}) or {}).get("fields", []), 0)
        items += field_items(scene.get("fields", []), 1)
        for slot_idx, slot in enumerate(("positiveA", "positiveB")):
            raw = ", ".join(split_phrases(externals.get(slot, "")))
            if not raw:
                continue
            conf = ext_conf.get(slot, {}) if isinstance(ext_conf.get(slot), dict) else {}
            pos_name = conf.get("position")
            if pos_name not in EXTERNAL_POSITION_KEYS:
                pos_name = settings.get("externalPosition", "before_quality")
            base = EXTERNAL_POSITION_KEYS.get(pos_name, 79.5)
            items += [(base + slot_idx * 0.001 + i * 0.0001, p)
                      for i, p in enumerate(split_phrases(raw))]
        items.sort(key=lambda t: t[0])
        phrases = [p for _, p in items]
        if dedupe_pos:
            seen, out = set(), []
            for p in phrases:
                if p in seen:
                    continue  # exact-match dedupe only, never fuzzy
                seen.add(p)
                out.append(p)
            phrases = out
        return ", ".join(phrases)

    blocks = [(s, scene_text(s)) for s in in_play]

    joiner = ", "
    if output_mode == "break_blocks":
        joiner = "\nBREAK\n"
    elif output_mode == "scenes_joined":
        j = settings.get("sceneJoiner", "comma")
        joiner = {"newline": "\n", "BREAK": "\nBREAK\n",
                  "custom": settings.get("sceneJoinerCustom") or ", "}.get(j, ", ")
    positive = joiner.join(t for _, t in blocks)

    # negative: base global -> profile ladder -> scene -> forced -> external
    neg_parts = []
    for f in (state.get("global", {}) or {}).get("negativeFields", []) or []:
        if isinstance(f, dict) and f.get("enabled", True):
            neg_parts += split_phrases(f.get("text", ""))
    severity = settings.get("negativeSeverity", "normal")
    if severity != "off" and severity in NEG_SEVERITY:
        neg_parts += split_phrases(NEG_SEVERITY[severity])
    for s in in_play:
        for f in s.get("negativeFields", []) or []:
            if isinstance(f, dict) and f.get("enabled", True):
                neg_parts += split_phrases(f.get("text", ""))
    neg_parts += split_phrases(forced_negative)
    neg_parts += split_phrases(externals.get("negativeA", ""))
    if dedupe_neg:
        seen, out = set(), []
        for p in neg_parts:
            if p in seen:
                continue
            seen.add(p)
            out.append(p)
        neg_parts = out
    negative = ", ".join(neg_parts)

    return {
        "positive": positive,
        "negative": negative,
        "positive_preview": "\n\n".join(
            f"[{s.get('name', 'Scene')}]\n{t}" for s, t in blocks),
        "negative_preview": "[negative]\n" + (negative or "(none)"),
        "scenes": [{"id": s.get("id"), "name": s.get("name"),
                    "enabled": s.get("enabled", True), "positive": t}
                   for s, t in blocks],
        "profile": profile_id,
        "outputMode": output_mode,
    }
