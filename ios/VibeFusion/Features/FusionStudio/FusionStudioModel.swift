import Foundation
import Observation
import VFAudio
import VFCore

/// Editor state for one mix: the plan, server validation, preview playback and persistence.
@MainActor
@Observable
final class FusionStudioModel {
    enum Source: Hashable { case recipe(String), generated, manual }

    var plan: MixPlan
    var assets: [String: Asset] = [:]
    var prompt: String?
    var planner = "manual"
    var recipeId: String?
    var recipeVersion = 0
    var name: String
    var validation: PlanValidation?
    var blocked: [BlockedLayer] = []
    var warnings: [String] = []
    var message: String?
    var isBusy = false
    var isDirty = false
    var exportURL: URL?
    var exportAttribution: String?
    var renderProgress: Double?
    private var validateTask: Task<Void, Never>?
    private var preparedSignature: String?

    init(plan: MixPlan = MixPlan(title: "My fusion session", durationMs: 10 * 60_000, layers: [], ducking: Ducking(enabled: true))) {
        self.plan = plan
        name = plan.title
    }

    var localIssues: [String] { MixPlanLocalCheck.issues(plan) }
    var canExport: Bool { !plan.layers.isEmpty && plan.layers.allSatisfy { assets[$0.assetId]?.capabilities.render == true } && recipeId != nil }

    func title(for layer: MixLayer) -> String { assets[layer.assetId]?.title ?? "Unavailable audio" }

    func load(recipe id: String, env: AppEnvironment) async {
        isBusy = true; defer { isBusy = false }
        do {
            let r = try await env.api.recipe(id)
            plan = r.mixPlan; name = r.name; prompt = r.prompt; planner = r.planner
            recipeId = r.id; recipeVersion = r.version; validation = r.validation
            for a in r.assets ?? [] { assets[a.id] = a }
            isDirty = false
        } catch let e as APIError { message = e.message } catch {}
    }

    func adopt(_ response: FusionPlanResponse, prompt: String) {
        plan = response.plan
        name = response.plan.title
        self.prompt = prompt
        planner = response.provider
        warnings = response.warnings
        validation = response.validation
        for a in response.assets { assets[a.id] = a }
        recipeId = nil
        isDirty = true
    }

    // MARK: Editing

    func edit(_ env: AppEnvironment, _ change: (inout MixPlan) -> Void) {
        change(&plan)
        isDirty = true
        if env.fusion.plan != nil && preparedSignature == structureSignature() { env.fusion.update(plan: plan) }
        scheduleValidation(env)
    }

    func addLayer(_ asset: Asset, env: AppEnvironment) {
        assets[asset.id] = asset
        let role: LayerRole = asset.assetType.isSpoken ? .speech : (asset.genres.contains("ambient") && asset.tempoBpm == nil ? .ambience : .music)
        let id = "layer-\((plan.layers.compactMap { Int($0.id.replacingOccurrences(of: "layer-", with: "")) }.max() ?? 0) + 1)"
        let loopable = !asset.assetType.isSpoken
        let start = role == .speech ? max(0, plan.durationMs / 2 - min(asset.durationMs, plan.durationMs / 2) / 2) : 0
        let dur = loopable ? plan.durationMs - start : min(asset.durationMs, plan.durationMs - start)
        edit(env) { p in
            p.layers.append(MixLayer(id: id, assetId: asset.id, role: role, startMs: start, durationMs: max(1000, dur),
                                     gainDb: role == .speech ? 0 : -12, fadeInMs: role == .speech ? 1500 : 5000, fadeOutMs: role == .speech ? 2500 : 8000,
                                     loop: loopable && asset.durationMs < dur))
            if role == .speech && p.ducking == nil { p.ducking = Ducking(enabled: true) }
        }
    }

    func removeLayer(_ id: String, env: AppEnvironment) {
        edit(env) { p in
            p.layers.removeAll { $0.id == id }
            p.transitions?.removeAll { $0.fromLayerId == id || $0.toLayerId == id }
        }
    }

