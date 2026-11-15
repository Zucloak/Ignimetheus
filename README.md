<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/ignimetheus_dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="public/assets/ignimetheus_light.svg" />
    <img src="public/assets/ignimetheus.svg" alt="Ignimetheus — Flame in Freefall" width="180" height="180" />
  </picture>
</p>

# Ignimetheus

### Reduced-order flame-spread screening and teaching tool

**Ignimetheus** is a browser-based, reduced-order 1D spacecraft microgravity combustion screening and teaching tool. It pairs an interactive HTML5 Canvas flow-duct simulation with `0g` vs. `1g` flammability envelope comparisons, modeled active and passive suppression levers, NASA Saffire / BASS-II / FLEX / NASA-STD-6001 reference scenario matching, and a client-side local WebGPU Telemetry Assistant backed by deterministic replies and unit-aware numeric checking.

---

## 1. Key Capabilities

- **HTML5 Canvas Duct & Flame Simulation (`src/components/SimulationStage.tsx`, `src/components/CombustionDuctCanvas.tsx`)**:
  - Interactive canvas rendering of velocity streamlines, vector arrows, heat-flux shading, a 6-point thermocouple array (`TC-1` through `TC-6`), interactive CAD spatial probes (`P-n`) and calipers (`D-n`), and a toggleable `1g` buoyant plume silhouette overlay. The flow field visualization is illustrative (analytic), not a computed flow field.
  - Supports `msg-12cm` (`12 cm` Microgravity Science Glovebox duct, `Dh = 120 mm`) and `saffire-40cm` (`40 cm` Cygnus Saffire flow duct, `Dh = 400 mm`, `0.88x` wall-loss spread scaling) confinement scales across `rod`, `sheet`, `channel`, and `droplet` specimen geometries.
- **Reduced-Order 1D Thermo-Fluids Engine (`src/engine/thermoCore.ts`)**:
  - Evaluates effective velocity $U_{\mathrm{eff}} = \sqrt{U_{\mathrm{flow}}^2 + U_{\mathrm{buoy}}^2}$, oxygen-enriched exploration atmospheres (e.g., `34% O₂` at `56.5 kPa`), quiescent radiative quenching (`0 cm/s` in `0g`), high-flow convective blow-off (`Da* < 1.00`), and a two-sided thin-sheet radiative-loss shift for charring/ash-forming fabrics (`nomex`, `silicone`).
- **`0g` vs. `1g` Flammability Envelopes**:
  - Tracks pressure- and flow-adjusted effective Limiting Oxygen Index (`LOI_eff`), `LOI` margin, Extinction-Proximity Index (`Da*`, an algebraic index derived from solver LOI margin and flow strain rather than independent Arrhenius kinetics), and `NASA-STD-6001` `152 mm` burn-length comparisons across `STANDBY`, `IGNITING` (`80 W` hot-wire pulse over `3.5 s`), `SUSTAINED_BURN`, and `SELF_EXTINGUISHED` states. Simulation runs in this app represent `0g` or duct test conditions, not the `NASA-STD-6001` Test 1 upward-burn configuration.
- **Modeled Suppression Levers (model assumptions, not NASA data)**:
  - Models upstream **Wake Baffle** (`0.72x` root flow factor at `95 mm`, raising the nominal blow-off velocity limit from `38 cm/s` to `48 cm/s`), **Flame Arrestor Mesh** (`280 mm` burn clamp up to `32.0% O₂`, overwhelmed above `32.0% O₂`), and **Pulse N₂ Suppression** (`-8.0% O₂` transient for `5.0 s` at `160 mm`).

---

## 2. Calibration and Reference Scenarios (`src/data/nasaPsiExperiments.json`)

