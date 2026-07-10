"""
Prompt Forge — self-contained ComfyUI custom node package.

Install: copy this whole folder (PromptForge/) into ComfyUI/custom_nodes/,
then restart ComfyUI completely (not just a browser refresh — it needs to
mount the web/ directory and register the /promptforge/ backend routes).

Everything runs inside ComfyUI: the Composer node, the Prompt Forge panel
(⚒ button), the LLM enhance/draft backends, and persistent template/config
storage. No separate bridge server, HTML app, or extra process is required.

See README.md for usage; see nodes.py for the compile precedence rules.
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web/js"

# Backend routes need ComfyUI's PromptServer. Guarded so this package still
# imports cleanly outside ComfyUI (unit tests, linters).
try:
    from . import api as _api
    _api.register_routes()
except ImportError:
    print("[PromptForge] ComfyUI server not available — backend routes not "
          "registered (fine for tests; inside ComfyUI this is a problem).")
except Exception as e:  # never take ComfyUI down at import time
    print(f"[PromptForge] failed to register backend routes: {e!r}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
