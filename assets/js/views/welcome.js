// The first-visit welcome screen: a native <dialog> (Esc closes it, focus stays
// inside while it is open) shown once, remembered in localStorage, and
// reopened from the "How to use" button in the header.
import { pinSvg } from "../planner/planner-view.js";

const KEY = "xcgpt-welcome-seen";

const seen = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // shown again next time
  }
};

export function initWelcome() {
  const dialog = document.getElementById("welcome");
  const openBtn = document.getElementById("helpBtn");
  if (!dialog || typeof dialog.showModal !== "function") return;
  // the example pins are the real map marks
  dialog.querySelectorAll("[data-wpin]").forEach((el) => {
    const kind = el.dataset.wpin;
    el.innerHTML = pinSvg({ towered: kind === "towered" || kind === "military", military: kind === "military", status: el.dataset.status || null });
  });
  const close = () => dialog.open && dialog.close();
  document.getElementById("welcomeGo").addEventListener("click", close);
  dialog.addEventListener("close", () => {
    remember();
    openBtn?.focus();
    dialog.querySelector(".welcome-card").scrollTop = 0;
  });
  // a click on the dimmed backdrop (outside the card) closes it too
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  openBtn?.addEventListener("click", () => dialog.showModal());
  if (!seen()) dialog.showModal();
}
