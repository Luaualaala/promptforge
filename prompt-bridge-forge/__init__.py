"""
Prompt Forge Bridge node for ComfyUI.

Install: copy this whole folder (promptforge_bridge/) into ComfyUI/custom_nodes/,
then restart ComfyUI completely (not just a browser refresh — it needs to mount
the js/ web directory). Remove any older single-file promptforge_bridge_node.py
first if you installed that version previously.

Architecture: ai_positive / ai_negative are ordinary multiline widgets. The
paired js/promptforge_live.js frontend extension polls promptforge_bridge.py
directly from the browser and writes into these widgets the moment the HTML
tool pushes a new prompt — so you see it appear in the node instantly, with no
need to queue the graph. At actual queue time, this node just combines whatever
is currently sitting in those widgets with your forced text; no network call
happens in Python at all anymore.

forced_positive / forced_negative are node-level text that always gets included
regardless of what the bridge/browser tool currently holds — useful for a fixed
style lead-in or boilerplate quality tags you never want to depend on the AI
draft generator remembering to add.

positive_preview / negative_preview keep the two sources visibly separated —
executive on top, AI below (or reversed if forced_position is "append") — for
wiring into any text-display node (e.g. pysssss's "Show Text" from
ComfyUI-Custom-Scripts).
"""
import time

WEB_DIRECTORY = "js"


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


NODE_CLASS_MAPPINGS = {"PromptForgeBridge": PromptForgeBridge}
NODE_DISPLAY_NAME_MAPPINGS = {"PromptForgeBridge": "Prompt Forge Bridge"}
