# ADR-005: AI plans, DSP renders
**Decision.** `PlannerGateway` tries the primary planner (Anthropic, `claude-opus-5-5`, structured JSON output, low effort, server-side
refusal fallback) with timeout + one retry, then the deterministic `RuleBasedPlanner`. Output is validated by Ajv (full schema with bounds),
semantic rules (ids, bounds, transitions, source length) and rights (fail closed); invalid LLM output triggers the rule-based repair path.
Catalogue metadata is passed as untrusted data inside delimiters; no URLs or secrets are in prompts. **Consequences.** AI outages never block
manual mixing or playback (Scenario F); costs are bounded by per-user quotas.
