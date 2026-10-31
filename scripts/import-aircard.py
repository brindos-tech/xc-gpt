#!/usr/bin/env python3
"""Import the AIR Card merchant export into data/curated/aircard.json.

The export (one row per merchant per airport, all countries) comes from the
AIR Card merchant locator. Re-export and re-run when it's stale:

    python3 scripts/import-aircard.py path/to/AIR_Card_Merchants_YYYY-MM-DD.csv

Only airports on the Vance Nav Info List (and the four departure bases) are
kept — the page never looks anything else up. Merchant e-mail addresses are
dropped; phone numbers stay (they're what you call before you go).

"DLA Energy Contract" rows are government fuel contract (GFC) merchants;
"Open Market" rows accept the AIR Card without a contract. On-Site means the
merchant fuels at the field; Off-Site merchants arrange delivery.
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAVINFO = ROOT / "data" / "curated" / "navinfo.json"
CONFIG = ROOT / "data" / "curated" / "config.json"
OUT = ROOT / "data" / "curated" / "aircard.json"

# normalise the many spellings of the same product
FUEL_FIXES = [
    (re.compile(r"^jet ?a-?1\b", re.I), "Jet A-1"),
    (re.compile(r"^jet ?a\b", re.I), "Jet A"),
    (re.compile(r"^av ?gas\b", re.I), "Avgas"),
]


def fuels(cell):
    out = []
    for raw in cell.split(";"):
        x = raw.strip()
        if not x or x.lower().startswith("contact fbo"):
            continue
        for rx, name in FUEL_FIXES:
            if rx.match(x):
                suffix = re.sub(rx, "", x).strip(" -")
                x = name + (f" {suffix.lower()}" if suffix else "")
                break
        if x not in out:
            out.append(x)
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    m = re.search(r"(\d{4}-\d{2}-\d{2})", src.name)
    wanted = {f["code"] for f in json.loads(NAVINFO.read_text())["fields"]}
    wanted |= {o["icao"] for o in json.loads(CONFIG.read_text())["origins"]}
    by = {}
    seen = set()
    with open(src, encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        updated_col = next(c for c in reader.fieldnames if c.startswith("Last Updated"))
        for r in reader:
            icao = r["ICAO"].strip()
            if icao not in wanted:
                continue
            key = (icao, r["Merchant"].strip().lower(), r["Contract Status"])
            if key in seen:
                continue
            seen.add(key)
            by.setdefault(icao, []).append({
                "merchant": r["Merchant"].strip(),
                "contract": r["Contract Status"] == "DLA Energy Contract",
                "onSite": r["On-Site / Off-Site"] == "On-Site",
                "type": r["Merchant Type"].strip() or None,
                "fuels": fuels(r["Fuels"]),
                "phone": r["Phone"].strip() or None,
                "activity": None if r["Recent Activity"].startswith("n/a") else (r["Recent Activity"].strip() or None),
                "updated": r[updated_col].strip() or None,
            })
    # on-site and contract merchants first
    for rows in by.values():
        rows.sort(key=lambda x: (not x["contract"], not x["onSite"], x["merchant"].lower()))
    OUT.write_text(json.dumps({"exportDate": m.group(1) if m else None, "source": src.name, "airports": by}, indent=1, ensure_ascii=False) + "\n")
    contract = sum(1 for v in by.values() if any(x["contract"] for x in v))
    print(f"Wrote {len(by)} airports ({contract} with a DLA contract merchant) to {OUT}")


if __name__ == "__main__":
    main()
