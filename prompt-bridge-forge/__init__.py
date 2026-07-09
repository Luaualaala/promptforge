"""
Prompt Forge nodes for ComfyUI.

Install: copy this whole folder (prompt-bridge-forge/) into ComfyUI/custom_nodes/,
then restart ComfyUI completely (not just a browser refresh — it needs to mount
the js/ web directory).

Two nodes ship in this package:

  PromptForgeBridge   — the original live-sync compatibility node. Unchanged
                        behavior: js/promptforge_live.js polls the local
                        promptforge_bridge.py server and writes into the
                        ai_positive / ai_negative widgets; at queue time this
                        node just combines them with the forced text.

  PromptForgeComposer — the new stateful native node. The Prompt Forge panel
                        (js/promptforge_panel.js) stores the full Prompt Forge
                        state JSON in the state_json widget and writes the
                        compiled positive/negative strings into the
                        compiled_positive / compiled_negative widgets, so the
                        prompt survives workflow save/reload with no server
                        and no network at generation time.

Composer compile precedence at queue time:
  1. If any generic external STRING input is connected AND state_json parses,
     the state is recompiled here in Python so the external text can be
     inserted at its configured position (state.externals.*.position).
  2. Otherwise, if compiled_positive/compiled_negative are non-empty they are
     used verbatim — this is the golden path and matches the panel preview
     exactly (the JS compiler is the canonical one).
  3. Otherwise, if state_json parses, it is compiled here in Python.
  4. Otherwise the node degrades to a plain forced-text combiner.

The Python compiler is a deliberate subset of js/promptforge_compiler.js:
field ordering, scenes/output modes, weights, dedupe and the negative
severity ladder are ported; the negative-cleaner category filter and source
map are JS-only (TODO if ever needed at queue time).

External inputs are generic STRING slots. They accept text from ANY node —
caption tools, trigger tools, style helpers — and never inspect its origin.
No LoRA-specific logic lives here on purpose.
"""
import hashlib
import json
import time

WEB_DIRECTORY = "js"


# =========================================================================
# PromptForgeBridge — original compatibility node (behavior preserved)
# =========================================================================
class PromptForgeBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bridge_url": ("STRING", {"default": "http://127.0.0.1:8199"}),
                "forced_positive": ("STRING", {"default": "", "multiline": True}),
                "forced_negative": ("STRING", {"default": "", "multiline": True}),
                "forced_position": (["prepend", "append"], {"default": "prepend"}),
                "ai_positive": ("STRING", {"default": "", "multiline": True}),
                "ai_negative": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "positive_preview", "negative_preview")
    FUNCTION = "combine"
    CATEGORY = "Prompt Forge"

    @staticmethod
    def _combine(forced, live, position):
        forced = (forced or "").strip().rstrip(",").strip()
        live = (live or "").strip()
        parts = [forced, live] if position == "prepend" else [live, forced]
        return ", ".join(p for p in parts if p)

    @staticmethod
    def _preview(forced, live, position):
        forced = (forced or "").strip() or "(none)"
        live = (live or "").strip() or "(none)"
        blocks = [("EXECUTIVE", forced), ("AI-GENERATED", live)]
        if position == "append":
            blocks.reverse()
        return "\n\n".join(f"[{label}]\n{text}" for label, text in blocks)

    def combine(self, bridge_url, forced_positive, forced_negative, forced_position, ai_positive, ai_negative):
        positive = self._combine(forced_positive, ai_positive, forced_position)
        negative = self._combine(forced_negative, ai_negative, forced_position)
        positive_preview = self._preview(forced_positive, ai_positive, forced_position)
        negative_preview = self._preview(forced_negative, ai_negative, forced_position)
        return (positive, negative, positive_preview, negative_preview)

    @classmethod
    def IS_CHANGED(cls, bridge_url, forced_positive, forced_negative, forced_position, ai_positive, ai_negative):
        # Widget values changing should already mark this dirty, but the JS extension
        # writes to widgets programmatically rather than through normal UI events —
        # force a re-check every time to avoid any risk of a stale cached result.
        return time.time()


# =========================================================================
# Python subset compiler (see module docstring for scope)
# =========================================================================
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

