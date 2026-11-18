import SwiftUI
import VFCore
import VFDesignSystem

struct PodcastsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var state: LoadState<[Show]> = .idle
    @State private var kind = "podcast"
    private let grid = [GridItem(.adaptive(minimum: 150), spacing: 16)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                Picker("Kind", selection: $kind) { Text("Podcasts").tag("podcast"); Text("Speech series").tag("speech_series") }.pickerStyle(.segmented)
                NavigationLink(value: Route.motivation) { Label("Motivation hub", systemImage: "flame") }
                StateView(state, emptyMessage: "Shows are still being added. Pull to refresh.", isEmpty: { $0.isEmpty }, retry: { Task { await load() } }) { shows in
                    let followed = shows.filter { $0.following == true }
                    if !followed.isEmpty {
                        SectionHeader("Following")
                        grid(followed)
                    }
                    SectionHeader(kind == "podcast" ? "Browse shows" : "Classic speeches")
                    grid(shows.filter { $0.showKind == kind })
                }
            }
            .padding(VFSpacing.l)
        }
        .navigationTitle("Podcasts")
        .vfScreen()
        .refreshable { await load() }
        .task { await load() }
    }

    private func grid(_ shows: [Show]) -> some View {
        LazyVGrid(columns: grid, alignment: .leading, spacing: 16) {
            ForEach(shows) { s in
                NavigationLink(value: Route.show(s.id)) {
                    ArtworkCard(title: s.title, subtitle: s.creatorName.map { "\($0) · \(s.episodeCount ?? 0) episodes" }, artwork: s.artwork, seed: s.id)
                }.buttonStyle(.plain)
            }
        }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await env.api.podcasts(category: nil)) } catch let e as APIError { state = .failed(e) } catch {}
    }
}

