/*
 * Prompt Forge core test runner — plain Node, no dependencies, no network.
 * Run:  node tests/run_tests.js   (from the PromptForge folder)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const JS_DIR = path.join(__dirname, "..", "web", "js");
["promptforge_state.js", "promptforge_profiles.js", "promptforge_linter.js", "promptforge_compiler.js"].forEach(
  function (f) {
    // The core files are classic scripts that attach to globalThis — eval them.
    (0, eval)(fs.readFileSync(path.join(JS_DIR, f), "utf8"));
  }
);

const PF = globalThis.PromptForge;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    failed++;
    console.error("FAIL  " + name + "\n      " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || "not equal") + "\n      got:      " + JSON.stringify(a) + "\n      expected: " + JSON.stringify(b));
}

// --------------------------------------------------------------- state ----
test("default state validates cleanly", function () {
  const s = PF.makeDefaultState();
  const res = PF.validateAndRepair(s);
  assertEq(res.issues.length, 0, "no repair issues expected");
  assertEq(res.state.version, 2);
});

test("validateAndRepair repairs junk without deleting unknown keys", function () {
  const res = PF.validateAndRepair({
    version: "wat",
    scenes: [{ name: 42, fields: [{ text: 7 }, null], futureThing: { keep: true } }],
    myUnknownTopLevel: "preserve me",
  });
  const s = res.state;
  assert(res.issues.length > 0, "should report issues");
  assertEq(s.version, 2);
  assertEq(typeof s.scenes[0].id, "string");
  assertEq(s.scenes[0].fields.length, 1, "null field dropped");
  assertEq(s.scenes[0].fields[0].text, "7", "non-string text coerced");
  assertEq(s.myUnknownTopLevel, "preserve me", "unknown top-level key preserved");
  assert(s.scenes[0].futureThing.keep === true, "unknown scene key preserved");
});

test("legacy draft migration maps old fields into v2 state", function () {
  const state = PF.migrateLegacyDraft({
    f_subject: "silver fox spirit",
    f_style: "ukiyo-e woodblock",
    f_negative: "extra tails, blurry",
    hasChar: true,
    gender: "female",
    age: "adult",
    syntaxMode: "natural",
  });
  const subj = state.scenes[0].fields.find(function (f) { return f.type === "subject"; });
  assertEq(subj.text, "silver fox spirit");
  const style = state.global.fields.find(function (f) { return f.type === "style"; });
  assertEq(style.text, "ukiyo-e woodblock");
  const char = state.global.fields.find(function (f) { return f.type === "character"; });
  assertEq(char.text, "1girl, adult");
  assertEq(state.global.negativeFields[0].text, "extra tails, blurry");
  assertEq(state.settings.modelProfile, "flux", "natural syntax maps to flux profile");
});

test("project export/import roundtrip preserves scenes and settings", function () {
  const s = PF.makeDefaultState();
  s.scenes[0].name = "cliff jump";
  s.scenes[0].fields[0].text = "woman jumping off a cliff";
  s.settings.modelProfile = "sdxl";
  const json = PF.exportProject(s);
  const res = PF.importProject(json);
  assertEq(res.state.scenes[0].name, "cliff jump");
  assertEq(res.state.scenes[0].fields[0].text, "woman jumping off a cliff");
  assertEq(res.state.settings.modelProfile, "sdxl");
});

test("importProject rejects garbage with a readable error", function () {
  let msg = "";
  try { PF.importProject("{not json"); } catch (e) { msg = e.message; }
  assert(/Not valid JSON/.test(msg), "bad JSON message, got: " + msg);
  try { PF.importProject('{"foo": 1}'); } catch (e) { msg = e.message; }
  assert(/does not look like/.test(msg), "non-project message, got: " + msg);
});

// ------------------------------------------------------------ compiler ----
function stateWithText() {
  const s = PF.makeDefaultState();
  s.settings.negativeSeverity = "off"; // keep negatives predictable in tests
  s.global.fields.find(function (f) { return f.type === "style"; }).text = "watercolor";
  s.global.fields.find(function (f) { return f.type === "quality"; }).text = "best quality";
  const sc = s.scenes[0];
  sc.fields.find(function (f) { return f.type === "subject"; }).text = "red fox";
  sc.fields.find(function (f) { return f.type === "lighting"; }).text = "golden hour";
  return s;
}

test("single mode compiles in deterministic type order", function () {
  const s = stateWithText();
  const c = PF.compilePromptForgeState(s);
  assertEq(c.positive, "red fox, watercolor, golden hour, best quality");
});

test("disabled field disappears from output", function () {
  const s = stateWithText();
  s.scenes[0].fields.find(function (f) { return f.type === "lighting"; }).enabled = false;
  const c = PF.compilePromptForgeState(s);
  assertEq(c.positive.indexOf("golden hour"), -1);
});

test("empty fields never create double commas", function () {
  const s = stateWithText();
  s.scenes[0].fields.find(function (f) { return f.type === "subject"; }).text = "  red fox ,,  , ";
  const c = PF.compilePromptForgeState(s);
  assert(c.positive.indexOf(",,") === -1, "found double comma: " + c.positive);
  assert(c.positive.indexOf("red fox") === 0, "text trimmed: " + c.positive);
});

test("global fields appear in every scene block (scenes_joined)", function () {
  const s = stateWithText();
  const sc2 = PF.makeScene({ name: "Scene 2", fields: [{ type: "subject", text: "blue owl" }] });
  s.scenes.push(sc2);
  s.settings.outputMode = "scenes_joined";
  s.settings.sceneJoiner = "newline";
  const c = PF.compilePromptForgeState(s);
  const blocks = c.positive.split("\n");
  assertEq(blocks.length, 2);
  assert(blocks[0].indexOf("watercolor") !== -1, "scene 1 has global style");
  assert(blocks[1].indexOf("watercolor") !== -1, "scene 2 has global style");
  assert(blocks[1].indexOf("blue owl") !== -1);
});

test("disabled scene disappears from scenes_joined output", function () {
  const s = stateWithText();
  const sc2 = PF.makeScene({ name: "Scene 2", fields: [{ type: "subject", text: "blue owl" }] });
  sc2.enabled = false;
  s.scenes.push(sc2);
  s.settings.outputMode = "scenes_joined";
  const c = PF.compilePromptForgeState(s);
  assertEq(c.positive.indexOf("blue owl"), -1);
});

test("break_blocks joins scenes with BREAK", function () {
  const s = stateWithText();
  s.scenes.push(PF.makeScene({ name: "S2", fields: [{ type: "subject", text: "blue owl" }] }));
  s.settings.outputMode = "break_blocks";
  const c = PF.compilePromptForgeState(s);
  assert(c.positive.indexOf("\nBREAK\n") !== -1, "BREAK joiner present");
});

test("scene order changes output order", function () {
  const s = stateWithText();
  s.scenes.push(PF.makeScene({ name: "S2", fields: [{ type: "subject", text: "blue owl" }] }));
  s.settings.outputMode = "scenes_joined";
  s.settings.sceneJoiner = "newline";
  PF.moveScene(s, s.scenes[1].id, -1);
  const c = PF.compilePromptForgeState(s);
  assert(c.positive.split("\n")[0].indexOf("blue owl") !== -1, "moved scene compiles first");
});

test("weights emitted for sdxl, suppressed for flux", function () {
  const s = stateWithText();
  s.settings.modelProfile = "sdxl";
  s.scenes[0].fields.find(function (f) { return f.type === "subject"; }).weight = 1.2;
  let c = PF.compilePromptForgeState(s);
  assert(c.positive.indexOf("(red fox:1.2)") !== -1, "sdxl weight syntax: " + c.positive);
  s.settings.modelProfile = "flux";
  c = PF.compilePromptForgeState(s);
  assert(c.positive.indexOf("(red fox") === -1, "flux must not weight: " + c.positive);
  assert(c.positive.indexOf("red fox") !== -1);
});

test("exact dedupe removes repeats but keeps non-ASCII distinct", function () {
  const s = stateWithText();
  s.scenes[0].fields.find(function (f) { return f.type === "subject"; }).text =
    "red fox, red fox, 狐, 狐の精霊";
  const c = PF.compilePromptForgeState(s);
  assertEq((c.positive.match(/red fox/g) || []).length, 1, "exact dupe removed");
  assert(c.positive.indexOf("狐") !== -1 && c.positive.indexOf("狐の精霊") !== -1,
    "non-ASCII variants both kept (no fuzzy dedupe)");
});

test("external positive lands at before_quality by default and is ignored when empty", function () {
  const s = stateWithText();
  let c = PF.compilePromptForgeState(s, { externals: { positiveA: "trigger词彙" } });
  const idxExternal = c.positive.indexOf("trigger词彙");
  const idxQuality = c.positive.indexOf("best quality");
  assert(idxExternal !== -1, "external present");
  assert(idxExternal < idxQuality, "external before quality: " + c.positive);
  c = PF.compilePromptForgeState(s, { externals: { positiveA: "" } });
  assertEq(c.positive, "red fox, watercolor, golden hour, best quality", "empty slot ignored");
});

test("external position forced_prepend puts it first", function () {
  const s = stateWithText();
  s.externals.positiveA.position = "forced_prepend";
  const c = PF.compilePromptForgeState(s, { externals: { positiveA: "LEAD" } });
  assert(c.positive.indexOf("LEAD") === 0, "external leads: " + c.positive);
});

test("forced positive/negative from options combine like the old bridge node", function () {
  const s = stateWithText();
  const c = PF.compilePromptForgeState(s, {
    forcedPositive: "cinematic still",
    forcedNegative: "text, watermark",
    forcedPosition: "prepend",
  });
  assert(c.positive.indexOf("cinematic still") === 0, "forced prepended: " + c.positive);
  assert(c.negative.indexOf("text") !== -1 && c.negative.indexOf("watermark") !== -1);
});

test("negative compile: base + scene + dedupe", function () {
  const s = stateWithText();
  s.global.negativeFields[0].text = "blurry, watermark";
  s.scenes[0].negativeFields.push(PF.makeField({ type: "negative", text: "watermark, extra tails" }));
  const c = PF.compilePromptForgeState(s);
  assertEq(c.negative, "blurry, watermark, extra tails");
});

test("negative severity ladder adds profile negatives; off disables it", function () {
  const s = stateWithText();
  s.global.negativeFields[0].text = "my custom bogeyman";
  s.settings.negativeSeverity = "strict";
  let c = PF.compilePromptForgeState(s);
  assert(c.negative.indexOf("my custom bogeyman") === 0, "user negatives stay first");
  assert(c.negative.indexOf("bad hands") !== -1, "strict ladder applied");
  s.settings.negativeSeverity = "off";
  c = PF.compilePromptForgeState(s);
  assertEq(c.negative, "my custom bogeyman");
});

test("negative category toggle removes category terms but keeps custom terms", function () {
  const s = stateWithText();
  s.global.negativeFields[0].text = "bad hands, extra fingers, my weird thing";
  s.settings.negativeCategoriesOff = ["hands"];
  const c = PF.compilePromptForgeState(s);
  assertEq(c.negative.indexOf("bad hands"), -1);
  assertEq(c.negative.indexOf("extra fingers"), -1);
  assert(c.negative.indexOf("my weird thing") !== -1);
});

test("source map spans match the compiled positive", function () {
  const s = stateWithText();
  const c = PF.compilePromptForgeState(s);
  assert(c.sourceMap.length >= 4, "has entries");
  c.sourceMap.forEach(function (e) {
    assertEq(c.positive.slice(e.start, e.end), e.text, "span mismatch for " + e.text);
  });
  const fox = c.sourceMap.find(function (e) { return e.text === "red fox"; });
  assertEq(fox.sceneId, s.scenes[0].id);
  assert(/^scene\./.test(fox.source));
});

test("weighted phrases are not split on their inner colon/comma", function () {
  const s = stateWithText();
  s.scenes[0].fields.find(function (f) { return f.type === "subject"; }).text =
    "(wet hair, dripping:1.2), calm face";
  const c = PF.compilePromptForgeState(s);
  assert(c.positive.indexOf("(wet hair, dripping:1.2)") !== -1, "group preserved: " + c.positive);
});

test("metadata carries counts and scene list", function () {
  const s = stateWithText();
  const c = PF.compilePromptForgeState(s);
  assertEq(c.metadata.profile, "generic");
  assertEq(c.metadata.scenes.length, 1);
  assert(c.metadata.counts.positiveChars > 0);
});

// ------------------------------------------------------------ variants ----
test("wildcards expand; locked fields stay unchanged across variants", function () {
  const s = stateWithText();
  const subj = s.scenes[0].fields.find(function (f) { return f.type === "subject"; });
  subj.text = "fox in {rain|snow|fog}";
  const light = s.scenes[0].fields.find(function (f) { return f.type === "lighting"; });
  light.text = "{golden hour|moonlight}";
  light.locked = true;
  const variants = PF.generateVariants(s, {}, 6, 42);
  assertEq(variants.length, 6);
  variants.forEach(function (v) {
    assert(!PF.hasWildcards(v.positive), "wildcards expanded: " + v.positive);
    assert(v.positive.indexOf("golden hour") !== -1, "locked field pinned to first option");
  });
  const distinct = new Set(variants.map(function (v) { return v.positive; }));
  assert(distinct.size > 1, "variants actually vary");
});

test("diffPrompts reports added/removed phrases", function () {
  const d = PF.diffPrompts("red fox, watercolor, night", "red fox, oil painting, night, moon");
  assertEq(d.removed.join("|"), "watercolor");
  assertEq(d.added.join("|"), "oil painting|moon");
});

// -------------------------------------------------------------- linter ----
test("known contradiction produces a warning; disabled fields ignored", function () {
  const s = stateWithText();
  const comp = s.scenes[0].fields.find(function (f) { return f.type === "composition"; });
  comp.text = "tight close-up, full body";
  let lint = PF.lintCompiled(s, PF.compilePromptForgeState(s));
  assert(lint.warnings.some(function (w) { return w.id === "closeup_fullbody"; }),
    "contradiction detected");
  assert(lint.score < 100);
  comp.enabled = false;
  lint = PF.lintCompiled(s, PF.compilePromptForgeState(s));
  assert(!lint.warnings.some(function (w) { return w.id === "closeup_fullbody"; }),
    "disabled field ignored");
});

test("flux profile warns about huge negatives; sdxl does not", function () {
  const s = stateWithText();
  s.settings.negativeSeverity = "nuclear";
  s.global.negativeFields[0].text = PF.NEG_SEVERITY.nuclear + ", even, more, junk, terms, here, padding, out, the, prompt, to, be, long, enough, for, the, threshold, check, yes";
  s.settings.modelProfile = "flux";
  let lint = PF.lintCompiled(s, PF.compilePromptForgeState(s));
  assert(lint.warnings.some(function (w) { return w.id === "huge_negative_for_profile"; }),
    "flux flags negative soup");
  s.settings.modelProfile = "sdxl";
  lint = PF.lintCompiled(s, PF.compilePromptForgeState(s));
  assert(!lint.warnings.some(function (w) { return w.id === "huge_negative_for_profile"; }),
    "sdxl tolerates it");
});

test("linter flags weight syntax on flux", function () {
  const s = stateWithText();
  s.settings.modelProfile = "flux";
  s.scenes[0].fields.find(function (f) { return f.type === "subject"; }).text = "(red fox:1.3)";
  const lint = PF.lintCompiled(s, PF.compilePromptForgeState(s));
  assert(lint.warnings.some(function (w) { return w.id === "weights_unsupported"; }));
});

test("empty subject warning fires per scene", function () {
  const s = PF.makeDefaultState();
  s.settings.negativeSeverity = "off";
  const lint = PF.lintCompiled(s, PF.compilePromptForgeState(s));
  assert(lint.warnings.some(function (w) { return w.id === "empty_subject"; }));
});

// ----------------------------------------------------- negative cleaner ----
test("groupNegative sorts terms into categories and keeps custom", function () {
  const g = PF.groupNegative("bad hands, watermark, my odd term, extra fingers");
  assertEq(g.hands.join("|"), "bad hands|extra fingers");
  assertEq(g.watermark.join("|"), "watermark");
  assertEq(g.custom.join("|"), "my odd term");
});

test("cleanNegative dedupes exactly and respects category toggles", function () {
  const cleaned = PF.cleanNegative("blurry, blurry, bad hands, ヘタな手, bad hands", ["hands"]);
  assertEq(cleaned, "blurry, ヘタな手");
});

// ---------------------------------------------------- scene utilities ----
test("duplicateScene deep-copies with fresh ids", function () {
  const s = stateWithText();
  const copy = PF.duplicateScene(s, s.scenes[0].id);
  assertEq(s.scenes.length, 2);
  assert(copy.id !== s.scenes[0].id);
  assert(copy.fields[0].id !== s.scenes[0].fields[0].id);
  assertEq(copy.fields.find(function (f) { return f.type === "subject"; }).text, "red fox");
});

test("deleting a scene never touches global fields", function () {
  const s = stateWithText();
  const globalCount = s.global.fields.length;
  s.scenes.splice(0, 1);
  const res = PF.validateAndRepair(s);
  assertEq(res.state.global.fields.length, globalCount);
  assertEq(res.state.scenes.length, 1, "repair recreated a scene");
});

// ------------------------------------------------------------ registry ----
test("registry hooks accept good data and reject junk", function () {
  assert(PF.registerPromptForgeProfile({ id: "test_prof", label: "T", supportsWeights: false }));
  assertEq(PF.getProfile("test_prof").label, "T");
  assert(!PF.registerPromptForgeProfile(null), "bad profile rejected");
  assert(PF.registerPromptForgeLinterRule({
    id: "custom_rule", anyA: ["aaa"], anyB: ["bbb"], message: "custom clash",
  }));
  assert(!PF.registerPromptForgeLinterRule({ id: "nope" }), "bad rule rejected");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
