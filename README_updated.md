# Prompt Forge

Prompt Forge is a native ComfyUI custom node and panel for building, organizing,
and compiling image-generation prompts.

This repository currently contains **two separate projects**:

```text
PromptForge/           ← Current version. Install this one.
prompt-bridge-forge/  ← Older legacy bridge version. Kept for compatibility.
```

They are independent folders. Do not merge their contents together.

## Recommended installation

For the current native ComfyUI version, copy **only** the `PromptForge` folder
into your ComfyUI custom nodes directory:

```text
ComfyUI/custom_nodes/PromptForge/
```

Your final folder layout should look similar to this:

```text
ComfyUI/
└── custom_nodes/
    └── PromptForge/
        ├── __init__.py
        ├── ...
        └── other Prompt Forge files
```

Then restart ComfyUI.

> **Important:** Do not copy the entire GitHub repository into
> `ComfyUI/custom_nodes/`. Only copy the `PromptForge` folder.

## Which folder should I use?

### `PromptForge` — current version

This is the new, recommended version.

It is a self-contained ComfyUI custom node package with its own Python and
frontend files. It does not require the old standalone bridge to function.

Use this folder when installing Prompt Forge into ComfyUI.

### `prompt-bridge-forge` — legacy version

This is the older bridge-based version and is kept only for existing users,
older workflows, and reference.

The legacy route uses a standalone browser interface and bridge process:

```text
prompt-forge.html → promptforge_bridge.py → PromptForgeBridge node
```

New users should normally ignore this folder.

## Native Prompt Forge workflow

1. Copy `PromptForge/` into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI.
3. Click the **Prompt Forge** button in the ComfyUI interface.
4. Create or select a **Prompt Forge Composer** node.
5. Build your scenes, fields, and model profile in the panel.
6. Connect the `positive` and `negative` outputs to your text encoders.
7. Save the workflow. Prompt Forge stores its state inside the node.

## Main features

- Scene-based prompt building with a Global section
- Enable, lock, reorder, and weight individual fields
- Model profiles for tag-based and natural-language models
- Positive and negative prompt compilation
- Prompt health checks and linting
- Source-map inspection
- Wildcard variations such as `{red|blue|green}`
- History, favorites, notes, snapshots, and project import/export
- External STRING inputs from caption, trigger, or helper nodes
- Workflow-persistent state through the node's `state_json` widget

## Composer outputs

```text
positive
negative
positive_preview
negative_preview
metadata_json
scene_json
```

## External inputs

Prompt Forge accepts generic STRING input from other ComfyUI nodes through:

```text
external_positive_a
external_positive_b
external_negative_a
external_metadata
```

These inputs can come from caption tools, trigger tools, LoRA helpers, or any
other node that outputs a STRING. Prompt Forge does not depend on a specific
LoRA or trigger implementation.

## Updating

When updating the native version, replace or update the contents of:

```text
ComfyUI/custom_nodes/PromptForge/
```

The legacy `prompt-bridge-forge` folder is not required for the native version.

## Tests

Run these commands from inside the relevant project folder:

```bash
node tests/run_tests.js
python tests/test_composer.py
```

## Legacy migration notes

The older bridge project may still contain migration and compatibility logic
for v1 browser data, presets, history, and localStorage state. That logic
belongs to the legacy project and is separate from the native `PromptForge`
custom node package.

## Planned features

- Regional prompting
- Direct batch queueing for scenes and variants
- Generation-result tracking and thumbnails
- Wildcard pack files
- Storyboard card view
- Optional ComfyUI user-directory storage
