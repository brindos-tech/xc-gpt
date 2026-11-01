// Append-only JSON-lines store: one line per event ({op:"add"} or {op:"del"}).
// Comments are small and few, so the whole set lives in memory and the file is
// only appended to (and compacted on start). No native modules, so it runs on
// any Node >= 20 and the file survives restarts on a Fly volume.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function openStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const byId = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.op === "add" && ev.comment?.id) byId.set(ev.comment.id, ev.comment);
        else if (ev.op === "del") byId.delete(ev.id);
      } catch {
        // a torn last line after a crash: skip it
      }
    }
    // compact: rewrite as adds only
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, [...byId.values()].map((comment) => JSON.stringify({ op: "add", comment })).join("\n") + (byId.size ? "\n" : ""));
    renameSync(tmp, file);
  }
  const append = (ev) => appendFileSync(file, JSON.stringify(ev) + "\n");

  const newest = (arr) => arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  return {
    add(comment) {
      byId.set(comment.id, comment);
      append({ op: "add", comment });
    },
    remove(id) {
      if (!byId.delete(id)) return false;
      append({ op: "del", id });
      return true;
    },
    removeWhere(pred) {
      const ids = [...byId.values()].filter(pred).map((c) => c.id);
      for (const id of ids) this.remove(id);
      return ids.length;
    },
    bySubject: (subject, limit = 100) => newest([...byId.values()].filter((c) => c.subject === subject)).slice(0, limit),
    all: (limit = 500) => newest([...byId.values()]).slice(0, limit),
    /** { subject: { n, avg } } for every subject that has comments. */
    summary() {
      const out = {};
      for (const c of byId.values()) {
        const s = (out[c.subject] ||= { n: 0, rated: 0, sum: 0 });
        s.n++;
        if (c.rating) {
          s.rated++;
          s.sum += c.rating;
        }
      }
      return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, { n: s.n, avg: s.rated ? Math.round((s.sum / s.rated) * 10) / 10 : null }]));
    },
    size: () => byId.size,
  };
}
