import SwiftUI
import VFCore
import VFDesignSystem

@MainActor
@Observable
final class HomeViewModel {
    var state: LoadState<HomeResponse> = .idle
    func load(_ env: AppEnvironment) async {
        if case .loaded = state {} else { state = .loading }
        do {
            state = .loaded(try await env.api.home())
            await env.analytics.track("catalogue_viewed", ["screen": "home"])
        } catch let e as APIError { if state.value == nil { state = .failed(e) } } catch {}
    }
}

struct HomeView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model = HomeViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.xl) {
                NavigationLink(value: Route.search) {
                    HStack {
                        Image(systemName: "magnifyingglass")
                        Text("Search music, podcasts, speeches").foregroundStyle(VFColor.textSecondary)
                        Spacer()
                    }
                    .padding(VFSpacing.m).background(VFColor.elevated, in: RoundedRectangle(cornerRadius: VFRadius.m))
                }
                .accessibilityLabel("Search")
                StateView(model.state, retry: { Task { await model.load(env) } }) { home in
                    VStack(alignment: .leading, spacing: VFSpacing.xl) {
                        ForEach(home.shelves) { shelf in ShelfView(shelf: shelf) }
                    }
                }
            }
            .padding(VFSpacing.l)
        }
        .refreshable { await model.load(env) }
        .navigationTitle(model.state.value?.greeting ?? "Home")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.profile) { Image(systemName: "person.crop.circle").font(.title3) }.accessibilityLabel("Profile and settings")
            }
        }
        .vfScreen()
        .task { await model.load(env) }
    }
}

struct ShelfView: View {
    @Environment(AppEnvironment.self) private var env
    let shelf: Shelf

    var body: some View {
        VStack(alignment: .leading, spacing: VFSpacing.m) {
            HStack {
                SectionHeader(shelf.title)
                Spacer()
                if shelf.id == "daily-motivation" { NavigationLink("Motivation hub", value: Route.motivation).font(.subheadline) }
            }
            switch shelf.items {
            case .assets(let assets):
                if shelf.id == "daily-motivation", let a = assets.first { FeaturedSpeechCard(asset: a) } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: VFSpacing.m) {
                            ForEach(Array(assets.enumerated()), id: \.element.id) { i, a in
                                Button { env.play(assets, startAt: i) } label: { ArtworkCard(title: a.title, subtitle: a.creatorName, artwork: a.artwork, seed: a.id) }
                                    .buttonStyle(.plain)
                                    .contextMenu { AssetMenu(asset: a) }
                                    .accessibilityHint("Plays \(a.title)")
                            }
                        }
                    }
                }
            case .shows(let shows):
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: VFSpacing.m) {
                        ForEach(shows) { s in
                            NavigationLink(value: Route.show(s.id)) { ArtworkCard(title: s.title, subtitle: s.creatorName, artwork: s.artwork, seed: s.id) }.buttonStyle(.plain)
                        }
                    }
                }
            case .topics(let tags):
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(tags) { t in
                            NavigationLink(value: Route.catalogue(title: t.name.capitalized, genre: t.id, mood: nil, topic: nil)) {
                                Text(t.name.capitalized).font(.subheadline.weight(.semibold)).padding(.horizontal, 16).frame(minHeight: 44)
                                    .background(VFColor.elevated, in: Capsule())
                            }.buttonStyle(.plain)
                        }
                    }
                }
            case .mixes(let mixes):
                ForEach(mixes) { m in
                    NavigationLink(value: Route.recipe(m.id)) {
                        HStack {
                            Image(systemName: "wand.and.stars").foregroundStyle(VFColor.primary)
                            Text(m.name)
                            Spacer()
                            Text(formatDuration(ms: m.durationMs)).foregroundStyle(VFColor.textSecondary).font(.caption)
                        }.frame(minHeight: 44)
                    }.buttonStyle(.plain)
                }
            }
        }
    }
}

struct FeaturedSpeechCard: View {
    @Environment(AppEnvironment.self) private var env
    let asset: Asset
    var body: some View {
        Button { env.play([asset]) } label: {
            HStack(spacing: VFSpacing.m) {
                ArtworkView(url: asset.artwork, size: 88, seed: asset.id)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Speech of the day").font(.caption.weight(.bold)).foregroundStyle(VFColor.accent)
                    Text(asset.title).font(.headline).lineLimit(2)
                    Text(asset.subtitle ?? asset.creatorName).font(.caption).foregroundStyle(VFColor.textSecondary).lineLimit(1)
                    Text(spokenDuration(ms: asset.durationMs)).font(.caption2).foregroundStyle(VFColor.textSecondary)
                }
                Spacer()
                Image(systemName: "play.circle.fill").font(.system(size: 40)).foregroundStyle(VFColor.primary)
            }
            .padding(VFSpacing.m).background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.l))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Speech of the day: \(asset.title). Double tap to play.")
    }
}

/// Shared long-press menu for any asset.
struct AssetMenu: View {
    @Environment(AppEnvironment.self) private var env
    let asset: Asset
    var body: some View {
        Button { env.player.enqueue(asset, next: true); env.flash("Playing next") } label: { Label("Play next", systemImage: "text.insert") }
        Button { env.player.enqueue(asset, next: false); env.flash("Added to queue") } label: { Label("Add to queue", systemImage: "text.append") }
        Button { Task { await env.library.toggleLike(asset) } } label: {
            env.library.isLiked(asset.id) ? Label("Remove from liked", systemImage: "heart.slash") : Label("Like", systemImage: "heart")
        }
        if env.session == .account || env.session == .guest {
            Button { env.playlistTarget = asset } label: { Label("Add to playlist", systemImage: "text.badge.plus") }
        }
        NavigationLink(value: Route.asset(asset.id)) { Label("Details & licence", systemImage: "info.circle") }
        if asset.capabilities.download && env.session == .account {
            Button { Task { await env.downloads.download(asset) } } label: { Label("Download", systemImage: "arrow.down.circle") }
        }
    }
}
