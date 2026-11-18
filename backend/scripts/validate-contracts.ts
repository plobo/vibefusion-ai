/**
 * Contract checks (CI):
 *  1. openapi.yaml parses, is OpenAPI 3.1, and every local $ref resolves.
 *  2. Every route the backend registers is documented in openapi.yaml (and vice versa for /v1 paths).
 *  3. JSON Schemas compile; fixtures validate (valid plan passes, invalid schema cases fail).
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { REPO_ROOT, loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { createPgliteDb } from "../src/db/db.js";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error(`✗ ${m}`);
};
const ok = (m: string) => console.log(`✓ ${m}`);

const specPath = path.join(REPO_ROOT, "contracts", "openapi.yaml");
const spec = YAML.parse(fs.readFileSync(specPath, "utf8")) as Record<string, any>;
if (!String(spec.openapi).startsWith("3.1")) fail("openapi version must be 3.1.x");
else ok("openapi.yaml parses (3.1)");

function walk(node: unknown, visit: (ref: string) => void) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") visit(v);
      else walk(v, visit);
    }
  }
}
let refs = 0;
walk(spec, (ref) => {
  refs++;
  if (ref.startsWith("#/")) {
    const target = ref
      .slice(2)
      .split("/")
      .reduce<any>((acc, key) => (acc ? acc[key] : undefined), spec);
    if (target === undefined) fail(`unresolved $ref ${ref}`);
  } else if (!fs.existsSync(path.join(REPO_ROOT, "contracts", ref))) fail(`missing external $ref ${ref}`);
});
ok(`${refs} $refs checked`);

const ajv = new Ajv2020({ allErrors: true, strict: false });
const mixSchema = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/schemas/mix-plan.schema.json"), "utf8"),
);
const reqSchema = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/schemas/fusion-request.schema.json"), "utf8"),
);
const vPlan = ajv.compile(mixSchema);
ajv.compile(reqSchema);
ok("JSON Schemas compile");
const valid = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/fixtures/mix-plan-valid.json"), "utf8"),
);
if (!vPlan(valid)) fail(`mix-plan-valid.json fails schema: ${JSON.stringify(vPlan.errors)}`);
else ok("mix-plan-valid.json passes schema");
const invalid = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/fixtures/mix-plan-invalid.json"), "utf8"),
);
for (const c of invalid.cases as { expect: string; plan: unknown }[]) {
  if (c.expect === "SCHEMA" && vPlan(c.plan)) fail("an invalid SCHEMA fixture unexpectedly passed");
}
ok("invalid schema fixtures are rejected");
const env = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/fixtures/envelope-cases.json"), "utf8"),
);
for (const c of env.cases) if (!vPlan(c.plan)) fail(`envelope fixture ${c.name} plan fails schema`);
ok("envelope fixture plans pass schema");

const db = await createPgliteDb();
const { app, routes } = await buildApp({
  config: loadConfig({ syntheticCatalogue: false }),
  db,
  logger: false,
});
await app.ready();
const documented = new Set<string>();
for (const [p, ops] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
  for (const m of Object.keys(ops))
    if (["get", "post", "put", "patch", "delete"].includes(m)) documented.add(`${m.toUpperCase()} ${p}`);
}
const registered = new Set(routes.map((r) => `${r.method} ${r.url.replace(/:(\w+)/g, "{$1}")}`));
for (const r of registered) if (!documented.has(r)) fail(`route not documented in openapi.yaml: ${r}`);
for (const d of documented)
  if (d.includes(" /v1/") && !registered.has(d)) fail(`documented route not implemented: ${d}`);
ok(`${registered.size} registered routes compared with ${documented.size} documented operations`);
await app.close();
await db.close();

if (failures > 0) {
  console.error(`\n${failures} contract check(s) failed`);
  process.exit(1);
}
console.log("\nAll contract checks passed");
