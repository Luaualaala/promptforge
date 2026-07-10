"""
Prompt Forge Composer node tests — stdlib only, no ComfyUI required.
Run:  python tests/test_composer.py   (from the PromptForge folder)

Imports the real package (so __init__.py's guarded route registration is
exercised too) and cross-checks the Python subset compiler against the
canonical JS compiler via Node, when node is available on PATH.
"""
import importlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_PARENT = os.path.dirname(os.path.dirname(HERE))  # folder containing PromptForge/
PKG_NAME = os.path.basename(os.path.dirname(HERE))   # normally "PromptForge"
sys.path.insert(0, PKG_PARENT)

pkg = importlib.import_module(PKG_NAME)
engine = importlib.import_module(PKG_NAME + ".prompt_engine")

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


def make_state(**overrides):
    state = {
        "version": 2,
        "settings": {
            "modelProfile": "generic", "outputMode": "single",
            "sceneJoiner": "BREAK", "dedupePositive": True,
            "dedupeNegative": True, "negativeSeverity": "off",
            "externalPosition": "before_quality",
        },
        "activeSceneId": "scene_1",
        "global": {
            "fields": [
                {"id": "g1", "type": "style", "text": "watercolor", "enabled": True},
                {"id": "g2", "type": "quality", "text": "best quality", "enabled": True},
            ],
            "negativeFields": [
                {"id": "n1", "type": "negative", "text": "blurry, watermark", "enabled": True},
            ],
        },
        "scenes": [
            {"id": "scene_1", "name": "Scene 1", "enabled": True,
             "fields": [
                 {"id": "f1", "type": "subject", "text": "red fox", "enabled": True},
                 {"id": "f2", "type": "lighting", "text": "golden hour", "enabled": True},
             ],
             "negativeFields": []},
        ],
        "externals": {
            "positiveA": {"label": "", "position": "before_quality"},
            "positiveB": {"label": "", "position": "before_quality"},
            "negativeA": {"label": ""},
        },
    }
    state.update(overrides)
    return state


composer = pkg.NODE_CLASS_MAPPINGS["PromptForgeComposer"]()
bridge = pkg.NODE_CLASS_MAPPINGS["PromptForgeBridge"]()


@test("package exports node mappings and web directory")
def _():
    assert "PromptForgeComposer" in pkg.NODE_CLASS_MAPPINGS
    assert "PromptForgeBridge" in pkg.NODE_CLASS_MAPPINGS
    assert pkg.NODE_DISPLAY_NAME_MAPPINGS["PromptForgeComposer"]
    assert pkg.WEB_DIRECTORY == "./web/js", pkg.WEB_DIRECTORY
    web = os.path.join(os.path.dirname(HERE), "web", "js")
    for f in ("promptforge_state.js", "promptforge_profiles.js",
              "promptforge_linter.js", "promptforge_compiler.js",
              "promptforge_panel.js", "promptforge_ui.css"):
        assert os.path.isfile(os.path.join(web, f)), f"missing web asset {f}"


@test("legacy bridge node behavior is unchanged")
def _():
    pos, neg, pprev, nprev = bridge.combine(
        "http://x", "cinematic", "text", "prepend", "a red fox", "blurry")
    assert pos == "cinematic, a red fox", pos
    assert neg == "text, blurry", neg
    assert "[EXECUTIVE]" in pprev and "[AI-GENERATED]" in pprev


@test("composer: plain combiner mode when everything is empty")
def _():
    out = composer.compose("", "", "", "prepend", "lead-in", "bad stuff")
    assert out[0] == "lead-in", out[0]
    assert out[1] == "bad stuff", out[1]
    meta = json.loads(out[4])
    assert meta["source"] == "combiner"


@test("composer: compiled widgets win when no externals are connected")
def _():
    out = composer.compose(
        json.dumps(make_state()), "panel compiled positive", "panel negative",
        "prepend", "forced lead", "forced neg")
    assert out[0] == "forced lead, panel compiled positive", out[0]
    assert out[1] == "forced neg, panel negative", out[1]
    meta = json.loads(out[4])
    assert meta["source"] == "compiled_widgets"


@test("composer: state compiles in Python when compiled widgets are empty")
def _():
    out = composer.compose(json.dumps(make_state()), "", "", "prepend", "", "")
    assert out[0] == "red fox, watercolor, golden hour, best quality", out[0]
    assert out[1] == "blurry, watermark", out[1]
    meta = json.loads(out[4])
    assert meta["source"] == "python_compiler"
    scenes = json.loads(out[5])
    assert scenes[0]["name"] == "Scene 1"


@test("composer: connected external forces Python compile at configured position")
def _():
    out = composer.compose(
        json.dumps(make_state()), "stale compiled", "", "prepend", "", "",
        external_positive_a="trigger 詞彙")
    pos = out[0]
    assert "trigger 詞彙" in pos, pos  # preserved exactly, incl. non-ASCII
    assert pos.index("trigger 詞彙") < pos.index("best quality"), pos
    assert "stale compiled" not in pos


