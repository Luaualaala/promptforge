"""
Prompt Forge — persistent data storage.

Everything is plain UTF-8 JSON in one clearly defined location:

  1. ComfyUI's user directory when available:  <user_dir>/promptforge/
  2. Fallback (tests, exotic installs):        <this package>/data/

Files:
  llm_config.json   — LLM backend settings (provider, URLs, model names, key)
  templates.json    — cross-workflow template/preset library

Per-workflow state (scenes, fields, libraries, history) intentionally lives
inside the workflow file itself via the Composer node's state_json widget —
that is the primary persistence mechanism and needs no files here.

Writes are atomic (temp file + replace) and keep a one-deep .bak of the
previous version, so existing user data is never clobbered by a bad write.
"""
import json
import os
import tempfile
import threading

_LOCK = threading.Lock()

DEFAULT_LLM_CONFIG = {
    "provider": "local",            # "local" | "anthropic"
    "local_format": "openai",       # "openai" (/v1/chat/completions) | "ollama" (/api/chat)
    "local_url": "http://127.0.0.1:11434",
    "local_model": "",
    "anthropic_model": "claude-sonnet-5",
    "anthropic_key": "",            # stored locally only; never exported, never echoed to the UI
    "timeout_seconds": 120,
}


def get_data_dir():
    """Resolve the Prompt Forge data directory, creating it if needed."""
    base = None
    try:
        import folder_paths  # ComfyUI
        get_user = getattr(folder_paths, "get_user_directory", None)
        if callable(get_user):
            base = os.path.join(get_user(), "promptforge")
    except Exception:
        base = None
    if not base:
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(base, exist_ok=True)
    return base


def _path(name):
    return os.path.join(get_data_dir(), name)


def load_json(name, default):
    path = _path(name)
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        print(f"[PromptForge] could not read {path}: {e} — using defaults "
              f"(the file was left untouched).")
        return default


def save_json(name, data):
    """Atomic write with a .bak of the previous version."""
    path = _path(name)
    with _LOCK:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            if os.path.isfile(path):
                bak = path + ".bak"
                try:
                    os.replace(path, bak)
                except OSError:
                    pass  # backup is best-effort; the write below still proceeds
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def load_llm_config():
    cfg = dict(DEFAULT_LLM_CONFIG)
    stored = load_json("llm_config.json", {})
    if isinstance(stored, dict):
        for k in cfg:
            if k in stored:
                cfg[k] = stored[k]
    return cfg


def save_llm_config(updates):
    """Merge updates into the stored config. Empty-string key means 'keep'."""
    cfg = load_llm_config()
    for k in DEFAULT_LLM_CONFIG:
        if k in updates:
            if k == "anthropic_key" and updates[k] == "":
                continue  # blank key field in the UI means "leave unchanged"
            cfg[k] = updates[k]
    save_json("llm_config.json", cfg)
    return cfg


def public_llm_config(cfg=None):
    """Config as sent to the browser — the API key never leaves the server."""
    cfg = dict(cfg or load_llm_config())
    cfg["anthropic_key_set"] = bool(cfg.get("anthropic_key"))
    cfg.pop("anthropic_key", None)
    return cfg


def load_templates():
    data = load_json("templates.json", [])
    return data if isinstance(data, list) else []


def save_templates(items):
    if not isinstance(items, list):
        raise ValueError("templates payload must be a JSON array")
    save_json("templates.json", items)
