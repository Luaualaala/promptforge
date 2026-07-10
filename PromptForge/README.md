# Prompt Forge — ComfyUI custom node package

Prompt Forge is a control room for image prompting that lives entirely inside
ComfyUI: scenes on rails, field stacks with enable/lock/weight/reorder, model
profiles, a prompt-health linter, wildcard variations, a template library,
and optional LLM enhance/draft — all driven from one panel and one node.

**This version is fully self-contained.** There is no separate HTML app, no
bridge server, no second Python process. Install the folder, restart ComfyUI,
done.

## What it does

- **Prompt Forge Composer node** — outputs `positive`, `negative`,
  `positive_preview`, `negative_preview`, `metadata_json`, `scene_json`.
  Wire `positive`/`negative` into your text encoders.
- **Prompt Forge panel** — click the **Prompt Forge** button (top menu, or
  the floating ⚒ button). Edit scenes, fields, profile and negatives with a
  live compiled preview and prompt-health lint — no queueing needed.
- **State lives in the workflow.** The full Prompt Forge state is stored in
  the node's `state_json` widget, so saving the workflow saves everything and
  reloading restores it. No server, no network at generation time.
- **LLM enhance / draft** — one click sends your draft to a local
  OpenAI-compatible server (LM Studio, llama.cpp, vLLM…), Ollama, or the
  Anthropic API, through ComfyUI's own backend. No CORS setup, and API keys
  never touch the browser or your workflow files.
- **Model profiles** — Generic, SDXL, Pony/Illustrious, Flux, Krea 2,
  Qwen Image, Anima, Custom. Profiles control weight syntax (`(tag:1.2)` vs
  natural language), negative policy, quality presets and lint rules.
- **Generic external inputs** — `external_positive_a/b`,
  `external_negative_a`, `external_metadata` accept a STRING from **any**
  node (caption tools, trigger tools, whatever). Position is configurable
  (forced prepend → before quality → forced append; default before quality),
  exact-match dedupe only, non-ASCII preserved. There is intentionally no
  LoRA-specific logic here.

## Installation (Windows)

1. Copy the `PromptForge` folder into `ComfyUI\custom_nodes\`:

   ```bat
   xcopy /E /I PromptForge "C:\path\to\ComfyUI\custom_nodes\PromptForge"
   ```

   (Portable installs: the same, under your portable folder's
   `ComfyUI\custom_nodes\`.)

2. Restart ComfyUI completely — a browser refresh is not enough; ComfyUI
   needs to mount the `web/` directory and register the backend routes.

3. No dependencies to install. The package uses only the Python standard
   library plus what ComfyUI already ships.

**Update:** replace the `PromptForge` folder with the new version and restart
ComfyUI. Your data (LLM config, templates) lives outside the package in
ComfyUI's user directory and survives updates.

**Remove:** delete `ComfyUI\custom_nodes\PromptForge` and restart. Optionally
delete `ComfyUI\user\default\promptforge\` (or `ComfyUI\user\promptforge\`,
depending on your setup) to remove stored config/templates.

## Quick start

1. Start ComfyUI, click **Prompt Forge** (top menu or floating ⚒ button).
2. Click **Create Prompt Forge Composer node** in the panel.
3. Edit Global and Scene fields — the compiled preview updates live.
4. Wire the node's `positive` / `negative` outputs into your text encoders.
5. Queue. Save the workflow — the whole Prompt Forge state rides inside it.

## The panel, section by section

- **Composer node** — pick which Composer the panel edits, or create one.
- **Scenes** — tabs for Global + each scene. `+` adds a scene; double-click a
  tab to rename; per-scene enable/duplicate/reorder/delete.
- **Fields** — each field has a type (subject, style, lighting, …) that sets
  its compile position, plus on/off, 🔒 lock (protects it from AI edits and
  wildcard re-rolls), manual reorder, weight, and delete. `🎲 randomize`
  fills unlocked inspiration fields with random ideas.
- **Profile & output** — model profile, output mode (`single scene`,
  `scenes joined`, `BREAK blocks`), negative severity ladder
  (`off / minimal / normal / strict / nuclear` — your own negative text is
  always kept on top of the ladder), and scene joiner.
- **Live preview** — compiled positive/negative plus the prompt-health score
  and lint warnings (contradictions, quality-tag spam, profile mismatches…).
  The linter never edits your text.
- **LLM enhance** — configure the backend, then:
  - *Enhance output via LLM* rewrites only the compiled output (your fields
    are untouched; the next field edit recompiles over it — same semantics
    as the original app's output box).
  - *Generate full draft with AI* fills the active scene + global fields from
    one AI call. Locked fields are never overwritten.
- **Wildcard variants** — `{a|b|c}` syntax in any unlocked field; generate N
  re-rolled variants, copy one or write it into the node.
- **Template library** — save the current tab's fields as a named template,
  apply templates to any workflow. Stored server-side, shared across
  workflows.
- **Project import / export** — the full state as a JSON file. Import also
  accepts exports from the old standalone app (see Migration).
- **Target routing** — fallback that writes compiled text straight into any
  node's `text` widget (CLIPTextEncode etc.). Prefer wiring outputs.
- **Graph check** — quick sanity lines: node present, outputs wired,
  encoders detected.

## Configuring the LLM backend

In the panel's **LLM enhance** section:

| Backend | Settings | Notes |
|---|---|---|
| Local server (OpenAI-compatible) | Base URL (e.g. `http://127.0.0.1:1234`), model name | LM Studio, llama.cpp server, vLLM, text-generation-webui… Calls `{base}/v1/chat/completions`. |
| Local server (Ollama) | Base URL (default `http://127.0.0.1:11434`), model name | Calls `{base}/api/chat`. |
| Anthropic API | Model (default `claude-sonnet-5`), API key | The key is stored in the Prompt Forge data folder on this machine only — never in workflows, exports, or the browser. |