    /// Server is authoritative for schema and rights (e.g. rejects layers not cleared for mixing).
    func scheduleValidation(_ env: AppEnvironment) {
        validateTask?.cancel()
        let snapshot = plan
        validateTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            do {
                let v = try await env.api.validate(snapshot, requireExport: false)
                guard !Task.isCancelled else { return }
                validation = PlanValidation(schemaValid: v.schemaValid, valid: v.valid, rightsStatus: v.rightsStatus, errors: v.errors, warnings: v.warnings)
                for a in v.assets ?? [] { assets[a.id] = a }
                if !v.valid { await env.analytics.track("fusion_plan_rejected", ["layerCount": .int(snapshot.layers.count)]) }
            } catch {}
        }
    }

    func issues(for layerId: String) -> [ValidationIssue] { validation?.errors.filter { $0.layerId == layerId } ?? [] }

    // MARK: Preview

    private func structureSignature() -> String { plan.layers.map { "\($0.id):\($0.assetId)" }.sorted().joined(separator: ",") }

    func togglePreview(_ env: AppEnvironment) async {
        let engine = env.fusion
        if engine.isPlaying { engine.pause(); return }
        if engine.plan != nil && preparedSignature == structureSignature() {
            engine.update(plan: plan)
            engine.play()
            return
        }
        isBusy = true; defer { isBusy = false }
        message = nil
        do {
            let auth = recipeId != nil && !isDirty ? try await env.api.authorizeRecipe(recipeId!) : try await env.api.authorizePreview(plan)
            blocked = auth.blockedLayers
            if !auth.blockedLayers.isEmpty { message = "Some layers were removed for playback: " + auth.blockedLayers.map(\.message).joined(separator: " ") }
            var media: [String: URL] = [:]
            for (id, g) in auth.media { if let u = URL(string: g.url) { media[id] = u } }
            env.player.pause()
            try await engine.prepare(plan: auth.plan, media: media)
            preparedSignature = structureSignature()
            env.nowPlaying = .fusion
            engine.play()
            await env.analytics.track("fusion_preview_started", ["layerCount": .int(auth.plan.layers.count)])
        } catch let e as APIError {
            message = e.message
        } catch {
            message = "Preview couldn't start: \(error.localizedDescription)"
        }
    }

    // MARK: Persistence

    func save(_ env: AppEnvironment) async {
        guard env.session == .account || env.session == .guest else { return }
        isBusy = true; defer { isBusy = false }
        plan.title = name
        do {
            let r: MixRecipe
            if let id = recipeId { r = try await env.api.updateRecipe(id, name: name, plan: plan, version: recipeVersion) }
            else { r = try await env.api.saveRecipe(name: name, prompt: prompt, plan: plan, planner: planner) }
            recipeId = r.id; recipeVersion = r.version; plan = r.mixPlan
            if let v = r.validation { validation = v }
            isDirty = false
            message = r.rightsValidationStatus == "valid" ? "Saved." : "Saved, but some layers need attention before playback."
            await env.analytics.track("fusion_recipe_saved", ["layerCount": .int(plan.layers.count)])
        } catch let e as APIError {
            message = e.code == "VERSION_CONFLICT" ? "This mix changed on another device. Reopen it to get the latest version." : e.message
        } catch {}
    }

    /// Offline render on device — only when every layer's licence permits derivative renders.
    func export(_ env: AppEnvironment) async {
        guard let id = recipeId else { message = "Save the mix before exporting."; return }
        isBusy = true; defer { isBusy = false; renderProgress = nil }
        do {
            let auth = try await env.api.render(recipeId: id)
            let loader = FusionMediaLoader()
            var files: [String: URL] = [:]
            for g in auth.media { if let u = URL(string: g.url) { files[g.assetId] = try await loader.localFile(assetId: g.assetId, remote: u) } }
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Exports", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let safe = name.replacingOccurrences(of: "[^A-Za-z0-9 _-]", with: "", options: .regularExpression)
            let out = dir.appendingPathComponent("\(safe.isEmpty ? "Fusion" : safe).m4a")
            renderProgress = 0
            let plan = auth.plan
            try await Task.detached(priority: .userInitiated) {
                try FusionOfflineRenderer.render(plan: plan, files: files, to: out, attribution: auth.attribution) { p in
                    Task { @MainActor in self.renderProgress = p }
                }
            }.value
            if let att = auth.attribution { try? att.write(to: out.deletingPathExtension().appendingPathExtension("attribution.txt"), atomically: true, encoding: .utf8) }
            exportURL = out
            exportAttribution = auth.attribution
            try? await env.api.completeRender(jobId: auth.jobId, ok: true, error: nil)
            message = "Exported to Files › VibeFusion › Exports."
        } catch let e as APIError {
            message = e.message
        } catch {
            message = "Export failed: \(error.localizedDescription)"
        }
    }
}
