#!/usr/bin/env node
// Weekly "PR leads" sweep — the open-web half of PR-opportunity discovery
// (the structured half is the Ticketmaster / SeatGeek / MLB tagging in
// lib/pr.js). Two parts, each optional, each keyed by its own secret:
//
//  1. Web search (TAVILY_API_KEY or BRAVE_API_KEY): a fixed set of queries
//     — military appreciation nights, air shows seeking static displays —
//     across the states around the bases. Results are leads for a person
//     to check, not events: only title + URL are kept (Brave's terms don't
//     allow storing result content without a storage plan).
//  2. DVIDS (DVIDS_API_KEY): DoD's own news archive, searched for T-6
//     flyover stories — the record of which venues and organizers have
//     hosted training-aircraft flyovers before, i.e. who asks.
//
// Writes data/generated/pr-leads.json. Leads accumulate across runs (kept
// 60 days, newest first) so a weekly sweep builds a review queue. With no
// keys at all this leaves the existing file untouched.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJsonWithRetry, createRateLimiter } from "./lib/http.js";

const OUT = path.resolve("data/generated/pr-leads.json");
const TAVILY_KEY = process.env.TAVILY_API_KEY;
const BRAVE_KEY = process.env.BRAVE_API_KEY;
const DVIDS_KEY = process.env.DVIDS_API_KEY;
const KEEP_DAYS = 60;

// States within a T-6 cross-country of the four bases.
const STATES = ["Oklahoma", "Texas", "Kansas", "Arkansas", "Missouri", "Mississippi", "Louisiana", "Alabama", "Colorado", "New Mexico"];

export function webQueries(year) {
  const qs = [];
  for (const st of STATES) {
    qs.push(`"military appreciation" game ${year} ${st}`);
    qs.push(`air show ${year} ${st} "static display"`);
  }
  qs.push(`"T-6" flyover ${year}`);
  qs.push(`"flyover" "military appreciation" ${year} college football`);
  return qs;
}

const limiter = createRateLimiter(1);

async function tavilySearch(query) {
  await limiter();
  const data = await fetchJsonWithRetry("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TAVILY_KEY}` },
    body: JSON.stringify({ query, max_results: 5, time_range: "month" }),
  });
  return (data.results || []).map((r) => ({ title: r.title, url: r.url }));
}

async function braveSearch(query) {
  await limiter();
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pm`;
  const data = await fetchJsonWithRetry(url, { headers: { accept: "application/json", "x-subscription-token": BRAVE_KEY } });
  return (data.web?.results || []).map((r) => ({ title: r.title, url: r.url }));
}

async function dvidsFlyovers() {
  const out = [];
  for (const q of ["T-6 flyover", "T-6 Texan II flyover", "T-6 static display"]) {
    await limiter();
    const url = `https://api.dvidshub.net/search?api_key=${encodeURIComponent(DVIDS_KEY)}&q=${encodeURIComponent(q)}&sort=date&max_results=50`;
    try {
      const data = await fetchJsonWithRetry(url);
      for (const r of data.results || []) {
        out.push({
          title: r.title,
          url: r.url,
          date: (r.date_published || r.publishdate || r.date || "").slice(0, 10) || null,
          unit: r.unit_name || r.unit || null,
          query: q,
        });
      }
    } catch (err) {
      console.warn(`DVIDS "${q}" failed: ${err.message.replace(DVIDS_KEY, "***")}`);
    }
  }
  return out;
}

/** Merge new results into the previous list: dedupe by URL, age out, newest first. */
export function mergeLeads(previous, fresh, now = new Date(), keepDays = KEEP_DAYS) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const byUrl = new Map();
  for (const l of previous || []) if (new Date(l.foundAt) >= cutoff) byUrl.set(l.url, l);
  for (const l of fresh) if (l.url && !byUrl.has(l.url)) byUrl.set(l.url, { ...l, foundAt: now.toISOString() });
  return [...byUrl.values()].sort((a, b) => (a.foundAt < b.foundAt ? 1 : -1));
}

async function main() {
  if (!TAVILY_KEY && !BRAVE_KEY && !DVIDS_KEY) {
    console.log("No TAVILY_API_KEY / BRAVE_API_KEY / DVIDS_API_KEY — skipping PR leads sweep.");
    return;
  }
  const previous = JSON.parse(await readFile(OUT, "utf-8").catch(() => "{}"));
  const year = new Date().getFullYear();
  const result = { updatedAt: new Date().toISOString(), leads: previous.leads || [], flyovers: previous.flyovers || [] };

  const search = TAVILY_KEY ? tavilySearch : BRAVE_KEY ? braveSearch : null;
  if (search) {
    const fresh = [];
    for (const query of [...webQueries(year), ...webQueries(year + 1)]) {
      try {
        for (const r of await search(query)) fresh.push({ ...r, query });
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          console.log(`::warning::Web search key rejected (${err.status}) — check the secret.`);
          break;
        }
        console.warn(`Search "${query}" failed: ${err.message}`);
      }
    }
    result.leads = mergeLeads(previous.leads, fresh);
    console.log(`Web leads: ${fresh.length} results this run (${TAVILY_KEY ? "Tavily" : "Brave"}), ${result.leads.length} in the queue.`);
  }

  if (DVIDS_KEY) {
    const fresh = await dvidsFlyovers();
    result.flyovers = mergeLeads(previous.flyovers, fresh, new Date(), 3650).sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
    console.log(`DVIDS: ${fresh.length} flyover stories this run, ${result.flyovers.length} on file.`);
  }

  await writeFile(OUT, JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.warn(`PR leads sweep skipped: ${err.message}`);
    process.exit(0);
  });
}