Six Cygnus Saffire microgravity concurrent-flow records (`SAFFIRE-I-01`, `SAFFIRE-II-05`, `SAFFIRE-II-06`, `SAFFIRE-III-01`, `SAFFIRE-II-07`, `SAFFIRE-II-01`) use published summary conditions and measurements from **Urban et al., ASGSR 2017 (NASA NTRS 20180005168, Table 1, pp. 30–31)** alongside adapted `BASS-II`, `FLEX`, and `NASA-STD-6001` reference scenarios. Within the Saffire records, `CONCURRENT_THIN_SHEET_SPREAD_FACTOR` (`0.07756`; `0.07756 * 0.88 = 0.06825` in the `40 cm` Saffire duct) is fitted to the two `20 cm/s` cotton-fiberglass (SIBAL) runs (`SAFFIRE-I-01` and `SAFFIRE-II-05`) and evaluated on the two `25 cm/s` SIBAL runs (`SAFFIRE-II-06` and `SAFFIRE-III-01`):

| Record ID | Role | Material (`specimenGeometry`, `ductScale`) | Conditions (`0g`) | Published / Ref `V_f` (`mm/s`) | Simulated `V_f` (`mm/s`) | Relative Error / Match |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **`SAFFIRE-I-01`** | Fitted | `cellulose` (`sheet`, `saffire-40cm`) | `21.6% O₂, 101.3 kPa, 20 cm/s` concurrent | `1.80` | `1.888` | `+4.9%` (`+4.89%`) |
| **`SAFFIRE-II-05`** | Fitted | `cellulose` (`sheet`, `saffire-40cm`) | `22.1% O₂, 101.3 kPa, 20 cm/s` concurrent | `2.10` | `2.017` | `-3.9%` (`-3.94%`) |
| **`SAFFIRE-II-06`** | Held-out | `cellulose` (`sheet`, `saffire-40cm`) | `22.1% O₂, 101.3 kPa, 25 cm/s` concurrent | `2.60` | `2.296` | `-11.7%` (`-11.69%`) |
| **`SAFFIRE-III-01`** | Held-out | `cellulose` (`sheet`, `saffire-40cm`) | `21.1% O₂, 101.3 kPa, 25 cm/s` concurrent | `2.30` | `2.005` | `-12.8%` (`-12.83%`) |
| **`SAFFIRE-II-07`** | Extinction check (calibration-informed) | `nomex` (`sheet`, `saffire-40cm`) | `22.1% O₂, 101.3 kPa, 20 cm/s` concurrent | `0.00` | `0.000` | Outcome matches (no sustained spread; LOI margin `-1.4%`) |
| **`SAFFIRE-II-01`** | Extinction check (calibration-informed) | `silicone` (`sheet`, `saffire-40cm`) | `22.1% O₂, 101.3 kPa, 20 cm/s` concurrent | `0.00` | `0.000` | Outcome matches (no sustained spread; LOI margin `-0.8%`) |
| **`BASS-II-14`** | Adapted Reference (unverified) | `pmma` (`rod`, `msg-12cm`) | `21.0% O₂, 101.3 kPa, 15 cm/s` opposed | `1.22` | `1.824` | Excluded from headline error metrics (`+49.5%` / `+49.48%` vs. unverified adapted value) |