@test("composer: external exact-dedupes against existing phrases on compiled path")
def _():
    out = composer.compose(
        "", "red fox, watercolor", "", "prepend", "", "",
        external_positive_a="red fox, new phrase")
    assert out[0] == "red fox, watercolor, new phrase", out[0]


@test("composer: empty external slots are ignored")
def _():
    a = composer.compose(json.dumps(make_state()), "", "", "prepend", "", "")
    b = composer.compose(json.dumps(make_state()), "", "", "prepend", "", "",
                         external_positive_a="", external_negative_a="")
    assert a[0] == b[0] and a[1] == b[1]


@test("composer: invalid state_json degrades gracefully")
def _():
    out = composer.compose("{broken json", "compiled ok", "", "prepend", "", "")
    assert out[0] == "compiled ok", out[0]


@test("composer: scenes_joined + disabled scene in Python compiler")
def _():
    state = make_state()
    state["settings"]["outputMode"] = "scenes_joined"
    state["settings"]["sceneJoiner"] = "newline"
    state["scenes"].append({
        "id": "scene_2", "name": "S2", "enabled": True,
        "fields": [{"id": "f3", "type": "subject", "text": "blue owl", "enabled": True}],
        "negativeFields": []})
    state["scenes"].append({
        "id": "scene_3", "name": "S3", "enabled": False,
        "fields": [{"id": "f4", "type": "subject", "text": "green crab", "enabled": True}],
        "negativeFields": []})
    out = composer.compose(json.dumps(state), "", "", "prepend", "", "")
    blocks = out[0].split("\n")
    assert len(blocks) == 2, out[0]
    assert "watercolor" in blocks[0] and "watercolor" in blocks[1]
    assert "green crab" not in out[0]


@test("composer: weights honored per profile in Python compiler")
def _():
    state = make_state()
    state["settings"]["modelProfile"] = "sdxl"
    state["scenes"][0]["fields"][0]["weight"] = 1.2
    out = composer.compose(json.dumps(state), "", "", "prepend", "", "")
    assert "(red fox:1.2)" in out[0], out[0]
    state["settings"]["modelProfile"] = "flux"
    out = composer.compose(json.dumps(state), "", "", "prepend", "", "")
    assert "(red fox" not in out[0], out[0]


@test("composer: negative severity ladder in Python compiler")
def _():
    state = make_state()
    state["settings"]["negativeSeverity"] = "strict"
    out = composer.compose(json.dumps(state), "", "", "prepend", "", "")
    assert out[1].startswith("blurry, watermark"), out[1]
    assert "bad hands" in out[1]


@test("composer: IS_CHANGED is stable, changes when inputs change")
def _():
    cls = pkg.NODE_CLASS_MAPPINGS["PromptForgeComposer"]
    a = cls.IS_CHANGED("s", "p", "n", "prepend", "", "")
    b = cls.IS_CHANGED("s", "p", "n", "prepend", "", "")
    c = cls.IS_CHANGED("s", "p2", "n", "prepend", "", "")
    assert a == b and a != c


@test("JS and Python compilers agree on the core state (parity check)")
def _():
    node = shutil.which("node")
    if not node:
        print("      (node not found — parity check skipped)")
        return
    state = make_state()
    state["settings"]["outputMode"] = "scenes_joined"
    state["settings"]["sceneJoiner"] = "BREAK"
    state["settings"]["negativeSeverity"] = "normal"
    state["scenes"].append({
        "id": "scene_2", "name": "S2", "enabled": True,
        "fields": [{"id": "f3", "type": "subject", "text": "blue owl, 狐", "enabled": True,
                    "weight": 1.15}],
        "negativeFields": [{"id": "n2", "type": "negative", "text": "extra tails", "enabled": True}]})
    js_dir = os.path.join(os.path.dirname(HERE), "web", "js").replace("\\", "/")
    script = f"""
      const fs = require('fs');
      const jsDir = {json.dumps(js_dir)};
      ['promptforge_state.js','promptforge_profiles.js','promptforge_linter.js','promptforge_compiler.js']
        .forEach(f => (0, eval)(fs.readFileSync(jsDir + '/' + f, 'utf8')));
      const state = {json.dumps(state)};
      const c = PromptForge.compilePromptForgeState(state, {{}});
      process.stdout.write(JSON.stringify({{positive: c.positive, negative: c.negative}}));
    """
    js_out = json.loads(subprocess.run(
        [node, "-e", script], capture_output=True, text=True, check=True,
        encoding="utf-8").stdout)
    py_out = engine.compile_state(state)
    assert js_out["positive"] == py_out["positive"], (
        f"\n      js: {js_out['positive']}\n      py: {py_out['positive']}")
    assert js_out["negative"] == py_out["negative"], (
        f"\n      js: {js_out['negative']}\n      py: {py_out['negative']}")


print(f"\n{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
