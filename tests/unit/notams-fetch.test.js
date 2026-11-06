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
  const xml = `<soap:Envelope><soap:Body><ns3:FeatureCollection>${filler}${member(2001, "OKC", "RWY 17R/35L CLSD", "!OKC 11/2001 OKC RWY 17R/35L CLSD", "")}${member(2003, "OKC", "RWY 17R/35L CLSD", "!OKC 11/2003 OKC RWY 17R/35L CLSD", "")}${member(2002, "ZZZ", "AD AP CLSD", "!ZZZ 11/2002 ZZZ AD AP CLSD")}</ns3:FeatureCollection></soap:Body></soap:Envelope>`;
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
        assert.equal(out.fields.KOKC.length, 1, "the same closure listed twice is kept once");
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
  const wfs = (m) => m.replace(/aixm:member/g, "wfs:member"); // the live file's wrapper tag
  const xml = `<x>${wfs(filler)}${wfs(member(3001, "PNC", "!PNC 11/3001 PNC AD AP CLSD", "!PNC 11/3001 PNC AD AP CLSD"))}</x>`;
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

test("NMS fetch: no bulk pull within 23 hours of the last one, and none field by field when the bulk pull fails", async () => {
  const dir = fakeData();
  try {
    mkdirSync(path.join(dir, "data/generated/wx"), { recursive: true });
    writeFileSync(path.join(dir, "data/generated/wx/notams.previous.json"), JSON.stringify({ builtAt: new Date(Date.now() - 3 * 3600000).toISOString(), fields: {} }));
    await withNms(
      (req, res) => {
        if (req.url === "/v1/auth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "T", expires_in: "1799" }));
        res.writeHead(500).end("should not be asked");
      },
      async (base, seen) => {
        const { stdout } = await run("node", [SCRIPT], { cwd: dir, env: env(base) });
        assert.match(stdout, /one bulk pull per 24 hours/);
        assert.equal(seen.length, 0, "not even the login");
      }
    );
    // an old file, but the bulk pull is refused: the run fails and asks for no individual fields
    writeFileSync(path.join(dir, "data/generated/wx/notams.previous.json"), JSON.stringify({ builtAt: new Date(Date.now() - 30 * 3600000).toISOString(), fields: {} }));
    await withNms(
      (req, res) => {
        if (req.url === "/v1/auth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "T", expires_in: "1799" }));
        res.writeHead(403).end("no");
      },
      async (base, seen) => {
        await assert.rejects(run("node", [SCRIPT], { cwd: dir, env: env(base) }));
        assert.ok(!seen.some((s) => s.url.includes("location=")), "never loops over fields");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NMS probe: one single-field request, no bulk pull", async () => {
  const dir = fakeData();
  try {
    await withNms(
      (req, res) => {
        if (req.url === "/v1/auth/token") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "T", expires_in: "1799" }));
        if (req.url === "/nmsapi/v1/ping") return res.writeHead(200).end("ok");
        if (req.url === "/nmsapi/v1/notams?location=KOKC") {
          const one = member(5, "OKC", "RWY 17R/35L CLSD", "!OKC 11/5 OKC RWY 17R/35L CLSD").replace(/<\/?aixm:member>/g, "");
          return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "Success", data: { aixm: [one] } }));
        }
        res.writeHead(404).end();
      },
      async (base, seen) => {
        const { stdout } = await run("node", [SCRIPT, "--probe"], { cwd: dir, env: env(base) });
        assert.match(stdout, /1 show-stoppers/);
        assert.ok(!seen.some((s) => s.url.includes("/il/")), "no initial load");
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
