// The comments log. Everything is built with textContent — comment text is
// untrusted and never goes through innerHTML.
const $ = (id) => document.getElementById(id);
let token = "";
let comments = [];
try {
  token = localStorage.getItem("xcgpt-admin") || "";
} catch {
  // storage blocked: the token just isn't remembered
}
$("token").value = token;

const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(res.status === 401 ? "Wrong token." : `Error ${res.status}`);
  return res.json();
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function render() {
  const q = $("filter").value.toLowerCase();
  const shown = comments.filter((c) => !q || JSON.stringify(c).toLowerCase().includes(q));
  $("count").textContent = `${shown.length} of ${comments.length}`;
  const ul = $("list");
  ul.replaceChildren();
  for (const c of shown) {
    const li = el("li");
    const head = el("div", "head");
    head.append(el("b", "", c.subject), el("span", "", c.rating ? "★".repeat(c.rating) : "no rating"), el("span", "", new Date(c.createdAt).toLocaleString()), el("span", "muted", `${c.name} · poster ${c.ipHash}`));
    li.append(head);
    const facts = [
      c.visited && `visited ${c.visited}`,
      c.freeFood && `free food: ${c.freeFood}`,
      c.crewCar && `crew car: ${c.crewCar}`,
      c.aircard && `AIR Card: ${c.aircard}`,
      c.fees && `fees: ${c.fees}`,
      c.planespotters && `planespotters: ${c.planespotters}`,
      c.amenities && `amenities: ${c.amenities}`,
    ].filter(Boolean);
    if (facts.length) li.append(el("div", "facts", facts.join(" · ")));
    if (c.notes) li.append(el("div", "notes", c.notes));
    const actions = el("div", "actions");
    const del = el("button", "danger", "Delete");
    del.addEventListener("click", async () => {
      if (!confirm("Delete this comment?")) return;
      await api(`/admin/comments/${encodeURIComponent(c.id)}`, { method: "DELETE" }).then(load, (e) => ($("msg").textContent = e.message));
    });
    const purge = el("button", "", "Delete all from this poster");
    purge.addEventListener("click", async () => {
      const n = comments.filter((x) => x.ipHash === c.ipHash).length;
      if (!confirm(`Delete all ${n} comment(s) from poster ${c.ipHash}?`)) return;
      await api("/admin/purge", { method: "POST", body: JSON.stringify({ ipHash: c.ipHash }) }).then(load, (e) => ($("msg").textContent = e.message));
    });
    actions.append(del, purge);
    li.append(actions);
    ul.append(li);
  }
}

async function load() {
  $("msg").textContent = "";
  try {
    comments = (await api("/admin/comments?limit=1000")).comments;
    render();
  } catch (e) {
    $("msg").textContent = e.message;
  }
}

$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  try {
    localStorage.setItem("xcgpt-admin", token);
  } catch {
    // fine
  }
  load();
});
$("refresh").addEventListener("click", load);
$("filter").addEventListener("input", render);
if (token) load();
