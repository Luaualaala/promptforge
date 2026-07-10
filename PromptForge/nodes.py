"""
Prompt Forge — ComfyUI node classes.

PromptForgeComposer — the stateful native node. The Prompt Forge panel
(web/js/promptforge_panel.js) stores the full Prompt Forge state JSON in the
state_json widget and writes the compiled positive/negative strings into the
compiled_positive / compiled_negative widgets, so the prompt survives
workflow save/reload with no server and no network at generation time.

Composer compile precedence at queue time:
  1. If any generic external STRING input is connected AND state_json parses,
     the state is recompiled here in Python so the external text can be
     inserted at its configured position (state.externals.*.position).
  2. Otherwise, if compiled_positive/compiled_negative are non-empty they are
     used verbatim — this is the golden path and matches the panel preview
     exactly (the JS compiler is the canonical one).
  3. Otherwise, if state_json parses, it is compiled here in Python.
  4. Otherwise the node degrades to a plain forced-text combiner.

External inputs are generic STRING slots. They accept text from ANY node —
caption tools, trigger tools, style helpers — and never inspect its origin.
No LoRA-specific logic lives here on purpose.

PromptForgeBridge — legacy compatibility node. Workflows saved with the old
three-component setup (HTML tool + bridge server) load without missing-node
errors; at queue time it is a plain forced/ai text combiner, exactly as
before. The polling extension and the external bridge server are retired —
the panel replaces them.
"""
import hashlib
import json
import time

from .prompt_engine import compile_state, split_phrases


# =========================================================================
# PromptForgeBridge — legacy compatibility node (queue-time behavior preserved)
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
        # Widget values are sometimes written programmatically rather than
        # through normal UI events — force a re-check every time to avoid any
        # risk of a stale cached result.
        return time.time()


# =========================================================================
# PromptForgeComposer — stateful native node
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
    "PromptForgeBridge": "Prompt Forge Bridge (legacy)",
    "PromptForgeComposer": "Prompt Forge Composer",
}