- **Radiative-loss term note**: `src/engine/thermoCore.ts` applies `thinSheetCharRadiativePenalty` (`+2.2%` to `+4.2%` LOI shift on charring thin sheets: `+2.2%` for `nomex`, `+4.2%` for `silicone`). Because git history is unavailable in this workspace (`.git` absent), it cannot be determined from history whether that term was introduced before or after `SAFFIRE-II-07` and `SAFFIRE-II-01` were first checked; those two rows are therefore labeled `Extinction check (calibration-informed)`.
- **Duct scale and specimen width handling**: `sampleWidthMm` in `src/data/nasaPsiExperiments.json` (`406 mm` for `SAFFIRE-I-01` and `SAFFIRE-III-01`; `50 mm` for `SAFFIRE-II-05`, `SAFFIRE-II-06`, `SAFFIRE-II-07`, and `SAFFIRE-II-01`) is metadata only and is not read by `computeThermoTelemetry`; all six `SAFFIRE-*` rows use `ductScale: 'saffire-40cm'` (`Dh = 0.40 m`, `0.88x` wall-loss spread scaling), while `BASS-II-14` uses `ductScale: 'msg-12cm'` (`Dh = 0.12 m`, `1.0x` scaling) with `Adapted Reference (unverified)` values (excluded from headline error metrics).
- **4-Fold Leave-One-Out Cross-Validation (LOOCV, `n = 4`)**: Across the four cotton-fiberglass (SIBAL) Saffire runs (`SAFFIRE-I-01`, `SAFFIRE-II-05`, `SAFFIRE-II-06`, `SAFFIRE-III-01`), least-squares refitting of the scalar thin-sheet spread factor on each 3-run fold produces held-out absolute errors from `4.46%` (`SAFFIRE-II-05`) to `16.33%` (`SAFFIRE-I-01`), with `SAFFIRE-II-06` at `7.20%` and `SAFFIRE-III-01` at `8.11%` (MAPE = `9.02%`). Unlike the `2`-fit / `2`-held-out split (which calibrates once on the `20 cm/s` runs and extrapolates to `25 cm/s`), 4-fold LOOCV refits on `3` runs at a time across both flow speeds, so each fold evaluates interpolation or extrapolation from a different training subset.

---

## 3. Local Telemetry Assistant

The onboard Telemetry Assistant (`src/hooks/useSafetyOfficerLLM.ts`, `src/engine/safetyAdvisor.ts`, `src/utils/hardwareProfiler.ts`, `src/workers/webllm.worker.ts`) executes 100% client-side in the browser with zero cloud inference calls:

1. **Device-Adaptive Hardware Tiering & URL Overrides**:
   Append `?tier=constrained`, `?tier=balanced`, or `?tier=performance` to override device probing:
   - `?tier=constrained` (default when WebGPU is unavailable, on mobile user agents, `deviceMemory <= 2 GB`, or `maxStorageBufferBindingSize < 128 MB`): Disables WebLLM loading (`allowWebLlm: false`, `contextWindowSize: 1024`, `maxTokens: 140`, `systemPromptBudget: 'compact'`) and runs strictly in deterministic mode.
   - `?tier=balanced` (default when `deviceMemory <= 8 GB`, `maxStorageBufferBindingSize < 1 GB`, or `hardwareConcurrency <= 4`): Defaults to `Qwen3-0.6B-q4f16_1-MLC` (falling back to `q4f32_1` without `shader-f16`, or `Qwen2.5-0.5B-Instruct` / `Qwen2.5-1.5B-Instruct` if missing), `context_window_size: 1536`, `max_tokens: 320`, `systemPromptBudget: 'standard'`, with 1-token shader warmup.
   - `?tier=performance` (higher-headroom desktops): Defaults to `Qwen3-0.6B` (`q4f16_1` / `q4f32_1`), `context_window_size: 2048`, `max_tokens: 320`, `systemPromptBudget: 'full'`, with 1-token shader warmup. Desktop users can also manually choose `Qwen2.5-1.5B-Instruct` (`q4f16_1` / `q4f32_1`) from the composer backend menu.
   - **Sampling parameters (`getGenerationParamsForModel`)**: `Qwen3-0.6B` runs on both `balanced` and `performance` with `temperature: 0.6`, `top_p: 0.95`, `top_k: 20`, `max_tokens: 320`, and `enableThinking: true`; `Qwen2.5-1.5B-Instruct` uses `temperature: 0.15`, `top_p: 0.9`, `max_tokens: 320`, and `enableThinking: false`.
2. **Pre-LLM Intent Router (`classifyIntent`)**:
   Every prompt is classified before any model call into `INJECTION`, `AUTHORITY`, `OUT_OF_SCOPE`, `SMALLTALK`, `ABOUT`, `GLOSSARY`, `COMPARE_0G_1G`, `WHAT_IF`, `VALUES`, `EXPLAIN`, or `UNKNOWN`. Only `EXPLAIN` prompts (excluding pre-ignition `STANDBY` quench queries) invoke the local WebGPU model; all other intents are resolved deterministically or refused without calling the LLM.
