import SwiftUI
import VFAudio
import VFCore
import VFDesignSystem

struct MixEditorView: View {
    enum Source { case recipe(String), model(FusionStudioModel) }
    @Environment(AppEnvironment.self) private var env
    let source: Source
    @State private var model = FusionStudioModel()
    @State private var loaded = false
    @State private var picker = false
    @State private var expanded: String?
    @State private var shareURL: URL?

    var body: some View {
        let engine = env.fusion
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                TextField("Mix name", text: $model.name).font(.title2.bold()).onChange(of: model.name) { _, _ in model.isDirty = true }
                if let p = model.prompt { Text("“\(p)”").font(.callout).foregroundStyle(VFColor.textSecondary).lineLimit(3) }
                transport(engine)
                if let m = model.message { Text(m).font(.callout).foregroundStyle(VFColor.accent) }
                ForEach(model.warnings, id: \.self) { w in Label(w, systemImage: "info.circle").font(.caption).foregroundStyle(VFColor.textSecondary) }
                validationSummary
                durationControl
                timeline(engine)
                ForEach(model.plan.layers) { layer in layerCard(layer) }
                SecondaryButton("Add layer", systemImage: "plus") { picker = true }
                    .disabled(model.plan.layers.count >= 6)
                duckingControls
                actions
            }
            .padding(VFSpacing.l)
        }
        .navigationTitle("Editor")
        .navigationBarTitleDisplayMode(.inline)
        .vfScreen()
        .sheet(isPresented: $picker) { AssetPickerView { a in model.addLayer(a, env: env) } }
        .task {
            guard !loaded else { return }
            loaded = true
            switch source {
            case .recipe(let id): await model.load(recipe: id, env: env)
            case .model(let m): model = m
            }
            model.scheduleValidation(env)
        }
        .onDisappear { if env.fusion.isPlaying == false { env.fusion.stop() } }
    }

    private func transport(_ engine: FusionPlaybackEngine) -> some View {
        let active = env.nowPlaying == .fusion && engine.plan != nil
        return VStack(spacing: VFSpacing.s) {
            HStack(spacing: VFSpacing.l) {
                Button { Task { await model.togglePreview(env) } } label: {
                    Image(systemName: active && engine.isPlaying ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 56))
                }
                .accessibilityLabel(active && engine.isPlaying ? "Pause preview" : "Preview mix")
                .disabled(model.plan.layers.isEmpty || model.isBusy)
                VStack(alignment: .leading) {
                    if case .preparing(let p) = engine.state { ProgressView(value: p) { Text("Loading layers…").font(.caption) } }
                    else if let rp = model.renderProgress { ProgressView(value: rp) { Text("Rendering…").font(.caption) } }
                    else {
                        Text(active ? "\(formatDuration(ms: Int(engine.positionMs))) / \(formatDuration(ms: model.plan.durationMs))" : formatDuration(ms: model.plan.durationMs))
                            .font(.headline.monospacedDigit())
                        if active && engine.duckActive { Label("Ducking for speech", systemImage: "waveform.path.badge.minus").font(.caption).foregroundStyle(VFColor.accent) }
                    }
                }
                Spacer()
                if model.isBusy { ProgressView() }
            }
            if active {
                Slider(value: Binding(get: { engine.positionMs }, set: { engine.seek(toMs: $0) }), in: 0...Double(max(1, model.plan.durationMs)))
                    .accessibilityLabel("Session position")
                    .accessibilityValue(formatDuration(ms: Int(engine.positionMs)))
            }
        }
        .padding(VFSpacing.m).background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.l))
    }

    @ViewBuilder private var validationSummary: some View {
        let local = model.localIssues
        if !local.isEmpty || !(model.validation?.errors.isEmpty ?? true) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(local, id: \.self) { Label($0, systemImage: "exclamationmark.circle").font(.caption) }
                ForEach(model.validation?.errors.filter { $0.layerId == nil } ?? [], id: \.self) { Label($0.message, systemImage: "exclamationmark.triangle").font(.caption) }
            }
            .foregroundStyle(VFColor.destructive)
        } else if model.validation?.valid == true {
            Label("Plan is valid and every layer is cleared for mixing.", systemImage: "checkmark.seal").font(.caption).foregroundStyle(VFColor.secondary)
        }
    }

    private var durationControl: some View {
        HStack {
            Text("Session length")
            Spacer()
            Stepper("\(model.plan.durationMs / 60_000) min", value: Binding(get: { model.plan.durationMs / 60_000 }, set: { v in
                model.edit(env) { $0.durationMs = max(1, v) * 60_000 }
            }), in: 1...120)
            .fixedSize()
        }
    }

    private func timeline(_ engine: FusionPlaybackEngine) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader("Timeline")
            ZStack(alignment: .leading) {
                VStack(spacing: 6) {
                    ForEach(model.plan.layers) { l in
                        LayerTimelineBar(layer: l, sessionMs: model.plan.durationMs, level: engine.levels[l.id] ?? 0, title: model.title(for: l))
                    }
                }
                if env.nowPlaying == .fusion && engine.plan != nil {
                    GeometryReader { geo in
                        Rectangle().fill(.white).frame(width: 2)
                            .offset(x: geo.size.width * CGFloat(engine.positionMs / Double(max(1, model.plan.durationMs))))
                    }
                    .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
        }
    }

    private func layerCard(_ layer: MixLayer) -> some View {
        let idx = model.plan.layers.firstIndex { $0.id == layer.id }!
        let binding = Binding<MixLayer>(get: { model.plan.layers[safeIndex: idx] ?? layer }, set: { nv in model.edit(env) { p in if p.layers.indices.contains(idx) { p.layers[idx] = nv } } })
        let issues = model.issues(for: layer.id)
        let asset = model.assets[layer.assetId]
        return VStack(alignment: .leading, spacing: VFSpacing.s) {
            HStack {
                Circle().fill(VFColor.role(layer.role)).frame(width: 10, height: 10).accessibilityHidden(true)
                VStack(alignment: .leading) {
                    Text(model.title(for: layer)).font(.headline).lineLimit(1)
                    Text(layer.role.rawValue.capitalized + (layer.loop ? " · loop" : "")).font(.caption).foregroundStyle(VFColor.textSecondary)
                }
                Spacer()
                Button { binding.wrappedValue.muted = !(layer.muted ?? false) } label: { Text("M").bold().frame(width: 36, height: 36).background((layer.muted ?? false) ? VFColor.destructive : VFColor.elevated, in: Circle()) }
                    .accessibilityLabel("Mute").accessibilityValue((layer.muted ?? false) ? "On" : "Off")
                Button { binding.wrappedValue.solo = !(layer.solo ?? false) } label: { Text("S").bold().frame(width: 36, height: 36).background((layer.solo ?? false) ? VFColor.secondary : VFColor.elevated, in: Circle()) }
                    .accessibilityLabel("Solo").accessibilityValue((layer.solo ?? false) ? "On" : "Off")
                Button { withAnimation { expanded = expanded == layer.id ? nil : layer.id } } label: { Image(systemName: expanded == layer.id ? "chevron.up" : "slider.horizontal.3").frame(width: 36, height: 36) }
                    .accessibilityLabel("Layer settings")
            }
            GainSlider(gainDb: binding.gainDb, label: model.title(for: layer))
            ForEach(issues, id: \.self) { i in Label(i.message, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(VFColor.destructive) }
            if expanded == layer.id {
                msStepper("Starts at", binding.startMs, step: 5000, max: model.plan.durationMs - 1000)
                msStepper("Length", binding.durationMs, step: 5000, max: model.plan.durationMs)
                msStepper("Source offset", binding.sourceInMs, step: 1000, max: max(0, (asset?.durationMs ?? 0) - 1000))
                msStepper("Fade in", binding.fadeInMs, step: 500, max: 60_000)
                msStepper("Fade out", binding.fadeOutMs, step: 500, max: 60_000)
                Toggle("Loop", isOn: binding.loop)
                HStack { Text("Pan"); Slider(value: binding.pan, in: -1...1, step: 0.1).accessibilityLabel("Pan").accessibilityValue(String(format: "%.1f", layer.pan)) }
                Picker("Role", selection: binding.role) { ForEach(LayerRole.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                Button(role: .destructive) { model.removeLayer(layer.id, env: env) } label: { Label("Remove layer", systemImage: "trash") }
            }
        }
        .padding(VFSpacing.m)
        .background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.m))
        .overlay(RoundedRectangle(cornerRadius: VFRadius.m).stroke(issues.isEmpty ? .clear : VFColor.destructive, lineWidth: 1))
    }

    private func msStepper(_ label: String, _ value: Binding<Int>, step: Int, max: Int) -> some View {
        Stepper(value: value, in: 0...Swift.max(0, max), step: step) {
            HStack { Text(label); Spacer(); Text(formatDuration(ms: value.wrappedValue)).monospacedDigit().foregroundStyle(VFColor.textSecondary) }
        }
    }

    private var duckingControls: some View {
        VStack(alignment: .leading, spacing: VFSpacing.s) {
            Toggle("Duck music under speech", isOn: Binding(get: { model.plan.ducking?.enabled ?? false }, set: { on in
                model.edit(env) { p in if p.ducking == nil { p.ducking = Ducking(enabled: on) } else { p.ducking!.enabled = on } }
            }))
            if model.plan.ducking?.enabled == true {
                HStack {
                    Text("Amount")
                    Slider(value: Binding(get: { model.plan.ducking?.amountDb ?? 9 }, set: { v in model.edit(env) { $0.ducking?.amountDb = v } }), in: 3...18, step: 1)
                        .accessibilityLabel("Ducking amount").accessibilityValue("\(Int(model.plan.ducking?.amountDb ?? 9)) decibels")
                    Text("\(Int(model.plan.ducking?.amountDb ?? 9)) dB").font(.caption.monospacedDigit())
                }
            }
        }
        .padding(VFSpacing.m).background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.m))
    }

    private var actions: some View {
        VStack(spacing: VFSpacing.m) {
            PrimaryButton(model.recipeId == nil ? "Save recipe" : "Save changes", systemImage: "tray.and.arrow.down", isLoading: model.isBusy) { Task { await model.save(env) } }
                .disabled(!model.localIssues.isEmpty)
            if model.canExport && env.session == .account {
                SecondaryButton("Export audio (on device)", systemImage: "square.and.arrow.down") { Task { await model.export(env) } }
            } else if model.recipeId != nil {
                Text("Export is available only when every layer is licensed for rendered derivatives.").font(.caption).foregroundStyle(VFColor.textSecondary)
            }
            if let url = model.exportURL {
                ShareLink(item: url) { Label("Open exported file", systemImage: "doc.richtext") }
                if let att = model.exportAttribution { Text(att).font(.caption2).foregroundStyle(VFColor.textSecondary) }
            }
            if model.recipeId != nil && env.session == .account && model.validation?.valid == true {
                Button {
                    Task { if let id = model.recipeId, let s = try? await env.api.share(recipeId: id) { shareURL = URL(string: s.url) } }
                } label: { Label("Create share link (recipe only)", systemImage: "link") }
                if let shareURL { ShareLink(item: shareURL) }
            }
        }
    }
}

