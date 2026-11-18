# Audio engine

## 1. Two engines per platform

| | Standard streaming | Fusion (multi-layer) |
|---|---|---|
| iOS | `StandardPlayer` (AVPlayer): queue, resume, URL refresh on item failure, sleep timer, speed, `MPRemoteCommandCenter`, Now Playing | `FusionPlaybackEngine`: one `AVAudioPlayerNode` per layer → main mixer → Apple peak limiter → output. All nodes `play(at:)` the same host time. |
| Android | `PlaybackService` (Media3 ExoPlayer + `MediaLibrarySession`): audio focus, becoming-noisy, foreground notification, Android Auto browse tree | `FusionEngine`: per-layer `MediaCodecPcmSource` (decode + resample to 48 kHz stereo) → `FusionMixer` → one float `AudioTrack`; exposed to the session via `FusionSessionPlayer` |

Both fusion engines also render **offline** (iOS: AVAudioEngine manual rendering → AAC; Android: mixer → WAV), only after the server
authorizes `derivative_render` for every layer.

## 2. Mix-plan semantics (normative)

Reference implementation: `backend/src/fusion/envelope.ts`. Fixture: `contracts/fixtures/envelope-cases.json` (tolerance 1e-4).

```
dbToLin(db) = 10^(db/20)
curveIn(linear,x)=x · curveIn(equal_power,x)=sin(xπ/2) · curveIn(exponential,x)=x²   (x clamped to [0,1])
curveOut(c,x) = curveIn(c, 1−x)

layerGain(plan, L, t):
  0 if muted, or any layer is solo and L is not
  local = t − L.startMs;  0 if local < 0 or local ≥ L.durationMs
  g = dbToLin(L.gainDb)
  fade-in  (local < fadeInMs):            g *= curveIn(equal_power, local / fadeInMs)
  fade-out (durationMs − local < fadeOut): g *= curveIn(equal_power, (durationMs − local) / fadeOutMs)
  transitions where L is `from` and t ≥ start: g *= curveOut(curve, (t − start)/dur)   (0 after)
  transitions where L is `to`:  g = 0 before start; else g *= curveIn(curve, (t − start)/dur)
  if L.role ≠ speech: g *= dbToLin(−amountDb · duckWeight(t))

duckWeight(t) = max over audible speech layers S of:
  0 before S.start; ramp 0→1 over attackMs; 1 while active; ramp 1→0 over releaseMs after S.end
master = dbToLin(masterGainDb, default −3 dB); pan: equal-power (cos, sin)((p+1)π/4)
sourcePosition(L, assetDur, t): loop → sourceIn + (local mod (assetDur − sourceIn)); else sourceIn + local while < assetDur
```

Defaults: ducking 9 dB, attack 300 ms, release 800 ms; master −3 dB; peak protection: Apple PeakLimiter on iOS, soft-knee
limiter (knee −1 dBFS, ceiling 0.98) in `FusionMixer`. Beat snapping (`snapToBeat` + `tempoBpm`) is applied server-side
during validation so engines stay simple.

## 3. Synchronization and automation

* iOS: segments from `FusionScheduler` are scheduled with sample-time offsets; all nodes start at one `AVAudioTime(hostTime:)`.
  Gain automation runs at 50 Hz on the main run loop (`Timer`, common mode) from the deterministic envelope. Seek/pause = stop
  nodes and reschedule from the playhead (no drift accumulates).
* Android: a single mixer thread (`THREAD_PRIORITY_AUDIO`) pulls 1024-frame blocks; gains are evaluated at block edges and ramped
  per sample (click-free). One sample clock for all layers; the playhead is derived from `AudioTrack.playbackHeadPosition`.

## 4. Lifecycle & recovery

| Event | iOS | Android |
|---|---|---|
| Interruption (call, Siri) | pause; resume only if `shouldResume` and was playing (`AudioSessionPolicy`) | audio focus loss → pause; regain → resume if was playing; duck → lower volume |
| Headphones/BT disconnected | `oldDeviceUnavailable` → pause | `ACTION_AUDIO_BECOMING_NOISY` → pause (ExoPlayer handles standard) |
| Route / sample-rate change | `AVAudioEngineConfigurationChange` → restart from playhead | AudioTrack reused; device routing handled by OS |
| Media services reset | rebuild graph from retained files | — |
| Release | detach nodes, remove observers, purge buffers | join thread, release codecs/AudioTrack, unregister receivers, abandon focus |

## 5. Known limits (MVP)

* Control-rate (50 Hz) automation on iOS — ramps are smooth for fades/ducking but not sample-accurate. Android is per-sample.
* Layer starts on Android are block-quantized (~21 ms at 1024 frames/48 kHz).
* No tempo/key matching is claimed; `/v1/fusion/suggestions` only uses measured metadata (synthetic Sound Lab assets).
* Stem separation is not offered (`501`): no catalogue licence permits it.
