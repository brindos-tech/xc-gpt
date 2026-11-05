import { test } from "node:test";
import assert from "node:assert/strict";

test("weather index that will not load: the planner is left alone, not re-rendered in a loop", async () => {
  const { createWxController } = await import("../../assets/js/planner/wx-controller.js");
  globalThis.document = { getElementById: () => ({}) };
  const state = { tripDate: "2026-11-05", wxDay: "2026-11-05", wxLayers: new Set(["radar"]), wxTime: null };
  let renders = 0;
  let wx;
  const render = () => {
    renders++;
    wx.render(state);
  };
  wx = createWxController({ store: { getState: () => state, setState() {} }, map: {}, loadJson: () => Promise.reject(new Error("404")), today: new Date(), onChange: render });
  render();
  await new Promise((r) => setTimeout(r, 20)); // would never get here if it looped
  assert.equal(renders, 1);
  assert.equal(wx.ready, false);
  delete globalThis.document;
});
