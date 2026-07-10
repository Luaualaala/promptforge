"""
Prompt Forge backend tests — storage + LLM client, stdlib only, no network.
Run:  python tests/test_backend.py   (from the PromptForge folder)
"""
import importlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_PARENT = os.path.dirname(os.path.dirname(HERE))
PKG_NAME = os.path.basename(os.path.dirname(HERE))
sys.path.insert(0, PKG_PARENT)

storage = importlib.import_module(PKG_NAME + ".storage")
llm_client = importlib.import_module(PKG_NAME + ".llm_client")

PASSED = 0
FAILED = 0


def test(name):
    def deco(fn):
        global PASSED, FAILED
        try:
            fn()
            PASSED += 1
            print(f"  ok  {name}")
        except AssertionError as e:
            FAILED += 1
            print(f"FAIL  {name}\n      {e}")
        return fn
    return deco


# Redirect storage into a temp dir so tests never touch real user data.
_tmp = tempfile.mkdtemp(prefix="promptforge_test_")
storage.get_data_dir = lambda: _tmp


@test("llm config: defaults load when nothing is stored")
def _():
    cfg = storage.load_llm_config()
    assert cfg["provider"] == "local", cfg
    assert cfg["local_url"].startswith("http://127.0.0.1"), cfg


@test("llm config: save merges, blank key means keep")
def _():
    storage.save_llm_config({"provider": "anthropic", "anthropic_key": "sk-test-123"})
    cfg = storage.load_llm_config()
    assert cfg["provider"] == "anthropic" and cfg["anthropic_key"] == "sk-test-123"
    storage.save_llm_config({"anthropic_key": "", "local_model": "qwen2.5:14b"})
    cfg = storage.load_llm_config()
    assert cfg["anthropic_key"] == "sk-test-123", "blank key must keep the stored one"
    assert cfg["local_model"] == "qwen2.5:14b"


@test("llm config: public view never contains the key")
def _():
    pub = storage.public_llm_config()
    assert "anthropic_key" not in pub, pub
    assert pub["anthropic_key_set"] is True, pub


@test("storage: writes are atomic and keep a .bak")
def _():
    storage.save_json("templates.json", [{"name": "a"}])
    storage.save_json("templates.json", [{"name": "b"}])
    path = os.path.join(_tmp, "templates.json")
    with open(path, encoding="utf-8") as f:
        assert json.load(f)[0]["name"] == "b"
    with open(path + ".bak", encoding="utf-8") as f:
        assert json.load(f)[0]["name"] == "a"


@test("storage: unreadable file returns default without deleting it")
def _():
    path = os.path.join(_tmp, "broken.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write("{not json")
    assert storage.load_json("broken.json", {"ok": 1}) == {"ok": 1}
    assert os.path.isfile(path), "corrupt file must be left in place"


@test("storage: templates round-trip with non-ASCII intact")
def _():
    items = [{"name": "狐 template", "fields": [{"type": "subject", "text": "red fox 狐"}]}]
    storage.save_templates(items)
    assert storage.load_templates() == items


@test("llm client: rejects bad local base URLs with a readable error")
def _():
    for bad in ("", "not a url", "ftp://x", "javascript:alert(1)"):
        try:
            llm_client.call_llm({"provider": "local", "local_url": bad}, "s", "u")
            raise AssertionError(f"accepted bad URL {bad!r}")
        except llm_client.LLMError as e:
            assert "not valid" in str(e), str(e)


@test("llm client: anthropic without a key is a readable error")
def _():
    try:
        llm_client.call_llm({"provider": "anthropic", "anthropic_key": ""}, "s", "u")
        raise AssertionError("should have raised")
    except llm_client.LLMError as e:
        assert "API key" in str(e), str(e)


@test("llm client: unreachable local endpoint is a readable error, not a crash")
def _():
    cfg = {"provider": "local", "local_url": "http://127.0.0.1:9",  # discard port
           "local_model": "x", "local_format": "openai", "timeout_seconds": 5}
    try:
        llm_client.call_llm(cfg, "s", "u")
        raise AssertionError("should have raised")
    except llm_client.LLMError as e:
        assert "Could not reach" in str(e) or "timed out" in str(e), str(e)


print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
