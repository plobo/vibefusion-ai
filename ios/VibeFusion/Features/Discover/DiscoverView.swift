import SwiftUI
import VFCore
import VFDesignSystem

struct DiscoverView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var genres: [Tag] = []
    @State private var moods: [Tag] = []
    @State private var collections: [CatalogueCollection] = []
    @State private var featured: LoadState<Page<Asset>> = .idle
    @State private var error: APIError?
    private let grid = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.xl) {
                NavigationLink(value: Route.search) {
                    HStack { Image(systemName: "magnifyingglass"); Text("Search").foregroundStyle(VFColor.textSecondary); Spacer() }
                        .padding(VFSpacing.m).background(VFColor.elevated, in: RoundedRectangle(cornerRadius: VFRadius.m))
                }
                if let error { ErrorStateView(error: error) { Task { await load() } } }

                NavigationLink(value: Route.motivation) {
                    HStack {
                        VStack(alignment: .leading) {
                            Text("Motivation hub").font(.headline)
                            Text("Discipline, confidence, resilience and more").font(.caption).foregroundStyle(VFColor.textSecondary)
                        }
                        Spacer()
                        Image(systemName: "flame.fill").font(.title).foregroundStyle(VFColor.accent)
                    }
                    .padding(VFSpacing.l).background(LinearGradient(colors: [VFColor.accent.opacity(0.35), VFColor.surface], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: VFRadius.l))
                }.buttonStyle(.plain)

                if !collections.isEmpty {
                    SectionHeader("Curated collections")
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(spacing: VFSpacing.m) {
                            ForEach(collections) { c in
                                NavigationLink(value: Route.collection(c.slug ?? c.id)) {
                                    ArtworkCard(title: c.title, subtitle: c.description, artwork: c.artworkUrl.flatMap(URL.init(string:)), seed: c.id)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
                tagGrid("Genres", genres) { Route.catalogue(title: $0.name.capitalized, genre: $0.id, mood: nil, topic: nil) }
                tagGrid("Moods", moods) { Route.catalogue(title: $0.name, genre: nil, mood: $0.id, topic: nil) }

                SectionHeader("New & featured")
                StateView(featured, retry: { Task { await load() } }) { page in
                    LazyVStack(spacing: VFSpacing.s) {
                        ForEach(Array(page.items.enumerated()), id: \.element.id) { i, a in
                            Button { env.play(page.items, startAt: i) } label: { TrackRow(asset: a, isCurrent: env.player.current?.id == a.id) }
                                .buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
                        }
                    }
                }
            }
            .padding(VFSpacing.l)
        }
        .navigationTitle("Discover")
        .vfScreen()
        .refreshable { await load() }
        .task { if genres.isEmpty { await load() } }
    }

    private func tagGrid(_ title: String, _ tags: [Tag], route: @escaping (Tag) -> Route) -> some View {
        VStack(alignment: .leading, spacing: VFSpacing.m) {
            if !tags.isEmpty { SectionHeader(title) }
            LazyVGrid(columns: grid, spacing: 12) {
                ForEach(tags.prefix(12)) { t in
                    NavigationLink(value: route(t)) {
                        Text(t.name.capitalized).font(.headline).frame(maxWidth: .infinity, minHeight: 64)
                            .background(LinearGradient(colors: [Color(hue: Double(abs(t.id.hashValue % 360)) / 360, saturation: 0.55, brightness: 0.45), VFColor.elevated], startPoint: .topLeading, endPoint: .bottomTrailing),
                                        in: RoundedRectangle(cornerRadius: VFRadius.m))
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("\(t.assetCount ?? 0) items")
                }
            }
        }
    }

    private func load() async {
        error = nil
        do {
            async let g = env.api.genres()
            async let m = env.api.moods()
            async let c = env.api.collections()
            async let f = env.api.catalogue(type: "music", genre: nil, mood: nil, topic: nil, mixable: false, cursor: nil)
            (genres, moods, collections) = try await (g, m, c)
            featured = .loaded(try await f)
            await env.analytics.track("catalogue_viewed", ["screen": "discover"])
        } catch let e as APIError { error = e; featured = .failed(e) } catch {}
    }
}

/// Paginated catalogue list for a genre/mood/topic.
struct CatalogueListView: View {
    @Environment(AppEnvironment.self) private var env
    let title: String
    let genre: String?
    let mood: String?
    let topic: String?
    @State private var items: [Asset] = []
    @State private var cursor: String?
    @State private var state: LoadState<Bool> = .idle

    var body: some View {
        List {
            StateView(state, emptyMessage: "No audio here yet.", isEmpty: { _ in items.isEmpty }, retry: { Task { await load(reset: true) } }) { _ in
                ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                    Button { env.play(items, startAt: i) } label: { TrackRow(asset: a, isCurrent: env.player.current?.id == a.id) }
                        .buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
                        .onAppear { if a.id == items.last?.id, cursor != nil { Task { await load(reset: false) } } }
                }
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .navigationTitle(title)
        .toolbar {
            if !items.isEmpty {
                Button { env.play(items) } label: { Label("Play all", systemImage: "play.fill") }
            }
        }
        .vfScreen()
        .task { if items.isEmpty { await load(reset: true) } }
    }

    private func load(reset: Bool) async {
        if reset { state = .loading; cursor = nil }
        do {
            let page = try await env.api.catalogue(type: nil, genre: genre, mood: mood, topic: topic, mixable: false, cursor: reset ? nil : cursor)
            items = reset ? page.items : items + page.items
            cursor = page.nextCursor
            state = .loaded(true)
        } catch let e as APIError { if items.isEmpty { state = .failed(e) } } catch {}
    }
}

struct CollectionView: View {
    @Environment(AppEnvironment.self) private var env
    let collectionId: String
    @State private var state: LoadState<CatalogueCollection> = .idle
    var body: some View {
        ScrollView {
            StateView(state, retry: { Task { await load() } }) { c in
                VStack(alignment: .leading, spacing: VFSpacing.m) {
                    if let d = c.description { Text(d).foregroundStyle(VFColor.textSecondary) }
                    PrimaryButton("Play all", systemImage: "play.fill") { env.play(c.items ?? []) }
                    ForEach(Array((c.items ?? []).enumerated()), id: \.element.id) { i, a in
                        Button { env.play(c.items ?? [], startAt: i) } label: { TrackRow(asset: a) }.buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
                    }
                }
                .padding(VFSpacing.l)
            }
        }
        .navigationTitle(state.value?.title ?? "")
        .vfScreen()
        .task { await load() }
    }
    private func load() async {
        state = .loading
        do { state = .loaded(try await env.api.collection(collectionId)) } catch let e as APIError { state = .failed(e) } catch {}
    }
}

struct CreatorView: View {
    @Environment(AppEnvironment.self) private var env
    let creatorId: String
    @State private var state: LoadState<CreatorDetail> = .idle
    var body: some View {
        ScrollView {
            StateView(state, retry: { Task { await load() } }) { c in
                VStack(alignment: .leading, spacing: VFSpacing.m) {
                    Text(c.creatorType.capitalized).font(.caption.bold()).foregroundStyle(VFColor.secondary)
                    if let bio = c.bio { Text(bio).foregroundStyle(VFColor.textSecondary) }
                    if !c.shows.isEmpty {
                        SectionHeader("Series")
                        ForEach(c.shows) { s in NavigationLink(s.title, value: Route.show(s.id)) }
                    }
                    SectionHeader("Audio")
                    ForEach(Array(c.assets.enumerated()), id: \.element.id) { i, a in
                        Button { env.play(c.assets, startAt: i) } label: { TrackRow(asset: a) }.buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
                    }
                }.padding(VFSpacing.l)
            }
        }
        .navigationTitle(state.value?.name ?? "")
        .vfScreen()
        .task { await load() }
    }
    private func load() async {
        state = .loading
        do { state = .loaded(try await env.api.creator(creatorId)) } catch let e as APIError { state = .failed(e) } catch {}
    }
}

/// Asset detail: metadata, licence/attribution, rights-aware actions.
struct AssetDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let assetId: String
    @State private var state: LoadState<Asset> = .idle

    var body: some View {
        ScrollView {
            StateView(state, retry: { Task { await load() } }) { a in
                VStack(spacing: VFSpacing.l) {
                    ArtworkView(url: a.artwork, size: 240, seed: a.id)
                    Text(a.title).font(.title2.bold()).multilineTextAlignment(.center)
                    if let c = a.creator { NavigationLink(c.name, value: Route.creator(c.id)) } else { Text(a.creatorName).foregroundStyle(VFColor.textSecondary) }
                    HStack(spacing: VFSpacing.m) {
                        PrimaryButton("Play", systemImage: "play.fill") { env.play([a]) }
                        Button { Task { await env.library.toggleLike(a) } } label: {
                            Image(systemName: env.library.isLiked(a.id) ? "heart.fill" : "heart").font(.title2).frame(width: 50, height: 50)
                        }
                        .accessibilityLabel(env.library.isLiked(a.id) ? "Unlike" : "Like")
                        if a.capabilities.download && env.session == .account {
                            Button { Task { await env.downloads.download(a) } } label: {
                                Image(systemName: env.downloads.downloadedIds.contains(a.id) ? "checkmark.circle.fill" : (env.downloads.inFlight.contains(a.id) ? "hourglass" : "arrow.down.circle"))
                                    .font(.title2).frame(width: 50, height: 50)
                            }
                            .accessibilityLabel(env.downloads.downloadedIds.contains(a.id) ? "Downloaded" : "Download")
                        }
                    }
                    if let d = a.description { Text(d).font(.callout).foregroundStyle(VFColor.textSecondary) }
                    LicenceCard(asset: a)
                }
                .padding(VFSpacing.l)
            }
        }
        .vfScreen()
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        state = .loading
        do { state = .loaded(try await env.api.asset(assetId)) } catch let e as APIError { state = .failed(e) } catch {}
    }
}

struct LicenceCard: View {
    let asset: Asset
    var body: some View {
        VStack(alignment: .leading, spacing: VFSpacing.s) {
            Label("Licence & usage", systemImage: "checkmark.seal").font(.headline)
            if let l = asset.license {
                Text(l.type.replacingOccurrences(of: "_", with: " ").capitalized).font(.subheadline)
                if let att = l.attribution { Text(att).font(.caption).foregroundStyle(VFColor.textSecondary) }
                if let u = l.url, let url = URL(string: u) { Link("View licence", destination: url).font(.caption) }
            }
            HStack(spacing: VFSpacing.m) {
                cap("Stream", asset.capabilities.stream)
                cap("Download", asset.capabilities.download)
                cap("Mix", asset.capabilities.mix)
                cap("Export", asset.capabilities.render)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VFSpacing.m).background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.m))
    }
    private func cap(_ name: String, _ on: Bool) -> some View {
        Label(name, systemImage: on ? "checkmark.circle.fill" : "xmark.circle").font(.caption)
            .foregroundStyle(on ? VFColor.secondary : VFColor.textSecondary)
            .accessibilityLabel("\(name) \(on ? "allowed" : "not allowed")")
    }
}
