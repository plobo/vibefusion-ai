# ADR-003: Auth provider seam
**Decision.** Built-in auth (scrypt, HS256 access JWT 1 h, rotating hashed refresh tokens 30 d, guest sessions with upgrade) so the
product runs with zero third-party accounts. The auth hook also verifies Supabase-issued JWTs when `SUPABASE_JWT_SECRET` is set,
mapping them to local users. **Consequences.** Moving to managed auth (as the plan prefers) is configuration, not a rewrite.
Tokens: Keychain (iOS, after-first-unlock, this-device-only) and Android Keystore AES-GCM.
