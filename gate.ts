// gate.ts: a tiny schema gate for structured LLM output.
// Everything is mocked: the "model" returns scripted strings, not provider calls.
// The fixtures, confidence numbers, and pass rates below are EXAMPLE INPUTS.
// No API key. No network. Run: npx tsx gate.ts

// ---------------------------------------------------------------------------
// Step 1: the schema the ship gate will enforce
// ---------------------------------------------------------------------------

type JsonSchema = {
  type: "object";
  properties: Record<string, Prop>;
  required: string[];
  additionalProperties: false;
};

type Prop =
  | { type: "string"; enum?: string[] }
  | { type: "number"; minimum?: number; maximum?: number };

const ACTIONS = ["route", "escalate", "ignore"] as const;
type Action = (typeof ACTIONS)[number];

type Decision = {
  action: Action;
  target: string;
  confidence: number;
};

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    target: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["action", "target", "confidence"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Step 2: a hand-rolled validator (zero deps)
// ---------------------------------------------------------------------------

type Issue = { path: string; message: string };

function validate(raw: unknown, schema: JsonSchema): Issue[] {
  const issues: Issue[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ path: "$", message: "expected an object" }];
  }
  const obj = raw as Record<string, unknown>;

  for (const key of schema.required) {
    if (!(key in obj)) issues.push({ path: key, message: "required field missing" });
  }

  for (const key of Object.keys(obj)) {
    if (!(key in schema.properties)) {
      issues.push({ path: key, message: "additional property not allowed" });
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (prop.type === "string") {
      if (typeof v !== "string") {
        issues.push({ path: key, message: `expected string, got ${typeOf(v)}` });
      } else if (prop.enum && !prop.enum.includes(v)) {
        issues.push({
          path: key,
          message: `expected one of [${prop.enum.join(", ")}], got ${JSON.stringify(v)}`,
        });
      }
    } else if (prop.type === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) {
        issues.push({ path: key, message: `expected number, got ${typeOf(v)}` });
      } else {
        if (prop.minimum !== undefined && v < prop.minimum) {
          issues.push({ path: key, message: `below minimum ${prop.minimum}` });
        }
        if (prop.maximum !== undefined && v > prop.maximum) {
          issues.push({ path: key, message: `above maximum ${prop.maximum}` });
        }
      }
    }
  }
  return issues;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "parse failed" };
  }
}

// ---------------------------------------------------------------------------
// Step 3: mock model fixtures (example inputs; labels are the failure mode)
// ---------------------------------------------------------------------------

type Fixture = {
  id: string;
  label: string;
  first: string; // first-pass model text
  repair?: string; // optional second-pass after validation errors are fed back
};

const FIXTURES: Fixture[] = [
  {
    id: "valid",
    label: "valid JSON",
    first: '{"action":"route","target":"billing","confidence":0.91}',
  },
  {
    id: "truncated",
    label: "truncated JSON",
    first: '{"action":"route","target":"billing","confidence":0.8',
    repair: '{"action":"route","target":"billing","confidence":0.82}',
  },
  {
    id: "wrong-type",
    label: "wrong types",
    first: '{"action":"route","target":"support","confidence":"high"}',
    repair: '{"action":"route","target":"support","confidence":0.74}',
  },
  {
    id: "bad-enum",
    label: "invalid enum",
    first: '{"action":"forward","target":"sales","confidence":0.6}',
    repair: '{"action":"escalate","target":"sales","confidence":0.6}',
  },
  {
    id: "extra-field",
    label: "extra fields",
    first: '{"action":"ignore","target":"spam","confidence":0.95,"reason":"promo"}',
    repair: '{"action":"ignore","target":"spam","confidence":0.95}',
  },
  {
    id: "missing",
    label: "missing required",
    first: '{"action":"route","confidence":0.7}',
    repair: '{"action":"route","target":"onboarding","confidence":0.7}',
  },
  {
    id: "out-of-range",
    label: "confidence out of range",
    first: '{"action":"escalate","target":"legal","confidence":1.4}',
    repair: '{"action":"escalate","target":"legal","confidence":0.88}',
  },
  {
    id: "stubborn",
    label: "repair still invalid",
    first: '{"action":"route","target":42,"confidence":0.5}',
    repair: '{"action":"route","target":42,"confidence":0.5}',
  },
];

