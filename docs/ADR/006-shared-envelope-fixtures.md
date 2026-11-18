# ADR-006: Shared envelope semantics via fixtures
**Decision.** `backend/src/fusion/envelope.ts` is normative; `npm run fixtures` generates `contracts/fixtures/envelope-cases.json`
(gains, duck weights, pan, source positions at sampled times). Swift (`VFCore.Envelope`) and Kotlin (`core.model.Envelope`) tests must match
within 1e-4; a backend test fails if the fixture drifts from the reference. **Consequences.** Identical audible intent across platforms.
