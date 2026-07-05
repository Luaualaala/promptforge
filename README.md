# Prompt Forge

A local prompt-building tool for Stable Diffusion / Krea 2 / ComfyUI, with optional
AI-assisted drafting and a live bridge into ComfyUI itself.

## Layout

```
promptforge/
  prompt-forge.html          <- the actual tool, open directly in a browser
  promptforge_bridge.py      <- local relay server (stdlib only, no dependencies)
  prompt-bridge-forge/       <- ComfyUI custom node (copy this whole folder as-is)
    __init__.py
    js/
      promptforge_live.js
  README.md
  .gitignore
```

## Setup

1. **The HTML tool** — just open `prompt-forge.html` in a browser. No server, no
   build step.

2. **The bridge** — run locally:
   ```
   python promptforge_bridge.py
   ```
   Defaults to port 8199. Keep this running while using the live ComfyUI bridge
   feature in the HTML tool.

3. **The ComfyUI node** — copy the entire `prompt-bridge-forge/` folder into
   `ComfyUI/custom_nodes/`, then **fully restart ComfyUI** (kill and relaunch the
   process — a browser refresh alone won't remount a new custom node's web
   assets). Add the "Prompt Forge Bridge" node in your graph and wire its
   `positive`/`negative` STRING outputs into your text-encode node.

   Important: the `js/` subfolder name and nesting must stay exactly as-is —
   ComfyUI's `WEB_DIRECTORY` mechanism looks for that specific folder to mount
   the live-update extension. If it ever gets flattened or renamed, the node
   still works when queued, but the live widget updates (before you hit Queue)
   silently stop working.

## Local LLM backend (Ollama / LM Studio / llama.cpp)

Whichever server you're using needs CORS enabled to accept requests from a
browser page — this is a browser-enforced requirement, not specific to this
tool. Check your server's own docs for its CORS setting. For Ollama specifically:
the `OLLAMA_ORIGINS` environment variable, set before the server starts, with a
full process restart afterward (not just closing a terminal window, if it also
runs as a background/tray app).

## Known-working reference config (Krea 2 Turbo)

`simple` scheduler, ER_SDE sampler, CFG ~2.5, ~16 steps. A documented starting
point, not a hard recommendation — tune to taste.