All requests are made by the ComfyUI Python process with timeouts;
unreachable endpoints produce a readable error in the panel instead of
crashing anything. Settings are saved automatically when you click Enhance
or Draft.

## Compile behavior (queue time)

The panel's JS compiler is canonical; the node ports a subset to Python for
queue-time cases. Precedence at queue time:

1. If any external STRING input is connected and `state_json` parses, the
   state is recompiled in Python so external text lands at its configured
   position.
2. Otherwise, non-empty `compiled_positive`/`compiled_negative` widgets are
   used verbatim (the golden path — matches the panel preview exactly).
3. Otherwise, `state_json` is compiled in Python.
4. Otherwise the node degrades to a plain forced-text combiner.

`forced_positive` / `forced_negative` widgets are combined at the configured
position in every mode.

## Data storage

| Data | Where |
|---|---|
| Scenes, fields, settings, libraries, history | Inside the workflow file (the Composer's `state_json` widget) |
| LLM backend config (incl. API key) | `<ComfyUI user dir>\promptforge\llm_config.json` |
| Template library | `<ComfyUI user dir>\promptforge\templates.json` |

The user dir is ComfyUI's standard one (usually `ComfyUI\user\default\`); if
it can't be resolved the package falls back to `PromptForge\data\`. Writes
are atomic and keep a `.bak` of the previous version. Corrupt files are left
in place and reported, never deleted.

## Migration from previous versions

- **Old workflows keep loading.** The Composer node's widgets and outputs
  are unchanged, and the legacy `PromptForgeBridge` node still exists as a
  plain combiner, so workflows saved with the old three-component setup open
  without missing-node errors.
- **From the standalone `prompt-forge.html` app:** its data lived in the
  browser's localStorage for that page, which ComfyUI cannot read directly.
  Export it from the old app (project export / "Backup all data"), then use
  **Import project JSON…** in the panel. Imports are validated and repaired,
  and v1-format data is migrated by the same logic as before. Nothing old is
  deleted.
- **Retired components:** `promptforge_bridge.py` (the relay server) and the
  polling extension are gone — the panel writes state directly into the
  node, so there is nothing to relay. Anthropic API keys previously stored
  in the browser must be re-entered once in the panel (they are now stored
  server-side).

## Tests

```bat
cd ComfyUI\custom_nodes\PromptForge
python tests\test_composer.py   & rem 14 node tests incl. JS<->Python parity
python tests\test_backend.py    & rem 9 storage + LLM client tests
node tests\run_tests.js         & rem 34 core tests: compiler, migration, linter
```

The panel harness (`tests/panel_harness.html`) mocks the ComfyUI frontend:
serve the package folder with any static server and open
`/tests/panel_harness.html`.

## Troubleshooting

- **No Prompt Forge button** — restart ComfyUI fully (the `web/` directory is
  mounted at startup). Check the browser console for `[PromptForge.Panel]`
  lines.
- **Node missing from the add-node menu** — check the ComfyUI console for
  import errors under `custom_nodes/PromptForge`.
- **LLM errors** — the panel shows the exact failure (unreachable endpoint,
  HTTP status, missing key). Verify the base URL is the origin only
  (`http://127.0.0.1:11434`, no path) and the local server is running.
- **Panel edits don't reach the output** — make sure the Composer selected in
  the panel is the node actually wired into your encoders (Graph check
  section tells you).

## Known limitations

- Regional prompting (`scene.regions[]`) is stored but ignored by the
  compiler — reserved for the future.
- Batch queueing scenes/variants directly from the panel is not implemented;
  use the variants list + copy/use.
- Generation result tracking / thumbnails in history: schema fields exist,
  nothing writes them yet.
- Wildcard pack files (`{file:...}`) are not supported — inline `{a|b|c}` is.
- The panel's history/snapshot browsing from the old standalone app is not
  in the panel yet; state history fields are preserved in `state_json`.
