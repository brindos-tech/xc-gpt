import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const SCRIPT = path.resolve("scripts/fetch-notams.js");

const member = (n, location, text, simple, extra = "") =>
  `<aixm:member><AIXMBasicMessage><hasMember><event:Event><event:timeSlice><event:EventTimeSlice><event:textNOTAM><event:NOTAM><event:number>${n}</event:number><event:year>2026</event:year><event:type>N</event:type><event:location>${location}</event:location><event:effectiveStart>202611010000</event:effectiveStart><event:effectiveEnd>202612010000</event:effectiveEnd><event:text>${text}</event:text><event:translation><event:NOTAMTranslation><event:type>LOCAL_FORMAT</event:type><event:simpleText>${simple}</event:simpleText></event:NOTAMTranslation></event:translation></event:NOTAM></event:textNOTAM><event:extension><fnse:EventExtension><fnse:classification>DOM</fnse:classification>${extra}</fnse:EventExtension></event:extension></event:EventTimeSlice></event:timeSlice></event:Event></hasMember></AIXMBasicMessage></aixm:member>`;

function fakeData() {
  const dir = mkdtempSync(path.join(tmpdir(), "notams-"));
  mkdirSync(path.join(dir, "data/curated"), { recursive: true });
  mkdirSync(path.join(dir, "data/generated"), { recursive: true });
  writeFileSync(path.join(dir, "data/curated/navinfo.json"), JSON.stringify({ fields: [{ code: "KOKC" }, { code: "KPNC" }] }));
  writeFileSync(path.join(dir, "data/curated/config.json"), JSON.stringify({ origins: [{ icao: "KEND" }] }));
  writeFileSync(path.join(dir, "data/generated/field-facts.json"), JSON.stringify({ facts: { KOKC: { faaId: "OKC" }, KPNC: { faaId: "PNC" } } }));
  return dir;
}