// Mock "model": returns the scripted string. The repair pass gets the errors.
function mockComplete(fixture: Fixture, pass: "first" | "repair", _errors?: Issue[]): string {
  if (pass === "first") return fixture.first;
  return fixture.repair ?? fixture.first;
}

// ---------------------------------------------------------------------------
// Step 4: one constrained repair, then accept or reject
// ---------------------------------------------------------------------------

type Outcome =
  | { status: "accept"; pass: "first" | "repair"; value: Decision }
  | { status: "reject"; pass: "first" | "repair"; issues: Issue[] };

function gate(fixture: Fixture): Outcome {
  const firstText = mockComplete(fixture, "first");
  const firstParsed = parseJson(firstText);
  if (!firstParsed.ok) {
    const issues: Issue[] = [{ path: "$", message: `JSON parse error: ${firstParsed.error}` }];
    return repairOnce(fixture, issues);
  }
  const firstIssues = validate(firstParsed.value, SCHEMA);
  if (firstIssues.length === 0) {
    return { status: "accept", pass: "first", value: firstParsed.value as Decision };
  }
  return repairOnce(fixture, firstIssues);
}

function repairOnce(fixture: Fixture, firstIssues: Issue[]): Outcome {
  const repairText = mockComplete(fixture, "repair", firstIssues);
  const repaired = parseJson(repairText);
  if (!repaired.ok) {
    return {
      status: "reject",
      pass: "repair",
      issues: [{ path: "$", message: `JSON parse error: ${repaired.error}` }],
    };
  }
  const repairIssues = validate(repaired.value, SCHEMA);
  if (repairIssues.length === 0) {
    return { status: "accept", pass: "repair", value: repaired.value as Decision };
  }
  return { status: "reject", pass: "repair", issues: repairIssues };
}

// ---------------------------------------------------------------------------
// Step 5: run the matrix and print metrics
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  label: string;
  status: "accept" | "reject";
  pass: "first" | "repair";
  detail: string;
};

const rows: Row[] = FIXTURES.map((f) => {
  const out = gate(f);
  if (out.status === "accept") {
    return {
      id: f.id,
      label: f.label,
      status: "accept",
      pass: out.pass,
      detail: JSON.stringify(out.value),
    };
  }
  return {
    id: f.id,
    label: f.label,
    status: "reject",
    pass: out.pass,
    detail: out.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
  };
});

const n = rows.length;
const passAt1 = rows.filter((r) => r.status === "accept" && r.pass === "first").length;
const passAtRepair = rows.filter((r) => r.status === "accept").length;
const rejected = rows.filter((r) => r.status === "reject").length;

console.log(`tiny-schema-gate  fixtures=${n} (example data)\n`);
console.log("id            label                      result   pass     detail");
console.log("-".repeat(96));
for (const r of rows) {
  const id = r.id.padEnd(13);
  const label = r.label.padEnd(25);
  const result = r.status.padEnd(8);
  const pass = r.pass.padEnd(8);
  const detail = r.detail.length > 42 ? r.detail.slice(0, 39) + "..." : r.detail;
  console.log(`${id} ${label} ${result} ${pass} ${detail}`);
}

console.log("\n== metrics ==");
console.log(`pass@1       ${(passAt1 / n).toFixed(2)}  (${passAt1}/${n})`);
console.log(`pass@repair  ${(passAtRepair / n).toFixed(2)}  (${passAtRepair}/${n})`);
console.log(`reject rate  ${(rejected / n).toFixed(2)}  (${rejected}/${n})`);

const shipFloor = 0.75; // example threshold: accept at least 75% after one repair
const ship = passAtRepair / n >= shipFloor;
console.log(`\ngate: ${ship ? "SHIP" : "HOLD"}  (pass@repair >= ${shipFloor} required)`);