3. **Output Guardrails, Numeric Audit, and Badges**:
   - Before displaying an LLM reply (`evaluateAuditedReasoningResponse`), the assistant isolates `<think>...</think>` blocks and checks the final answer for prompt-framing leakage, forbidden authority/safety/certification terms, truncation, bulleted telemetry dumps, and numeric values matched by physical-unit family against the live telemetry snapshot (bare numbers without units are rejected). Failures fall back to a deterministic reply with a visible audit note.
   - The audit checks that figures match the live snapshot; it cannot check every qualitative statement.
   - `<think>` traces from `Qwen3-0.6B` are parsed into the collapsible `ThoughtLine` accordion shown to the user above the response; the numeric and authority audits cover only the final answer and do not audit numbers inside `<think>` traces.
   - Response badges indicate provenance: `Deterministic`, `Local model (figures checked)`, `Not modeled`, and `Info`.

---

## 4. Limitations

- **Not validated for spacecraft design or certification**: Ignimetheus is a reduced-order screening and teaching tool, not validated for flight hardware qualification, crew safety decisions, or `NASA-STD-6001` compliance.
- **Reduced-order steady physics**: Uses steady-state 1D algebraic correlations with first-order thermocouple lag and linear burn-length integration rather than transient CFD or multi-step chemical kinetics; `Da*` is an algebraic index derived from LOI margin and flow strain.
- **Illustrative flow rendering**: Streamlines, velocity arrows, and flame plume shapes on the canvas are analytic illustrations, not a computed flow field.
- **Modeled hardware assumptions**: Wake Baffle (`0.72x` root flow factor at `95 mm`), Flame Arrestor Mesh (`280 mm` clamp, `32.0% O₂` limit), Pulse N₂ (`-8.0% O₂` for `5.0 s`), and the `80 W` / `3.5 s` igniter pulse are model assumptions, not NASA test data.
- **Unmodeled sample width & radiative history**: `sampleWidthMm` (`50 mm` vs. `406 mm`) is not an input to `computeThermoTelemetry`. `thinSheetCharRadiativePenalty` (`+2.2%` to `+4.2%` LOI shift) is calibration-informed on `SAFFIRE-II-07` / `SAFFIRE-II-01`, and git history is absent here to verify when it was added.
- **Unmodeled hazards**: Toxic species (`CO`, `HCN`, `HCl`, `HF`), soot/smoke transport and obscuration, cabin depressurization timelines, electrical arc ignition energy (`mJ`), bulk cabin air heating, and future multi-minute flame spread are not modeled.
- **Dataset & assistant limits**: For `BASS-II` (`PSI-25`), the DOI (`https://doi.org/10.60555/4qc4-de67` -> `PSI-25` Version 4) and `CC0-1.0` license are verified, whereas `BASS-II-14`'s observed PMMA rod values (`1.22 mm/s` and `112 mm` at `21% O₂, 15 cm/s` opposed flow) were NOT FOUND across `NASA/TM-20210011385` (Section 4.1 Figs. 4.1–4.3 pp. 49–51 & Table A.3 pp. 106–107), `PSI-25_Experimental table_BASS-II.csv`, and `BASS-II Test Matrix by PI Final.xlsx` (neither tabular dataset contains spread-rate or burn-length columns; opposed-flow PMMA rods had `57.15 mm` initial length, were tested at `<= 5 cm/s` near `21% O₂` in `P13a/P13b/P22a/P22b/P25`, and spread at `~0.04–0.08 mm/s` rather than `1.22 mm/s` / `112 mm`) and are kept as `Adapted Reference (unverified)` (excluded from headline error metrics). Other non-Saffire dataset records remain unverified (`pending_verification`) with assumed or synthetic fields, and `PSI-98`, `PSI-99`, `PSI-100`, and `PSI-69` identifiers remain `(pending verification)`; `FLEX` droplet surrogates are excluded from solid-fuel matching. Numeric auditing does not inspect `<think>` traces or every qualitative statement.