# Mirrors PF.NEG_SEVERITY in js/promptforge_profiles.js.
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
PROFILE_WEIGHTS = {
    "generic": True, "sdxl": True, "pony": True, "anima": True, "custom": True,
    "flux": False, "krea2": False, "qwen_image": False,
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


# =========================================================================
# PromptForgeComposer — new stateful native node
# =========================================================================
class PromptForgeComposer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "state_json": ("STRING", {"default": "", "multiline": True}),
                "compiled_positive": ("STRING", {"default": "", "multiline": True}),
                "compiled_negative": ("STRING", {"default": "", "multiline": True}),
                "forced_positive": ("STRING", {"default": "", "multiline": True}),
                "forced_negative": ("STRING", {"default": "", "multiline": True}),
                "forced_position": (["prepend", "append"], {"default": "prepend"}),
                "metadata_json": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                # Generic external STRING inputs — any node may feed these.
                "external_positive_a": ("STRING", {"default": "", "forceInput": True}),
                "external_positive_b": ("STRING", {"default": "", "forceInput": True}),
                "external_negative_a": ("STRING", {"default": "", "forceInput": True}),
                "external_metadata": ("STRING", {"default": "", "forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("positive", "negative", "positive_preview",
                    "negative_preview", "metadata_json", "scene_json")
    FUNCTION = "compose"
    CATEGORY = "Prompt Forge"

    @staticmethod
    def _combine(forced, base, position):
        forced = (forced or "").strip().rstrip(",").strip()
        base = (base or "").strip()
        parts = [forced, base] if position == "prepend" else [base, forced]
        return ", ".join(p for p in parts if p)

    @staticmethod
    def _append_external(text, external):
        """Exact-dedupe append used on the pre-compiled string path."""
        external = (external or "").strip()
        if not external:
            return text
        existing = set(split_phrases(text))
        add = [p for p in split_phrases(external) if p not in existing]
        if not add:
            return text
        return ", ".join([p for p in [text.strip(), ", ".join(add)] if p])

    def compose(self, state_json, compiled_positive, compiled_negative,
                forced_position="prepend", forced_positive="", forced_negative="",
                metadata_json="", external_positive_a="", external_positive_b="",
                external_negative_a="", external_metadata=""):
        state = None
        if (state_json or "").strip():
            try:
                state = json.loads(state_json)
                if not isinstance(state, dict):
                    state = None
            except (json.JSONDecodeError, ValueError):
                print("[PromptForge] Composer: state_json is not valid JSON — "
                      "falling back to compiled strings / combiner mode.")

        externals = {
            "positiveA": external_positive_a or "",
            "positiveB": external_positive_b or "",
            "negativeA": external_negative_a or "",
        }
        externals_connected = any(v.strip() for v in externals.values())
        has_compiled = bool((compiled_positive or "").strip() or (compiled_negative or "").strip())

        if state is not None and (externals_connected or not has_compiled):
            # Python compile path: honors external positions from state.
            result = compile_state(
                state, externals=externals,
                forced_positive=forced_positive, forced_negative=forced_negative,
                forced_position=forced_position,
            )
            positive = result["positive"]
            negative = result["negative"]
            positive_preview = result["positive_preview"]
            negative_preview = result["negative_preview"]
            scene_json = json.dumps(result["scenes"], ensure_ascii=False)
            meta = {
                "app": "promptforge", "source": "python_compiler",
                "profile": result["profile"], "outputMode": result["outputMode"],
            }
        elif has_compiled:
            # Golden path: the panel's JS compiler already produced the strings.
            positive = self._combine(forced_positive, compiled_positive, forced_position)
            negative = self._combine(forced_negative, compiled_negative, forced_position)
            positive = self._append_external(positive, external_positive_a)
            positive = self._append_external(positive, external_positive_b)
            negative = self._append_external(negative, external_negative_a)
            positive_preview = positive
            negative_preview = negative
            scene_json = "[]"
            meta = {"app": "promptforge", "source": "compiled_widgets"}
            if (metadata_json or "").strip():
                try:
                    meta = json.loads(metadata_json)
                    if not isinstance(meta, dict):
                        meta = {"app": "promptforge", "raw": metadata_json}
                except (json.JSONDecodeError, ValueError):
                    meta = {"app": "promptforge", "raw": metadata_json}
                # scene_json rides along inside panel-written metadata if present
                if isinstance(meta.get("scenes"), list):
                    scene_json = json.dumps(meta["scenes"], ensure_ascii=False)
        else:
            # Plain combiner mode: no state, no compiled strings.
            positive = self._combine(forced_positive, "", forced_position)
            negative = self._combine(forced_negative, "", forced_position)
            positive = self._append_external(positive, external_positive_a)
            positive = self._append_external(positive, external_positive_b)
            negative = self._append_external(negative, external_negative_a)
            positive_preview = positive or "(empty)"
            negative_preview = negative or "(empty)"
            scene_json = "[]"
            meta = {"app": "promptforge", "source": "combiner"}

        if (external_metadata or "").strip():
            meta["externalMetadata"] = external_metadata

        return (positive, negative, positive_preview, negative_preview,
                json.dumps(meta, ensure_ascii=False), scene_json)

    @classmethod
    def IS_CHANGED(cls, state_json, compiled_positive, compiled_negative,
                   forced_position="prepend", forced_positive="", forced_negative="",
                   metadata_json="", external_positive_a="", external_positive_b="",
                   external_negative_a="", external_metadata=""):
        # Hash of everything that affects output: cache-stable when nothing
        # changed, dirty the moment the panel rewrites a widget.
        h = hashlib.sha256()
        for part in (state_json, compiled_positive, compiled_negative, forced_position,
                     forced_positive, forced_negative, external_positive_a,
                     external_positive_b, external_negative_a, external_metadata):
            h.update(str(part).encode("utf-8", "replace"))
            h.update(b"\x00")
        return h.hexdigest()


NODE_CLASS_MAPPINGS = {
    "PromptForgeBridge": PromptForgeBridge,
    "PromptForgeComposer": PromptForgeComposer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptForgeBridge": "Prompt Forge Bridge",
    "PromptForgeComposer": "Prompt Forge Composer",
}
