# ADR-001: Modular monolith on TypeScript/Fastify
**Context.** The plan recommends a modular monolith (NestJS or Ktor). **Decision.** Fastify 5 + TypeScript, one folder per module,
explicit dependency container (`AppDeps`), JSON-schema request validation, consistent error envelope. Fastify was chosen over NestJS
for a smaller surface and faster tests (in-process `inject`). **Consequences.** Modules can be extracted later; no DI framework magic.