---

## 5. Provenance (`src/data/nasaPsiExperiments.json`)

| Record ID | Source | Status | PSI ID / DOI Status |
| :--- | :--- | :--- | :--- |
| **`SAFFIRE-I-01`** | Urban et al. 2017 (NASA NTRS 20180005168, Table 1) | `in_scope_solid`; summary verified in NTRS (`O₂` midpoint, `101.3 kPa` & igniter `W` assumed) | `PSI-98` / `10.60555/0t15-1z43` (pending verification) |
| **`SAFFIRE-II-05`** | Urban et al. 2017 (NASA NTRS 20180005168, Table 1) | `in_scope_solid`; summary verified in NTRS (`O₂` midpoint, `101.3 kPa` & igniter `W` assumed) | `PSI-99` / `10.60555/2chp-m469` (pending verification) |
| **`SAFFIRE-II-06`** | Urban et al. 2017 (NASA NTRS 20180005168, Table 1) | `in_scope_solid`; summary verified in NTRS (`O₂` midpoint, `101.3 kPa` & igniter `W` assumed) | `PSI-99` / `10.60555/2chp-m469` (pending verification) |
| **`SAFFIRE-III-01`** | Urban et al. 2017 (NASA NTRS 20180005168, Table 1) | `in_scope_solid`; summary verified in NTRS (`O₂` midpoint, `101.3 kPa` & igniter `W` assumed) | `PSI-100` / `10.60555/2chp-m469` (pending verification) |
| **`SAFFIRE-II-07`** | Urban et al. 2017 (NASA NTRS 20180005168, Table 1) | `in_scope_solid`; summary verified in NTRS (`O₂` midpoint, `101.3 kPa`, thickness & igniter `W` assumed) | `PSI-99` / `10.60555/2chp-m469` (pending verification) |
| **`SAFFIRE-II-01`** | Urban et al. 2017 (NASA NTRS 20180005168, Table 1) | `in_scope_solid`; summary verified in NTRS (`O₂` midpoint, `101.3 kPa` & igniter `W` assumed) | `PSI-99` / `10.60555/2chp-m469` (pending verification) |
| **`BASS-II-14`** | Adapted Reference (unverified) (`PSI-25` Version 4; checked vs. `NASA/TM-20210011385`, `PSI-25_Experimental table_BASS-II.csv`, and `BASS-II Test Matrix by PI Final.xlsx`) | `in_scope_solid`; `Adapted Reference (unverified)` (identifier/license `verified`; observed `1.22 mm/s` & `112 mm` at `21% O₂, 15 cm/s` opposed flow `adapted/unverified` — not found in `NASA/TM-20210011385` or `PSI-25` tables, where `57.15 mm` PMMA rods at `<= 5 cm/s` in `P13a/P13b/P22a/P22b/P25` spread at `~0.04–0.08 mm/s`) | `PSI-25` / `10.60555/4qc4-de67` (`PSI-25` Version 4, `CC0-1.0`) |
| **`BASS-II-22`** | Adapted reference (`psi.nasa.gov`, BASS-II) | `in_scope_solid`; `pending_verification` (conditions & spread assumed) | `PSI-25` / `10.60555/4qc4-de67` (`PSI-25` Version 4, `CC0-1.0`) |
| **`BASS-II-31`** | Adapted reference (`psi.nasa.gov`, BASS-II) | `in_scope_solid`; `pending_verification` (conditions & spread assumed) | `PSI-25` / `10.60555/4qc4-de67` (`PSI-25` Version 4, `CC0-1.0`) |
| **`BASS-II-52`** | Adapted reference (`psi.nasa.gov`, BASS-II) | `in_scope_solid`; `pending_verification` (conditions assumed, spread derived) | `PSI-25` / `10.60555/4qc4-de67` (`PSI-25` Version 4, `CC0-1.0`) |
| **`BASS-II-45`** | Adapted exploration atmosphere (`psi.nasa.gov`, BASS-II) | `out_of_scope`; `pending_verification` (synthetic `34% O₂ / 56.5 kPa` scenario) | `PSI-25` / `10.60555/4qc4-de67` (`PSI-25` Version 4, `CC0-1.0`) |
| **`FLEX-09`** | ISS CIR FLEX droplet surrogate (`psi.nasa.gov`) | `out_of_scope` for solid-fuel validation (liquid droplet mapped to cellulose surrogate; synthetic fields) | `PSI-69` / `10.60555/mbq8-0451` (pending verification) |
| **`FLEX-18`** | ISS CIR FLEX droplet surrogate (`psi.nasa.gov`) | `out_of_scope` for solid-fuel validation (synthetic elevated-`O₂` silicone surrogate) | `PSI-69` / `10.60555/mbq8-0451` (pending verification) |
| **`STD-6001-1G-NOMEX`** | `NASA-STD-6001B` Test 1 criterion | `out_of_scope`; `pending_verification` (`<= 152 mm` `1g` screening criterion, illustrative `31 mm` char, no spread rate) | `NASA-STD-6001B` · Ref `PSI-99` / `10.60555/2chp-m469` (pending verification) |
| **`STD-6001-1G-PMMA`** | `NASA-STD-6001B` Test 1 criterion | `out_of_scope`; `pending_verification` (`> 152 mm` `1g` failure example, illustrative `240 mm` char, no spread rate) | `NASA-STD-6001B` · Ref `PSI-25` / `10.60555/4qc4-de67` (`PSI-25` Version 4, `CC0-1.0`) |

