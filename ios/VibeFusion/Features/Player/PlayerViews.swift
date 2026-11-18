import AVKit
import SwiftUI
import VFAudio
import VFCore
import VFDesignSystem

struct MiniPlayerView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        let isFusion = env.nowPlaying == .fusion
        let title = isFusion ? env.fusion.title : (env.player.current?.title ?? "")
        let subtitle = isFusion ? "AI Studio session" : (env.player.current?.creatorName ?? "")
        let playing = isFusion ? env.fusion.isPlaying : env.player.isPlaying
        let progress: Double = isFusion
            ? env.fusion.positionMs / Double(max(1, env.fusion.durationMs))
            : Double(env.player.positionMs) / Double(max(1, env.player.durationMs))
        VStack(spacing: 0) {
            ProgressView(value: min(1, max(0, progress))).tint(VFColor.primary).accessibilityHidden(true)
            HStack(spacing: VFSpacing.m) {
                if isFusion {
                    Image(systemName: "wand.and.stars").font(.title2).frame(width: 40, height: 40).background(VFColor.primary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
                } else if let a = env.player.current {
                    ArtworkView(url: a.artwork, size: 40, seed: a.id)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(phaseText(isFusion) ?? subtitle).font(.caption).foregroundStyle(VFColor.textSecondary).lineLimit(1)
                }
                Spacer()
                Button { isFusion ? env.fusion.toggle() : env.player.toggle() } label: {
                    Image(systemName: playing ? "pause.fill" : "play.fill").font(.title2).frame(width: 44, height: 44)
                }
                .accessibilityLabel(playing ? "Pause" : "Play")
                if !isFusion {
                    Button { env.player.next() } label: { Image(systemName: "forward.fill").frame(width: 44, height: 44) }.accessibilityLabel("Next")
                }
            }
            .padding(.horizontal, VFSpacing.m).padding(.vertical, VFSpacing.s)
        }
        .background(.ultraThinMaterial)
        .contentShape(Rectangle())
        .onTapGesture { if !isFusion { env.fullPlayerPresented = true } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Now playing: \(title)")
        .accessibilityAction(named: "Open full player") { env.fullPlayerPresented = true }
    }

    private func phaseText(_ fusion: Bool) -> String? {
        if fusion { if case .failed(let m) = env.fusion.state { return m }; return nil }
        switch env.player.phase {
        case .loading: return "Loading…"
        case .buffering: return "Buffering…"
        case .failed(let m): return m
        default: return nil
        }
    }
}