struct ShowDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let showId: String
    @State private var show: Show?
    @State private var episodes: [EpisodeWithProgress] = []
    @State private var cursor: String?
    @State private var state: LoadState<Bool> = .idle

    var body: some View {
        List {
            if let s = show {
                VStack(alignment: .leading, spacing: VFSpacing.m) {
                    HStack(alignment: .top, spacing: VFSpacing.m) {
                        ArtworkView(url: s.artwork, size: 120, seed: s.id)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(s.title).font(.title3.bold())
                            if let c = s.creatorName { Text(c).foregroundStyle(VFColor.textSecondary) }
                            Button {
                                let on = !(s.following ?? false)
                                show?.following = on
                                Task {
                                    do { try await env.api.follow(showId: s.id, on) } catch { show?.following = !on; env.flash("Couldn't update follow.") }
                                }
                            } label: { Label(s.following == true ? "Following" : "Follow", systemImage: s.following == true ? "checkmark" : "plus") }
                            .buttonStyle(.bordered)
                            .disabled(env.session == .guest)
                        }
                    }
                    if let d = s.description { Text(d).font(.callout).foregroundStyle(VFColor.textSecondary).lineLimit(5) }
                }
                .listRowBackground(Color.clear)
            }
            StateView(state, emptyMessage: "No episodes available.", isEmpty: { _ in episodes.isEmpty }, retry: { Task { await load(reset: true) } }) { _ in
                ForEach(episodes) { e in
                    NavigationLink(value: Route.episode(e.asset.id)) { EpisodeRow(episode: e) }
                        .onAppear { if e.id == episodes.last?.id, cursor != nil { Task { await load(reset: false) } } }
                }
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .navigationTitle(show?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .vfScreen()
        .task { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        if reset { state = .loading }
        do {
            if show == nil { show = try await env.api.show(showId) }
            let page = try await env.api.episodes(showId: showId, cursor: reset ? nil : cursor)
            episodes = reset ? page.items : episodes + page.items
            cursor = page.nextCursor
            state = .loaded(true)
        } catch let e as APIError { if episodes.isEmpty { state = .failed(e) } } catch {}
    }
}

struct EpisodeRow: View {
    @Environment(AppEnvironment.self) private var env
    let episode: EpisodeWithProgress
    var body: some View {
        let a = episode.asset
        VStack(alignment: .leading, spacing: 6) {
            if let d = a.releaseDate.flatMap({ ISO8601DateFormatter().date(from: $0) }) {
                Text(d, style: .date).font(.caption).foregroundStyle(VFColor.textSecondary)
            }
            Text(a.title).font(.headline).lineLimit(2)
            HStack {
                Button { env.play([a]) } label: { Image(systemName: "play.circle.fill").font(.title2) }.buttonStyle(.plain).accessibilityLabel("Play \(a.title)")
                if let p = episode.progress, !p.completed, p.positionMs > 0 {
                    ProgressView(value: Double(p.positionMs), total: Double(max(1, a.durationMs))).frame(width: 60).accessibilityLabel("Partly played")
                    Text("\(spokenDuration(ms: a.durationMs - p.positionMs)) left").font(.caption)
                } else if episode.progress?.completed == true {
                    Label("Played", systemImage: "checkmark").font(.caption)
                } else {
                    Text(spokenDuration(ms: a.durationMs)).font(.caption)
                }
            }
            .foregroundStyle(VFColor.textSecondary)
        }
        .padding(.vertical, 4)
    }
}

struct EpisodeDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let episodeId: String
    @State private var state: LoadState<EpisodeDetail> = .idle
    @State private var bookmarks: [Bookmark] = []

    var body: some View {
        ScrollView {
            StateView(state, retry: { Task { await load() } }) { ep in
                let a = ep.asset
                VStack(alignment: .leading, spacing: VFSpacing.l) {
                    HStack(alignment: .top) {
                        ArtworkView(url: a.artwork, size: 96, seed: a.id)
                        VStack(alignment: .leading) {
                            Text(a.title).font(.title3.bold())
                            Text(a.showTitle ?? a.creatorName).foregroundStyle(VFColor.textSecondary)
                            Text(spokenDuration(ms: a.durationMs)).font(.caption).foregroundStyle(VFColor.textSecondary)
                        }
                    }
                    HStack {
                        PrimaryButton(ep.progress.map { $0.positionMs > 0 && !$0.completed ? "Resume" : "Play" } ?? "Play", systemImage: "play.fill") { env.play([a]) }
                        if a.capabilities.download && env.session == .account {
                            Button { Task { await env.downloads.download(a) } } label: {
                                Image(systemName: env.downloads.downloadedIds.contains(a.id) ? "checkmark.circle.fill" : "arrow.down.circle").font(.title2).frame(width: 50, height: 50)
                            }.accessibilityLabel("Download episode")
                        }
                    }
                    if !ep.chapters.isEmpty {
                        SectionHeader("Chapters")
                        ForEach(ep.chapters, id: \.startMs) { c in
                            Button { playAt(a, c.startMs) } label: {
                                HStack { Text(formatDuration(ms: c.startMs)).monospacedDigit().foregroundStyle(VFColor.secondary); Text(c.title); Spacer() }.frame(minHeight: 40)
                            }.buttonStyle(.plain)
                        }
                    }
                    if !bookmarks.isEmpty {
                        SectionHeader("Your bookmarks")
                        ForEach(bookmarks) { b in
                            HStack {
                                Button { playAt(a, b.positionMs) } label: {
                                    Label("\(formatDuration(ms: b.positionMs))\(b.note.map { " — \($0)" } ?? "")", systemImage: "bookmark.fill")
                                }.buttonStyle(.plain)
                                Spacer()
                                ShareLink(item: URL(string: "vibefusion://listen/\(a.id)?t=\(b.positionMs / 1000)")!) { Image(systemName: "square.and.arrow.up") }
                                    .accessibilityLabel("Share timestamp link")
                                Button(role: .destructive) {
                                    Task { try? await env.api.deleteBookmark(b.id); bookmarks.removeAll { $0.id == b.id } }
                                } label: { Image(systemName: "trash") }.accessibilityLabel("Delete bookmark")
                            }.frame(minHeight: 44)
                        }
                    }
                    if ep.hasTranscript { TranscriptPreview(asset: a) }
                    if let d = a.description { SectionHeader("About"); Text(d).foregroundStyle(VFColor.textSecondary) }
                    LicenceCard(asset: a)
                }
                .padding(VFSpacing.l)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .vfScreen()
        .task { await load() }
    }

    private func playAt(_ a: Asset, _ ms: Int) {
        if env.player.current?.id == a.id { env.player.seek(toMs: ms); env.player.resume(); return }
        env.play([a])
        Task { try? await Task.sleep(nanoseconds: 700_000_000); env.player.seek(toMs: ms) }
    }

    private func load() async {
        state = .loading
        do {
            let ep = try await env.api.episode(episodeId)
            bookmarks = ep.bookmarks
            state = .loaded(ep)
        } catch let e as APIError { state = .failed(e) } catch {}
    }
}

private struct TranscriptPreview: View {
    @Environment(AppEnvironment.self) private var env
    let asset: Asset
    @State private var segments: [TranscriptSegment] = []
    var body: some View {
        VStack(alignment: .leading, spacing: VFSpacing.s) {
            SectionHeader("Transcript")
            ForEach(segments.prefix(8)) { s in
                Button {
                    if env.player.current?.id != asset.id { env.play([asset]) }
                    Task { try? await Task.sleep(nanoseconds: 500_000_000); env.player.seek(toMs: s.startMs) }
                } label: {
                    HStack(alignment: .top) {
                        Text(formatDuration(ms: s.startMs)).font(.caption.monospacedDigit()).foregroundStyle(VFColor.secondary)
                        Text(s.text).font(.callout)
                    }
                }.buttonStyle(.plain)
            }
        }
        .task { segments = (try? await env.api.transcript(asset.id)) ?? [] }
    }
}

struct MotivationHubView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var topics: [Tag] = []
    @State private var topic: String?
    @State private var state: LoadState<MotivationFeatured> = .idle

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        Chip("All", selected: topic == nil) { topic = nil }
                        ForEach(topics) { t in Chip(t.name, selected: topic == t.id) { topic = t.id } }
                    }
                }
                StateView(state, retry: { Task { await load() } }) { m in
                    VStack(alignment: .leading, spacing: VFSpacing.l) {
                        if let f = m.featured { SectionHeader("Daily featured speech"); FeaturedSpeechCard(asset: f) }
                        list("Short inspiration (under 10 min)", m.short)
                        list("Long-form", m.long)
                        if !m.speakers.isEmpty {
                            SectionHeader("Speakers")
                            ForEach(m.speakers, id: \.id) { s in NavigationLink(value: Route.creator(s.id)) { Label(s.name, systemImage: "person.wave.2") } }
                        }
                        Text("Speeches are public-domain readings from LibriVox volunteers or openly published podcasts.").font(.caption).foregroundStyle(VFColor.textSecondary)
                    }
                }
            }
            .padding(VFSpacing.l)
        }
        .navigationTitle("Motivation")
        .vfScreen()
        .task { if topics.isEmpty { topics = (try? await env.api.motivationTopics()) ?? [] }; await load() }
        .onChange(of: topic) { _, _ in Task { await load() } }
    }

    @ViewBuilder private func list(_ title: String, _ items: [Asset]) -> some View {
        if !items.isEmpty {
            SectionHeader(title)
            ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                Button { env.play(items, startAt: i) } label: { TrackRow(asset: a) }.buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
            }
        }
    }

    private func load() async {
        state = .loading
        do { state = .loaded(try await env.api.motivationFeatured(topic: topic)) } catch let e as APIError { state = .failed(e) } catch {}
    }
}
