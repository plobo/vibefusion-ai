import SwiftUI
import VFCore
import VFDesignSystem

struct RootView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        @Bindable var env = env
        Group {
            switch env.session {
            case .unknown:
                ZStack { VFColor.background.ignoresSafeArea(); ProgressView().controlSize(.large) }
            case .signedOut:
                OnboardingFlow()
            case .guest, .account:
                if env.onboarded { MainTabView() } else { OnboardingFlow(startAt: .interests) }
            }
        }
        .overlay(alignment: .top) {
            if let t = env.toast {
                Text(t).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                    .background(VFColor.elevated, in: Capsule()).padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.easeInOut, value: env.toast)
    }
}

enum AppTab: Hashable { case home, discover, studio, podcasts, library }

struct MainTabView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var tab: AppTab = .home

    var body: some View {
        @Bindable var env = env
        TabView(selection: $tab) {
            TabRoot { HomeView() }
                .tabItem { Label("Home", systemImage: "house.fill") }.tag(AppTab.home)
            TabRoot { DiscoverView() }
                .tabItem { Label("Discover", systemImage: "safari.fill") }.tag(AppTab.discover)
            TabRoot { StudioView() }
                .tabItem { Label("AI Studio", systemImage: "wand.and.stars") }.tag(AppTab.studio)
            TabRoot { PodcastsView() }
                .tabItem { Label("Podcasts", systemImage: "mic.fill") }.tag(AppTab.podcasts)
            TabRoot { LibraryView() }
                .tabItem { Label("Library", systemImage: "books.vertical.fill") }.tag(AppTab.library)
        }
        .sheet(isPresented: $env.fullPlayerPresented) { FullPlayerView().presentationDragIndicator(.visible) }
        .sheet(item: $env.playlistTarget) { a in AddToPlaylistSheet(asset: a).presentationDetents([.medium]) }
    }
}

/// Each tab has its own navigation stack and the persistent mini-player above the tab bar.
struct TabRoot<Content: View>: View {
    @Environment(AppEnvironment.self) private var env
    @ViewBuilder var content: () -> Content
    var body: some View {
        NavigationStack {
            content()
                .navigationDestination(for: Route.self) { RouteView(route: $0) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if env.nowPlaying != .none { MiniPlayerView().transition(.move(edge: .bottom)) }
        }
    }
}

/// Typed navigation routes shared by all tabs.
enum Route: Hashable {
    case asset(String), creator(String), collection(String), show(String), episode(String), playlist(String)
    case catalogue(title: String, genre: String?, mood: String?, topic: String?)
    case search, motivation, downloads, history, profile, recipe(String)
}

struct RouteView: View {
    let route: Route
    var body: some View {
        switch route {
        case .asset(let id): AssetDetailView(assetId: id)
        case .creator(let id): CreatorView(creatorId: id)
        case .collection(let id): CollectionView(collectionId: id)
        case .show(let id): ShowDetailView(showId: id)
        case .episode(let id): EpisodeDetailView(episodeId: id)
        case .playlist(let id): PlaylistDetailView(playlistId: id)
        case .catalogue(let title, let genre, let mood, let topic): CatalogueListView(title: title, genre: genre, mood: mood, topic: topic)
        case .search: SearchView()
        case .motivation: MotivationHubView()
        case .downloads: DownloadsView()
        case .history: HistoryView()
        case .profile: ProfileView()
        case .recipe(let id): MixEditorView(source: .recipe(id))
        }
    }
}