struct FullPlayerView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scrubbing: Double?
    @State private var sheet: Sheet?
    @State private var bookmarkNote = ""
    @AppStorage("vf.audioQuality") private var quality = "auto"
    enum Sheet: String, Identifiable { case queue, transcript, sleep; var id: String { rawValue } }

    var body: some View {
        let p = env.player
        NavigationStack {
            VStack(spacing: VFSpacing.l) {
                if let a = p.current {
                    ArtworkView(url: a.artwork, size: VFSize.artworkHero, seed: a.id)
                        .shadow(radius: 20)
                        .scaleEffect(p.isPlaying || reduceMotion ? 1 : 0.92)
                        .animation(reduceMotion ? nil : .spring, value: p.isPlaying)
                    VStack(spacing: 4) {
                        Text(a.title).font(.title3.bold()).lineLimit(2).multilineTextAlignment(.center)
                        if let c = a.creator {
                            NavigationLink(c.name, value: Route.creator(c.id)).font(.subheadline)
                        } else { Text(a.creatorName).font(.subheadline).foregroundStyle(VFColor.textSecondary) }
                    }
                    scrubber(p)
                    controls(p, a)
                    secondaryControls(p, a)
                    if case .failed(let m) = p.phase { Text(m).font(.callout).foregroundStyle(VFColor.destructive) }
                    if let att = a.license?.attribution { Text(att).font(.caption2).foregroundStyle(VFColor.textSecondary).multilineTextAlignment(.center).lineLimit(3) }
                } else {
                    EmptyStateView(message: "Nothing is playing.")
                }
                Spacer(minLength: 0)
            }
            .padding(VFSpacing.l)
            .navigationDestination(for: Route.self) { RouteView(route: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "chevron.down") }.accessibilityLabel("Close player") }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Audio quality", selection: $quality) { Text("Automatic").tag("auto"); Text("High").tag("high"); Text("Data saver").tag("data_saver") }
                    } label: { Image(systemName: "slider.horizontal.3") }
                    .accessibilityLabel("Audio quality")
                }
            }
            .vfScreen()
            .sheet(item: $sheet) { s in
                switch s {
                case .queue: QueueSheet().presentationDetents([.medium, .large])
                case .transcript: TranscriptSheet(asset: p.current!).presentationDetents([.medium, .large])
                case .sleep: SleepTimerSheet().presentationDetents([.medium])
                }
            }
        }
    }

    private func scrubber(_ p: StandardPlayer) -> some View {
        let pos = scrubbing ?? Double(p.positionMs)
        return VStack(spacing: 4) {
            Slider(value: Binding(get: { pos }, set: { scrubbing = $0 }), in: 0...Double(max(1, p.durationMs))) { editing in
                if !editing, let s = scrubbing { p.seek(toMs: Int(s)); scrubbing = nil }
            }
            .accessibilityLabel("Playback position")
            .accessibilityValue("\(formatDuration(ms: Int(pos))) of \(formatDuration(ms: p.durationMs))")
            HStack {
                Text(formatDuration(ms: Int(pos)))
                Spacer()
                Text("-" + formatDuration(ms: max(0, p.durationMs - Int(pos))))
            }
            .font(.caption.monospacedDigit()).foregroundStyle(VFColor.textSecondary)
        }
    }

    private func controls(_ p: StandardPlayer, _ a: Asset) -> some View {
        HStack(spacing: VFSpacing.xl) {
            Button { p.setShuffle(!p.queue.shuffled) } label: { Image(systemName: "shuffle").foregroundStyle(p.queue.shuffled ? VFColor.secondary : VFColor.textSecondary) }
                .accessibilityLabel("Shuffle").accessibilityValue(p.queue.shuffled ? "On" : "Off")
            if a.assetType.isSpoken {
                Button { p.skip(bySeconds: -15) } label: { Image(systemName: "gobackward.15").font(.title2) }.accessibilityLabel("Back 15 seconds")
            } else {
                Button { p.previous() } label: { Image(systemName: "backward.fill").font(.title2) }.accessibilityLabel("Previous")
            }
            Button { p.toggle() } label: {
                Image(systemName: p.isPlaying ? "pause.circle.fill" : "play.circle.fill").font(.system(size: VFSize.controlPrimary))
            }
            .accessibilityLabel(p.isPlaying ? "Pause" : "Play")
            if a.assetType.isSpoken {
                Button { p.skip(bySeconds: 30) } label: { Image(systemName: "goforward.30").font(.title2) }.accessibilityLabel("Forward 30 seconds")
            } else {
                Button { p.next() } label: { Image(systemName: "forward.fill").font(.title2) }.accessibilityLabel("Next")
            }
            Button { p.cycleRepeat() } label: {
                Image(systemName: p.queue.repeatMode == .one ? "repeat.1" : "repeat").foregroundStyle(p.queue.repeatMode == .off ? VFColor.textSecondary : VFColor.secondary)
            }
            .accessibilityLabel("Repeat").accessibilityValue(p.queue.repeatMode.rawValue)
        }
        .foregroundStyle(VFColor.textPrimary)
    }

    private func secondaryControls(_ p: StandardPlayer, _ a: Asset) -> some View {
        HStack(spacing: VFSpacing.l) {
            Button { Task { await env.library.toggleLike(a) } } label: { Image(systemName: env.library.isLiked(a.id) ? "heart.fill" : "heart") }
                .accessibilityLabel(env.library.isLiked(a.id) ? "Unlike" : "Like")
            if a.assetType.isSpoken {
                Menu {
                    ForEach(PlaybackRates.speech, id: \.self) { r in Button(PlaybackRates.label(r)) { p.setRate(r) } }
                } label: { Text(PlaybackRates.label(p.rate)).font(.subheadline.bold()).frame(minWidth: 44, minHeight: 44) }
                .accessibilityLabel("Playback speed \(PlaybackRates.label(p.rate))")
                Button {
                    Task {
                        if let b = try? await env.api.addBookmark(assetId: a.id, positionMs: p.positionMs, note: nil) {
                            env.flash("Bookmarked at \(formatDuration(ms: b.positionMs))")
                            await env.analytics.track("episode_bookmarked", ["assetId": .string(a.id)])
                        }
                    }
                } label: { Image(systemName: "bookmark") }.accessibilityLabel("Bookmark this moment")
                Button { sheet = .transcript } label: { Image(systemName: "text.quote") }.accessibilityLabel("Transcript")
            }
            Button { sheet = .sleep } label: {
                Image(systemName: p.sleepTimer == .off ? "moon.zzz" : "moon.zzz.fill")
            }
            .accessibilityLabel("Sleep timer").accessibilityValue(p.sleepTimer.label)
            Button { sheet = .queue } label: { Image(systemName: "list.bullet") }.accessibilityLabel("Queue")
            RoutePicker().frame(width: 44, height: 44).accessibilityLabel("Output device")
        }
        .font(.title3)
        .foregroundStyle(VFColor.textPrimary)
    }
}

struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = UIColor(VFColor.secondary)
        return v
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

struct QueueSheet: View {
    @Environment(AppEnvironment.self) private var env
    var body: some View {
        NavigationStack {
            List {
                if let c = env.player.current {
                    Section("Now playing") { TrackRow(asset: c, isCurrent: true) }
                }
                Section("Up next") {
                    if env.player.queue.upNext.isEmpty { Text("Your queue is empty.").foregroundStyle(VFColor.textSecondary) }
                    ForEach(Array(env.player.queue.upNext.enumerated()), id: \.offset) { i, a in
                        Button { env.player.jump(toUpNext: i) } label: { TrackRow(asset: a) }.buttonStyle(.plain)
                    }
                    .onDelete { idx in idx.forEach { env.player.removeUpNext(at: $0) } }
                    .onMove { from, to in if let f = from.first { env.player.moveUpNext(from: f, to: to > f ? to - 1 : to) } }
                }
            }
            .toolbar { EditButton() }
            .navigationTitle("Queue")
        }
    }
}

struct SleepTimerSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List(SleepTimerOption.presets, id: \.self) { o in
                Button {
                    env.player.setSleepTimer(o); dismiss()
                } label: {
                    HStack { Text(o.label); Spacer(); if env.player.sleepTimer == o { Image(systemName: "checkmark") } }
                }
            }
            .navigationTitle(env.player.sleepRemainingSec.map { "Sleep in \(formatDuration(ms: $0 * 1000))" } ?? "Sleep timer")
        }
    }
}

/// Transcript with tap-to-seek and live highlighting of the current segment.
struct TranscriptSheet: View {
    @Environment(AppEnvironment.self) private var env
    let asset: Asset
    @State private var state: LoadState<[TranscriptSegment]> = .idle
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    StateView(state, emptyMessage: "No transcript is available for this episode.", isEmpty: { $0.isEmpty }, retry: { Task { await load() } }) { segs in
                        LazyVStack(alignment: .leading, spacing: VFSpacing.m) {
                            ForEach(segs) { s in
                                let active = env.player.positionMs >= s.startMs && env.player.positionMs < s.endMs
                                Button { env.player.seek(toMs: s.startMs) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(formatDuration(ms: s.startMs) + (s.speaker.map { " · \($0)" } ?? "")).font(.caption2.monospacedDigit()).foregroundStyle(VFColor.textSecondary)
                                        Text(s.text).font(active ? .body.weight(.semibold) : .body).foregroundStyle(active ? VFColor.textPrimary : VFColor.textSecondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain).id(s.id)
                                .accessibilityHint("Jumps to \(formatDuration(ms: s.startMs))")
                            }
                        }.padding()
                    }
                }
                .onChange(of: env.player.positionMs / 2000) { _, _ in
                    if let segs = state.value, let cur = segs.last(where: { $0.startMs <= env.player.positionMs }) { withAnimation { proxy.scrollTo(cur.id, anchor: .center) } }
                }
            }
            .navigationTitle("Transcript")
        }
        .task { await load() }
    }
    private func load() async {
        state = .loading
        do { state = .loaded(try await env.api.transcript(asset.id)) } catch let e as APIError { state = e.status == 404 ? .loaded([]) : .failed(e) } catch {}
    }
}
