#!/usr/bin/env python3
"""Regenerate index.html (Swagger UI, works from file://) from openapi.yaml — the source of truth.
Usage:  python3 api/v2/embed.py        (needs PyYAML: pip install pyyaml)"""
import json, pathlib, re, yaml
here = pathlib.Path(__file__).parent
spec = yaml.safe_load((here / "openapi.yaml").read_text(encoding="utf-8"))
html = (here / "index.html").read_text(encoding="utf-8")
html = re.sub(r"const SPEC = .*?;\nwindow\.ui", lambda m: "const SPEC = " + json.dumps(spec, ensure_ascii=False) + ";\nwindow.ui", html, flags=re.S)
(here / "index.html").write_text(html, encoding="utf-8")
print("index.html regenerated from openapi.yaml")
