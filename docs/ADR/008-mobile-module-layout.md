# ADR-008: Mobile module layout
**iOS.** XcodeGen project; app target holds feature folders (`Features/*`); a local Swift package `VibeFusionKit` provides `VFCore`
(models, API, persistence, envelope), `VFAudio` (players/engine) and `VFDesignSystem`, testable with `xcodebuild test`.
**Android.** `:core:model` (pure Kotlin/JVM: models, envelope, mixer, queue), `:core:network`, `:core:database`, `:core:audio`,
`:core:designsystem`, and `:app` holding Hilt wiring, the playback service and feature screens (packages under `ui/`). Feature screens
were kept in `:app` to avoid per-feature Gradle overhead at this size; they can be split into `:feature:*` modules without API changes.
