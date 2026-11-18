import SwiftUI
import VFCore
import VFDesignSystem

struct LibraryView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var newPlaylist = false
    @State private var newName = ""
    @State private var section = 0

    var body: some View {
        let snap = env.library.snapshot
        List {
            Picker("Section", selection: $section) { Text("Music").tag(0); Text("Spoken").tag(1); Text("Playlists").tag(2); Text("Mixes").tag(3) }
                .pickerStyle(.segmented).listRowBackground(Color.clear)
            Section {
                NavigationLink(value: Route.downloads) { Label("Downloads", systemImage: "arrow.down.circle") }
                NavigationLink(value: Route.history) { Label("Listening history", systemImage: "clock.arrow.circlepath") }
            }
            if env.session == .guest {
                Text("You're browsing as a guest. Create an account in Profile to sync your library across devices.").font(.callout).foregroundStyle(VFColor.textSecondary)
            }
            if let e = env.library.lastError, snap == nil { ErrorStateView(error: e) { Task { await env.library.refresh() } } }
            switch section {
            case 0: assets(snap?.likedMusic ?? [], empty: "Like a track to see it here.")
            case 1:
                assets(snap?.savedEpisodes ?? [], empty: "Saved speeches and episodes appear here.")
                if let shows = snap?.followedShows, !shows.isEmpty {
                    Section("Following") { ForEach(shows) { s in NavigationLink(s.title, value: Route.show(s.id)) } }
                }
            case 2:
                Section {
                    Button { newPlaylist = true } label: { Label("New playlist", systemImage: "plus") }
                    ForEach(snap?.playlists ?? []) { p in
                        NavigationLink(value: Route.playlist(p.id)) {
                            VStack(alignment: .leading) { Text(p.name); Text("\(p.itemCount ?? 0) items").font(.caption).foregroundStyle(VFColor.textSecondary) }
                        }
                    }
                }
            default:
                Section {
                    if (snap?.mixes ?? []).isEmpty { Text("Mixes you save in AI Studio appear here.").foregroundStyle(VFColor.textSecondary) }
                    ForEach(snap?.mixes ?? []) { m in
                        NavigationLink(value: Route.recipe(m.id)) {
                            HStack { Image(systemName: "wand.and.stars"); Text(m.name); Spacer(); Text(formatDuration(ms: m.durationMs)).font(.caption) }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Library")
        .vfScreen()
        .refreshable { await env.library.refresh() }
        .task { await env.library.refresh() }
        .alert("New playlist", isPresented: $newPlaylist) {
            TextField("Name", text: $newName)
            Button("Create") {
                let name = newName; newName = ""
                Task {
                    if (try? await env.api.createPlaylist(name: name.isEmpty ? "My playlist" : name, assetIds: [])) != nil {
                        await env.analytics.track("playlist_created")
                        await env.library.refresh()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder private func assets(_ items: [Asset], empty: LocalizedStringKey) -> some View {
        Section {
            if items.isEmpty { Text(empty).foregroundStyle(VFColor.textSecondary) }
            ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                Button { env.play(items, startAt: i) } label: { TrackRow(asset: a, isCurrent: env.player.current?.id == a.id) }
                    .buttonStyle(.plain).contextMenu { AssetMenu(asset: a) }
                    .swipeActions { Button(role: .destructive) { Task { await env.library.toggleLike(a); await env.library.refresh() } } label: { Label("Unlike", systemImage: "heart.slash") } }
            }
        }
    }
}

struct PlaylistDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let playlistId: String
    @State private var state: LoadState<Playlist> = .idle
    @State private var renaming = false
    @State private var newName = ""
    @State private var conflict: String?

    var body: some View {
        List {
            if let conflict { Label(conflict, systemImage: "arrow.triangle.2.circlepath").foregroundStyle(VFColor.accent) }
            StateView(state, emptyMessage: "This playlist is empty. Long-press any track to add it.", isEmpty: { $0.items.isEmpty }, retry: { Task { await load() } }) { p in
                Button { env.play(p.items.compactMap(\.asset)) } label: { Label("Play all", systemImage: "play.fill") }
                ForEach(p.items) { item in
                    if let a = item.asset {
                        Button { env.play(p.items.compactMap(\.asset), startAt: item.position) } label: { TrackRow(asset: a) }.buttonStyle(.plain)
                    }
                }
                .onMove { from, to in Task { await move(p, from: from, to: to) } }
                .onDelete { idx in Task { await delete(p, idx) } }
            }
        }
        .navigationTitle(state.value?.name ?? "Playlist")
        .toolbar {
            EditButton()
            Menu {
                Button("Rename") { newName = state.value?.name ?? ""; renaming = true }
                Button("Delete playlist", role: .destructive) { Task { try? await env.api.deletePlaylist(playlistId); await env.library.refresh() } }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .alert("Rename playlist", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Save") { Task { await mutate { try await env.api.renamePlaylist(playlistId, name: newName, version: $0.version) } } }
            Button("Cancel", role: .cancel) {}
        }
        .vfScreen()
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await env.api.playlist(playlistId)) } catch let e as APIError { state = .failed(e) } catch {}
    }

    /// Optimistic local change, server-authoritative result; on version conflict we reload instead of overwriting.
    private func mutate(_ op: (Playlist) async throws -> Playlist) async {
        guard let p = state.value else { return }
        do { state = .loaded(try await op(p)); conflict = nil; await env.library.refresh() } catch let e as APIError {
            if e.code == "VERSION_CONFLICT" { conflict = "Updated on another device — showing the latest version."; await load() } else { env.flash(e.message); await load() }
        } catch {}
    }

    private func move(_ p: Playlist, from: IndexSet, to: Int) async {
        var items = p.items
        items.move(fromOffsets: from, toOffset: to)
        var optimistic = p; optimistic.items = items
        state = .loaded(optimistic)
        await mutate { try await env.api.reorderPlaylist(playlistId, itemIds: items.map(\.id), version: $0.version) }
    }

    private func delete(_ p: Playlist, _ idx: IndexSet) async {
        for i in idx { let item = p.items[i]; await mutate { try await env.api.removeFromPlaylist(playlistId, itemId: item.id, version: $0.version) } }
    }
}

/// Adds an asset to an existing playlist (used from asset menus).
struct AddToPlaylistSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let asset: Asset
    var body: some View {
        NavigationStack {
            List(env.library.snapshot?.playlists ?? []) { p in
                Button(p.name) {
                    Task { _ = try? await env.api.addToPlaylist(p.id, assetId: asset.id, version: p.version); await env.library.refresh(); env.flash("Added to \(p.name)"); dismiss() }
                }
            }
            .navigationTitle("Add to playlist")
        }
    }
}

struct DownloadsView: View {
    @Environment(AppEnvironment.self) private var env
    var body: some View {
        let records = env.downloads.records()
        List {
            if records.isEmpty { EmptyStateView(message: "Downloads are available for audio whose licence allows offline listening.") }
            ForEach(records, id: \.assetId) { r in
                Button { env.play([r.asAsset]) } label: { TrackRow(asset: r.asAsset) }.buttonStyle(.plain)
                    .swipeActions { Button(role: .destructive) { env.downloads.remove(r.assetId) } label: { Label("Remove", systemImage: "trash") } }
            }
        }
        .navigationTitle("Downloads")
        .toolbar { if !records.isEmpty { Button("Remove all", role: .destructive) { env.downloads.removeAll() } } }
        .vfScreen()
    }
}

struct HistoryView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var state: LoadState<[RecentItem]> = .idle
    var body: some View {
        List {
            StateView(state, emptyMessage: "Nothing played yet.", isEmpty: { $0.isEmpty }, retry: { Task { await load() } }) { items in
                ForEach(items) { r in
                    Button { env.play([r.asset]) } label: {
                        VStack(alignment: .leading) {
                            TrackRow(asset: r.asset)
                            if !r.completed && r.positionMs > 0 {
                                ProgressView(value: Double(r.positionMs), total: Double(max(1, r.asset.durationMs))).tint(VFColor.secondary)
                            }
                        }
                    }.buttonStyle(.plain)
                }
            }
        }
        .navigationTitle("Recently played")
        .vfScreen()
        .task { await load() }
    }
    private func load() async {
        state = .loading
        do { state = .loaded(try await env.api.recent()) } catch let e as APIError { state = .failed(e) } catch {}
    }
}
