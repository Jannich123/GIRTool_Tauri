# Generates the CPT oracle fixtures (Q-E6, option 3).
#
# Runs the UNMODIFIED reference pipeline from docs/cpt_reference/cpt_calc.py on
# a deterministic synthetic dataset and dumps the result as tab-separated
# fixtures the Rust test (src-tauri/src/commands/cpt.rs::tests) diffs against.
#
# The only source patches applied are environmental, not semantic:
#   * drop unused heavy imports (sqlalchemy, pyodbc, pyproj, subprocess, tqdm)
#   * pandas-3 API renames: fillna(method=...) -> bfill()/ffill(), and the two
#     chained assignments -> .loc form (chained assignment is a no-op under
#     pandas-3 copy-on-write; the .loc form is what pandas-1 effectively did)
#
# Run:  python scripts/gen_cpt_fixture.py
import math
import os
import re
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, "docs", "cpt_reference")
OUT = os.path.join(REF, "fixtures")
os.makedirs(OUT, exist_ok=True)

# ── Load + patch the oracle source ────────────────────────────────────────────
src = open(os.path.join(REF, "cpt_calc.py"), encoding="utf-8").read()
src = src.replace("import sqlalchemy as sa", "")
src = src.replace("import pyodbc", "")
src = src.replace("import pyproj", "")
src = src.replace("import subprocess", "")
src = src.replace("from tqdm import tqdm", "")
src = src.replace(
    ".replace({0: pd.NA}).fillna(method='bfill').fillna(method='ffill')",
    ".replace({0: pd.NA}).bfill().ffill()",
)
src = src.replace(
    "CPTData['UW_eff'][CPTData['UW_eff']<0] = 0",
    "CPTData.loc[CPTData['UW_eff']<0, 'UW_eff'] = 0",
)
src = src.replace(
    "CPTData['Qt_n'][CPTData['Qt_n']<0] = 0",
    "CPTData.loc[CPTData['Qt_n']<0, 'Qt_n'] = 0",
)


class _Tqdm:  # progress-bar stub
    def __init__(self, *a, **k):
        pass

    def set_description(self, *a, **k):
        pass

    def update(self, *a, **k):
        pass

    def close(self):
        pass


ns = {"tqdm": _Tqdm, "np": np, "pd": pd, "__file__": os.path.join(REF, "cpt_calc.py")}
exec(compile(src, "cpt_calc.py", "exec"), ns)
CPT_Calc = ns["CPT_Calc"]

# ── Deterministic synthetic dataset ───────────────────────────────────────────
rows = []


def add_row(pn, tid, pid, layer, depth, level, qc, u2, fs):
    rows.append(
        dict(PointNo=pn, TestId=tid, PointId=pid, **{"Primary Layer": layer},
             Depth=depth, Level=level, qc=qc, u2=u2, fs=fs)
    )


# Borehole 1: surface at 0 m, includes a depth-0 first row and a negative-qt row.
for i in range(30):
    depth = round(0.10 * i, 4)
    level = round(-depth, 4)
    layer = "ler" if (i < 10 or i >= 20) else "sand"
    qc = round(1.5 + 0.8 * math.sin(i / 4.0) + 0.3 * depth, 6)
    u2 = round(50.0 + 9.0 * depth, 6)
    fs = round(20.0 + 5.0 * math.cos(i / 3.0) + 2.0 * depth, 6)
    if i == 17:  # force qt <= 0 once (Rf / UW filter paths)
        qc, u2 = -0.5, -200.0
    add_row("CPT-1", "T1", "P1", layer, depth, level, qc, u2, fs)

# Borehole 2: ground/seabed level override (GSB = 0.2), water level above terrain.
for i in range(25):
    depth = round(0.08 * (i + 1), 4)
    level = round(0.2 - depth, 4)
    layer = "sand" if i % 3 else "ler"
    qc = round(3.0 + 1.1 * math.cos(i / 5.0) + 0.25 * depth, 6)
    u2 = round(30.0 + 7.5 * depth, 6)
    fs = round(35.0 + 4.0 * math.sin(i / 2.0), 6)
    add_row("CPT-2", "T2", "P2", layer, depth, level, qc, u2, fs)

df_in = pd.DataFrame(rows)
df_in.to_csv(os.path.join(OUT, "cpt_input.csv"), sep="\t", index=False)

# ── Parameters (mirrored EXACTLY in the Rust test) ────────────────────────────
net_area_ratio = {"CPT-1": 0.8, "CPT-2": 0.75}
water = {"CPT-1": -1.0, "CPT-2": 0.5}
gsb = {"CPT-2": 0.2}
gamma_soil = {"ler": 19.0}
nkt_values = {"ler": 12.0}

for method, fname in [
    ("Mayne and Peuchen (2022)", "expected_mayne.csv"),
    ("Robertson (2012)", "expected_robertson.csv"),
]:
    out = CPT_Calc(
        pd.DataFrame(rows).copy(),
        REF,
        net_area_ratio,
        water,
        nkt_values,
        gamma_soil,
        γ_water=None,
        GSBLevel=gsb,
        Nkt_method=method,
        round_col={},
    )
    out.to_csv(os.path.join(OUT, fname), sep="\t", index=False)
    print(f"{fname}: {len(out)} rows, {len(out.columns)} columns")

print("fixtures written to", OUT)
