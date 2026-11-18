import SwiftUI
import VFCore
import VFDesignSystem

@MainActor
@Observable
final class SearchViewModel {
    var query = ""
    var filters = SearchFilters()
    var state: LoadState<SearchResults> = .idle
    private var task: Task<Void, Never>?

    /// Debounced (300 ms) and cancellable: each keystroke cancels the in-flight request.
    func schedule(_ env: AppEnvironment) {
        task?.cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { state = .idle; return }
        let filters = self.filters
        task = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            state = .loading
            do {
                let r = try await env.api.search(q, filters: filters)
                guard !Task.isCancelled else { return }
                state = .loaded(r)
                await env.analytics.track("search_performed", ["resultCount": .int(r.tracks.count + r.episodes.count + r.speeches.count)])
            } catch is CancellationError {
            } catch let e as APIError { if !Task.isCancelled { state = .failed(e) } } catch {}
        }
    }
}

struct SearchView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model = SearchViewModel()
    @State private var showFilters = false

    var body: some View {
        List {
            Section {
                switch model.state {
                case .idle: Text("Search free music, podcasts, shows, artists and motivational speeches.").foregroundStyle(VFColor.textSecondary)
                default:
                    StateView(model.state, emptyMessage: "No results. Try another word or remove filters.", isEmpty: { $0.isEmpty }, retry: { model.schedule(env) }) { r in
                        group("Tracks", r.tracks)
                        group("Speeches", r.speeches)
                        group("Episodes", r.episodes)
                        if !r.shows.isEmpty {
                            Text("Shows").font(.headline)
                            ForEach(r.shows) { s in NavigationLink(value: Route.show(s.id)) { Label(s.title, systemImage: "mic") } }
                        }
                        if !r.artists.isEmpty {
                            Text("Artists & speakers").font(.headline)
                            ForEach(r.artists) { a in NavigationLink(value: Route.creator(a.id)) { Label(a.name, systemImage: "person") } }
                        }
                        if !r.albums.isEmpty {
                            Text("Albums").font(.headline)
                            ForEach(r.albums) { a in Label(a.title, systemImage: "square.stack") }
                        }
                    }
                }
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Artists, songs, episodes, speeches")
        .onChange(of: model.query) { _, _ in model.schedule(env) }
        .onChange(of: model.filters) { _, _ in model.schedule(env) }
        .toolbar { Button { showFilters = true } label: { Image(systemName: "line.3.horizontal.decrease.circle") }.accessibilityLabel("Filters") }
        .sheet(isPresented: $showFilters) { SearchFiltersSheet(filters: $model.filters).presentationDetents([.medium]) }
        .navigationTitle("Search")
        .vfScreen()
    }

    @ViewBuilder private func group(_ title: String, _ items: [Asset]) -> some View {
        if !items.isEmpty {
            Text(title).font(.headline)
            ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                Button { env.play(items, startAt: i) } label: { TrackRow(asset: a) }.buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
            }
        }
    }
}

struct SearchFiltersSheet: View {
    @Binding var filters: SearchFilters
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Picker("Content", selection: $filters.content) {
                    Text("All").tag(SearchFilters.Content.all); Text("Music").tag(SearchFilters.Content.music); Text("Spoken").tag(SearchFilters.Content.spoken)
                }
                Picker("Max duration", selection: $filters.maxDurationMinutes) {
                    Text("Any").tag(Int?.none); Text("5 min").tag(Int?.some(5)); Text("15 min").tag(Int?.some(15)); Text("30 min").tag(Int?.some(30)); Text("60 min").tag(Int?.some(60))
                }
                Picker("Genre", selection: $filters.genre) {
                    Text("Any").tag(String?.none)
                    ForEach(["ambient", "electronic", "cinematic", "classical", "piano", "jazz", "rock", "world"], id: \.self) { Text($0.capitalized).tag(String?.some($0)) }
                }
                Picker("Mood", selection: $filters.mood) {
                    Text("Any").tag(String?.none)
                    ForEach(["calm", "uplifting", "energetic", "focus", "relaxed"], id: \.self) { Text($0.capitalized).tag(String?.some($0)) }
                }
                Picker("Language", selection: $filters.language) {
                    Text("Any").tag(String?.none); Text("English").tag(String?.some("en")); Text("Français").tag(String?.some("fr"))
                }
                Button("Reset filters") { filters = SearchFilters() }
            }
            .navigationTitle("Filters")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