---

## 6. Demo and Screenshots

- **Live Demo**: `[DEMO_URL]`
- **Screenshots**: `[SCREENSHOTS]`
- **Offline Usage**: Local model weights download once; load online first, then it works offline.

---

## 7. Local Setup & Verification

```bash
# Install dependencies
npm install

# Start the local development server on http://localhost:3000
npm run dev

# Override hardware tier in the browser if desired
# http://localhost:3000/?tier=constrained
# http://localhost:3000/?tier=balanced
# http://localhost:3000/?tier=performance

# Run the unit test suite (thermoCore, units, ductProbes, safetyAdvisor, hardwareProfiler, toastQueue, inferenceBackend)
npm test

# Type-check with TypeScript
npm run lint

# Build offline-ready production bundle (dist/ + PWA service worker)
npm run build
```

### Reproduce the comparison table

- `TBD: add npm run validate` (currently `npm test` runs `thermoCore.test.ts` assertions against the Saffire benchmarks without printing the comparison or LOOCV tables).

---

## 8. AI Assistance and Data Disclosure

[AI_DISCLOSURE_TEXT]

---

## 9. License & Data Attribution

- **Source Code**: Licensed under the [Apache License, Version 2.0](./LICENSE) (`Apache-2.0`).
- **Dataset Metadata License**: `CC0-1.0` (`src/data/nasaPsiExperiments.json`).
- **NASA NTRS & PSI Attribution**:
  - Urban et al., ASGSR 2017 (`NASA NTRS 20180005168`, Table 1, pp. 30–31).
  - NASA Physical Sciences Informatics (`psi.nasa.gov`) references included in `src/data/nasaPsiExperiments.json`:
    - `PSI-98` (DOI `10.60555/0t15-1z43`, pending verification)
    - `PSI-99` (DOI `10.60555/2chp-m469`, pending verification)
    - `PSI-100` (DOI `10.60555/2chp-m469`, pending verification)
    - `PSI-25` (DOI `10.60555/4qc4-de67`, `PSI-25` Version 4, license `CC0-1.0`; `BASS-II-14` observed values are `Adapted Reference (unverified)`)
    - `PSI-69` (DOI `10.60555/mbq8-0451`, pending verification)
