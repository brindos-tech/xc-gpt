#!/usr/bin/env python3
"""Import the Vance Nav Info List PDF into data/curated/navinfo.json.

Run locally whenever 71 OSS/OSOP publishes a new list:

    pip install pdfplumber
    python3 scripts/import-navinfo.py path/to/Nav_Info_List_DD_Mon_YY.pdf

The PDF is one table per page: a state header row, then one row per
airfield (code, name/city, Land, Fuel, RON, Classification, Approval List,
FBO/phone, Suitability, Distance) followed by an optional full-width
comments row. Coordinates are NOT in the PDF; scripts/build-fields.js joins
each code to FAA NASR data for position, runways, hours and fuel.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import pdfplumber

OUT = Path(__file__).resolve().parent.parent / "data" / "curated" / "navinfo.json"
# Codes the published list carries that no longer match FAA data. Applied on
# every import so a re-import keeps the fix; remove an entry once OSS
# corrects it in the PDF. The original code is kept as `listedAs`.
CODE_FIXES = {
    "K01R": "0R1",   # Atmore Municipal
    "KPBI": "KDJT",  # confirmed by the unit, Oct 2026
}
# Some FBO comments in the source were triple-encoded (UTF-8 read as
# cp1252, three times over) before they reached the PDF.
MOJIBAKE = re.compile(r"[ÃÂâ€šƒ¢Å“™¬ž\u0080-\u009f]{2,}")


def clean(s):
    return re.sub(r"[ \t]+", " ", (s or "").replace(" ", " ")).strip()


def fix_text(s):
    if not s or s.isascii():
        return s
    t = s
    for _ in range(3):
        try:
            u = t.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            break
        if u == t:
            break
        t = u
    return MOJIBAKE.sub("–", t)


def parse(pdf_path):
    recs, state = [], None
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    cells = [c for c in row if c not in (None, "")]
                    if not cells or row[0] == "Code":
                        continue
                    first = (row[0] or "").strip()
                    if len(cells) == 1 and first and not row[1] and re.fullmatch(r"[A-Za-z .]{4,}", first):
                        state = clean(first)
                        continue
                    if re.fullmatch(r"[A-Z0-9]{3,4}", first):
                        name_city = (row[1] or "").split("\n")
                        fbo_lines = (row[7] or "").split("\n")
                        phone = next((x for x in fbo_lines if re.search(r"\(\d{3}\)", x)), "")
                        fbo = clean(" ".join(x for x in fbo_lines if x != phone))
                        suit = clean(row[8]).replace("T- ", "T-")
                        dist = (row[9] or "").strip()
                        recs.append({
                            "code": first,
                            "name": clean(" ".join(name_city[:-1])) if len(name_city) > 1 else clean(name_city[0]),
                            "city": clean(name_city[-1]) if len(name_city) > 1 else "",
                            "stateName": state,
                            "land": clean(row[2]),
                            "fuel": clean(row[3]),
                            "ron": clean(row[4]),
                            "classification": clean(row[5]),
                            "approvalList": clean(row[6]),
                            "fbo": "" if fbo == "N/A" else fbo,
                            "fboPhone": clean(phone),
                            "suitability": re.findall(r"T-(?:6|1|38)\b", suit),
                            "distanceFromVanceNm": int(dist) if dist.isdigit() else None,
                            "notes": "",
                        })
                    elif recs and not first and row[1]:
                        recs[-1]["notes"] = (recs[-1]["notes"] + "\n" + row[1]).strip()
    for r in recs:
        r["notes"] = fix_text(r["notes"])
        r["fbo"] = fix_text(r["fbo"])
    return recs


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    pdf_path = Path(sys.argv[1])
    m = re.search(r"(\d{1,2})_([A-Za-z]{3})_(\d{2})", pdf_path.name)
    as_of = datetime.strptime("-".join(m.groups()), "%d-%b-%y").date().isoformat() if m else None
    fields = parse(pdf_path)
    for f in fields:
        if f["code"] in CODE_FIXES:
            f["listedAs"] = f["code"]
            f["code"] = CODE_FIXES[f["code"]]
    OUT.write_text(json.dumps({
        "source": pdf_path.name,
        "asOf": as_of,
        "owner": "71 OSS/OSOP (Vance Airspace)",
        "fields": fields,
    }, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {len(fields)} fields to {OUT} (as of {as_of})")


if __name__ == "__main__":
    main()
