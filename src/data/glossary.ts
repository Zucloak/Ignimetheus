export interface GlossaryEntry {
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  source: string;
}

export const ABOUT_EXAMPLE_QUESTIONS = [
  'Why does 0 cm/s quench in 0g?',
  'Give me the spread rate, O2 percent, flow velocity and pressure in one sentence.',
  'Compare this scenario in 0g and 1g.',
  'What is Da*?',
] as const;

export const GLOSSARY_FALLBACK =
  "I don't have a definition for that yet. I can explain LOI margin, Da*, flow modes, microgravity, Saffire/BASS/FLEX, STD-6001, thermocouples and probes.";

export const GLOSSARY_ENTRIES: GlossaryEntry[] = [
  {
    id: 'loi-margin',
    term: 'LOI & LOI Margin',
    aliases: ['loi', 'loi margin', 'limiting oxygen index', 'effective loi'],
    definition:
      'Limiting Oxygen Index (LOI) is the minimum O2 percentage needed to sustain flame spread under the active flow and gravity condition. LOI margin is effective O2 minus effective LOI: positive values lie above the flammability threshold, while negative values lie below it.',
    source: 'standard combustion terminology / solver definition (thermoCore.ts)',
  },
  {
    id: 'damkohler-star',
    term: 'Da* (Extinction-Proximity Index)',
    aliases: ['da*', 'da', 'damkohler', 'extinction-proximity index', 'extinction proximity index', 'extinction index'],
    definition:
      "In this simulation, Da* is an algebraic extinction-proximity index derived from the solver's LOI margin and flow strain, not an independent Arrhenius Damkohler number. Values >= 1.00 correspond to sustained-burn conditions, and values < 1.00 correspond to quenched or blow-off conditions.",
    source: 'solver definition (thermoCore.ts)',
  },
  {
    id: 'flow-modes',
    term: 'Concurrent vs Opposed Flow',
    aliases: [
      'concurrent vs opposed flow',
      'opposed vs concurrent flow',
      'concurrent flow',
      'opposed flow',
      'flow mode',
      'flow modes',
    ],
    definition:
      'Opposed flow moves opposite to the flame spread direction, sweeping heat away from unburned fuel ahead of the pyrolysis front. Concurrent flow moves in the same direction as flame spread, preheating downstream fuel and generally increasing spread rate.',
    source: 'standard combustion terminology',
  },
  {
    id: 'microgravity',
    term: 'Microgravity (0g)',
    aliases: ['microgravity', '0g', 'zero g', 'zero-g', 'freefall'],
    definition:
      'Microgravity (0g) eliminates natural buoyant convection, so hot combustion products do not rise and draw fresh oxidizer into the flame zone. Without forced ventilation, oxygen transport slows to molecular diffusion while radiative cooling persists.',
    source: 'standard microgravity combustion terminology',
  },
  {
    id: 'nasa-datasets',
    term: 'Saffire, BASS-II & FLEX',
    aliases: ['saffire', 'saffire-ii', 'bass', 'bass-ii', 'flex'],
    definition:
      'Saffire, BASS-II, and FLEX are NASA microgravity combustion investigations covering large-duct thin-sheet fires (Cygnus Saffire), small-duct rod and sheet tests (BASS-II), and liquid droplet combustion (FLEX). Saffire reference values in this app come from NASA published summaries (Urban et al., ASGSR 2017 / NTRS 20180005168); PSI IDs and DOIs are pending verification.',
    source: 'NASA NTRS 20180005168 & dataset metadata (PSI IDs/DOIs pending verification)',
  },
  {
    id: 'nasa-std-6001',
    term: 'NASA-STD-6001 (152 mm Screening)',
    aliases: ['nasa-std-6001', 'std-6001', 'std 6001', '6001'],
    definition:
      'NASA-STD-6001 Test 1 is a 1g upward flame-propagation screening test using a 152 mm burn-length criterion on a vertical sample. This app simulates a 0g or selectable-gravity flow duct, which is a different test configuration from the standard.',
    source: 'NASA-STD-6001 Test 1 configuration definition',
  },
  {
    id: 'thermocouples',
    term: 'Thermocouple Array (TC-1..TC-6)',
    aliases: ['thermocouple', 'thermocouples', 'tc array', 'tc-1..6'],
    definition:
      'Six simulated thermocouples (TC-1 through TC-6) are positioned axially along the 300 mm specimen inside the quartz duct to report local temperature readings along the burn path.',
    source: 'solver definition (ductProbes.ts)',
  },
  {
    id: 'probes-calipers',
    term: 'CAD Probes (P-n) & Calipers (D-n)',
    aliases: ['probe', 'probes', 'caliper', 'calipers', 'p-n', 'd-n'],
    definition:
      'CAD point probes (P-n) sample local temperature and flow velocity at a pinned coordinate in the quartz duct, while calipers (D-n) measure 2D distance between two pinned points.',
    source: 'solver definition (ductProbes.ts)',
  },
];

export function lookupGlossaryTerm(query: string): GlossaryEntry | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  if (/\bconcurrent\b/.test(q) && /\bopposed\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'flow-modes') ?? null;
  }
  if (/\b(?:da\*|damkohler|extinction[\s-]*proximity|extinction\s+index)\b/.test(q) || /\bda\b\??$/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'damkohler-star') ?? null;
  }
  if (/\b(?:loi\s*margin|loi|limiting\s+oxygen\s+index)\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'loi-margin') ?? null;
  }
  if (/\b(?:concurrent\s+flow|opposed\s+flow|flow\s+modes?)\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'flow-modes') ?? null;
  }
  if (/\b(?:microgravity|zero[\s-]*g)\b/.test(q) || /\bwhat\s+is\s+0g\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'microgravity') ?? null;
  }
  if (/\b(?:saffire(?:-?(?:i|ii|iii))?|bass(?:-?ii)?|flex)\b/.test(q) && !/-\d{2}\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'nasa-datasets') ?? null;
  }
  if (/\b(?:nasa-)?std-?6001\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'nasa-std-6001') ?? null;
  }
  if (/\bthermocouples?\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'thermocouples') ?? null;
  }
  if (/\b(?:cad\s+probes?|point\s+probes?|calipers?|probes?)\b/.test(q) && !/\bp-\d+\b/.test(q)) {
    return GLOSSARY_ENTRIES.find((e) => e.id === 'probes-calipers') ?? null;
  }

  return null;
}