extension Array {
    subscript(safeIndex i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// Picks layer sources. Shows mix-cleared audio first; anything else is rejected by server validation with an explanation.
struct AssetPickerView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onPick: (Asset) -> Void
    @State private var mixableOnly = true
    @State private var query = ""
    @State private var state: LoadState<[Asset]> = .idle

    var body: some View {
        NavigationStack {
            List {
                Toggle("Only audio cleared for mixing", isOn: $mixableOnly)
                StateView(state, emptyMessage: "No matching audio.", isEmpty: { $0.isEmpty }, retry: { Task { await load() } }) { items in
                    ForEach(items) { a in
                        Button { onPick(a); dismiss() } label: {
                            TrackRow(asset: a, trailing: a.capabilities.mix ? nil : AnyView(Text("Not cleared").font(.caption2).foregroundStyle(VFColor.accent)))
                        }.buttonStyle(.plain)
                    }
                }
            }
            .searchable(text: $query)
            .navigationTitle("Add a layer")
            .toolbar { Button("Close") { dismiss() } }
            .task { await load() }
            .onChange(of: mixableOnly) { _, _ in Task { await load() } }
            .onSubmit(of: .search) { Task { await load() } }
        }
    }

    private func load() async {
        state = .loading
        do {
            if query.count >= 2 {
                let r = try await env.api.search(query, filters: SearchFilters())
                let all = r.tracks + r.speeches + r.episodes
                state = .loaded(mixableOnly ? all.filter(\.capabilities.mix) : all)
            } else {
                let p = try await env.api.catalogue(type: "loop,stem,music,speech", genre: nil, mood: nil, topic: nil, mixable: mixableOnly, cursor: nil)
                state = .loaded(p.items)
            }
        } catch let e as APIError { state = .failed(e) } catch {}
    }
}