async function withNms(handler, fn) {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || "", format: req.headers.nmsresponseformat || "" });
    handler(req, res, srv.address().port);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`, seen);
  } finally {
    srv.close();
  }
}

const env = (base) => ({ ...process.env, FAA_NMS_CLIENT_ID: "my-client-id", FAA_NMS_CLIENT_SECRET: "my-secret-value", FAA_NMS_BASE: base, FAA_NMS_AUTH_URL: `${base}/v1/auth/token` });

test("NMS fetch: token, initial load via the signed link, only our closures are kept", async () => {
  // 1,200 NOTAMs of no interest, plus a closed runway at KOKC (FAA id OKC) and an unrelated airport's closure
  const filler = Array.from({ length: 1200 }, (_, i) => member(i + 1, `X${i}`, "OBST CRANE 100FT", `!XXX 11/${i} X${i} OBST CRANE 100FT`)).join("\n");
  const xml = `<soap:Envelope><soap:Body><ns3:FeatureCollection>${filler}${member(2001, "OKC", "RWY 17R/35L CLSD", "!OKC 11/2001 OKC RWY 17R/35L CLSD", "")}${member(2002, "ZZZ", "AD AP CLSD", "!ZZZ 11/2002 ZZZ AD AP CLSD")}</ns3:FeatureCollection></soap:Body></soap:Envelope>`;
  const dir = fakeData();
  const storageSeen = [];
  const storage = createServer((req, res) => {
    storageSeen.push({ url: req.url, auth: req.headers.authorization || "" });
    res.writeHead(200).end(gzipSync(xml));
  });
  await new Promise((r) => storage.listen(0, "127.0.0.1", r));
  try {
    await withNms(
      (req, res) => {
        if (req.url === "/v1/auth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "TOKEN123", expires_in: "1799", status: "approved" }));
        if (req.url === "/nmsapi/v1/notams/il/DOMESTIC") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "Success", data: { url: `http://127.0.0.1:${storage.address().port}/signed/file.gz?sig=abc` } }));
        res.writeHead(404).end();
      },
      async (base, seen) => {
        const { stdout } = await run("node", [SCRIPT], { cwd: dir, env: env(base) });
        const out = JSON.parse(readFileSync(path.join(dir, "data/generated/wx/notams.json"), "utf-8"));
        assert.deepEqual(Object.keys(out.fields), ["KOKC"], "only our field's closure");
        assert.equal(out.fields.KOKC[0].kind, "Runway closed");
        assert.equal(out.fields.KOKC[0].number, "11/2001");
        assert.deepEqual(out.checked, ["KEND", "KOKC", "KPNC"], "every field was read, so those with none are clear");
        assert.equal(out.source, "NOTAM distribution service", "not labelled as FAA data");
        // how it talked to the service
        const auth = seen.find((s) => s.url === "/v1/auth/token");
        assert.equal(auth.auth, `Basic ${Buffer.from("my-client-id:my-secret-value").toString("base64")}`);
        assert.equal(seen.find((s) => s.url === "/nmsapi/v1/notams/il/DOMESTIC").auth, "Bearer TOKEN123");
        assert.equal(storageSeen[0].auth, "", "the signed link gets no Authorization header");
        // nothing secret in the log
        assert.ok(!stdout.includes("TOKEN123") && !stdout.includes("my-secret-value") && !stdout.includes("sig=abc"));
      }
    );
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NMS fetch: a relative download link on the NMS host (as the staging service sends) is followed with the token", async () => {
  const filler = Array.from({ length: 1200 }, (_, i) => member(i + 1, `X${i}`, "OBST CRANE 100FT", `!XXX 11/${i} X${i} OBST CRANE 100FT`)).join("\n");
  const xml = `<x>${filler}${member(3001, "PNC", "AD AP CLSD", "!PNC 11/3001 PNC AD AP CLSD")}</x>`;
  const dir = fakeData();
  try {
    await withNms(
      (req, res) => {
        if (req.url === "/v1/auth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "T2", expires_in: "1799" }));
        if (req.url === "/nmsapi/v1/notams/il/DOMESTIC") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { url: "/nmsapi/v1/content/abc123" } }));
        if (req.url === "/nmsapi/v1/content/abc123") return res.writeHead(200, { "content-type": "application/gzip" }).end(gzipSync(xml));
        res.writeHead(404).end();
      },
      async (base, seen) => {
        await run("node", [SCRIPT], { cwd: dir, env: env(base) });
        const out = JSON.parse(readFileSync(path.join(dir, "data/generated/wx/notams.json"), "utf-8"));
        assert.deepEqual(Object.keys(out.fields), ["KPNC"]);
        assert.equal(seen.find((s) => s.url === "/nmsapi/v1/content/abc123").auth, "Bearer T2");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NMS fetch: without initial-load access it asks field by field", async () => {
  const dir = fakeData();
  try {
    await withNms(
      (req, res) => {
        if (req.url === "/v1/auth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "T", expires_in: "1799" }));
        if (req.url.startsWith("/nmsapi/v1/notams/il/")) return res.writeHead(403).end("no");
        if (req.url === "/nmsapi/v1/notams?location=KOKC") return res.writeHead(200).end(`<x>${member(5, "OKC", "AD AP CLSD", "!OKC 11/5 OKC AD AP CLSD")}</x>`);
        if (req.url.startsWith("/nmsapi/v1/notams?location=")) return res.writeHead(404).end(); // nothing there
        res.writeHead(404).end();
      },
      async (base, seen) => {
        await run("node", [SCRIPT], { cwd: dir, env: env(base) });
        const out = JSON.parse(readFileSync(path.join(dir, "data/generated/wx/notams.json"), "utf-8"));
        assert.deepEqual(Object.keys(out.fields), ["KOKC"]);
        assert.equal(out.fields.KOKC[0].kind, "Airport closed");
        assert.deepEqual(out.checked, ["KEND", "KOKC", "KPNC"]);
        assert.equal(seen.find((s) => s.url.includes("location=KOKC")).format, "AIXM", "asks for AIXM");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NMS fetch: refused credentials fail the run and say so without echoing the secret", async () => {
  const dir = fakeData();
  try {
    await withNms(
      (req, res) => res.writeHead(401).end("bad"),
      async (base) => {
        await assert.rejects(run("node", [SCRIPT], { cwd: dir, env: env(base) }), (err) => /refused the client id\/secret/.test(err.stderr) && !err.stderr.includes("my-secret-value"));
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
