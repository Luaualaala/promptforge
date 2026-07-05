import { app } from "/scripts/app.js";

console.log("[PromptForge.Live] extension file loaded");

// How often to poll the local bridge server for a new prompt, in milliseconds.
const POLL_MS = 1200;

app.registerExtension({
  name: "PromptForge.Live",
  async nodeCreated(node) {
    // Different ComfyUI frontend versions have exposed the registered node-class
    // name under different properties over time — check both rather than assume.
    const cls = node.comfyClass || node.type || node.constructor?.comfyClass;
    console.log("[PromptForge.Live] nodeCreated fired for:", cls);
    if (cls !== "PromptForgeBridge") return;

    console.log("[PromptForge.Live] matched PromptForgeBridge node, id:", node.id);

    let lastPositive = null;
    let lastNegative = null;

    async function poll() {
      const urlWidget = node.widgets?.find(w => w.name === "bridge_url");
      const posWidget = node.widgets?.find(w => w.name === "ai_positive");
      const negWidget = node.widgets?.find(w => w.name === "ai_negative");
      if (!urlWidget || !posWidget || !negWidget) {
        console.warn("[PromptForge.Live] expected widgets not found on node", {
          hasUrl: !!urlWidget, hasPos: !!posWidget, hasNeg: !!negWidget,
          widgetNames: node.widgets?.map(w => w.name)
        });
        return;
      }

      let base;
      try {
        base = new URL(urlWidget.value).origin;
      } catch {
        console.warn("[PromptForge.Live] invalid bridge_url:", urlWidget.value);
        return;
      }

      try {
        const res = await fetch(base + "/get_prompt");
        if (!res.ok) { console.warn("[PromptForge.Live] bridge responded", res.status); return; }
        const data = await res.json();
        if (data.positive !== lastPositive || data.negative !== lastNegative) {
          lastPositive = data.positive;
          lastNegative = data.negative;
          posWidget.value = data.positive || "";
          negWidget.value = data.negative || "";
          node.setDirtyCanvas(true, true);
          console.log("[PromptForge.Live] updated widgets from bridge");
        }
      } catch (e) {
        console.warn("[PromptForge.Live] fetch to bridge failed:", e.message);
      }
    }

    poll();
    const intervalId = setInterval(poll, POLL_MS);

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      clearInterval(intervalId);
      origOnRemoved?.apply(this, arguments);
    };
  },
});
