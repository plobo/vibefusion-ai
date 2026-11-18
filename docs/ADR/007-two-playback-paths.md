# ADR-007: Two playback paths
**Decision.** Standard streaming uses AVPlayer / Media3 ExoPlayer (adaptive, OS integration). Fusion uses AVAudioEngine (iOS) and a custom
MediaCodec → `FusionMixer` → AudioTrack engine (Android) rather than forcing ExoPlayer to mix. On Android the engine is wrapped in a Media3
`SimpleBasePlayer` and swapped into the same `MediaLibrarySession`. Oboe was evaluated; a JVM mixer was chosen because it is unit-testable
on the JVM and fast enough for ≤ 6 layers. **Consequences.** Native (C++) DSP can replace the mixer later behind `PcmSource`/`FusionMixer`.
