import SwiftUI
import VFCore
import VFDesignSystem

@main
struct VibeFusionApp: App {
    @State private var env = AppEnvironment()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(env)
                .modelContainer(env.container)
                .preferredColorScheme(.dark)
                .tint(VFColor.primary)
                .task { await env.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task { await env.library.refresh(); await env.backend.flushPendingProgress() }
                    case .background:
                        Task { await env.analytics.flush() }
                    default: break
                    }
                }
                .onOpenURL { url in DeepLinks.handle(url, env: env) }
        }
    }
}

/// Shareable timestamp links: vibefusion://listen/<assetId>?t=<seconds>
enum DeepLinks {
    @MainActor
    static func handle(_ url: URL, env: AppEnvironment) {
        guard url.host == "listen" || url.pathComponents.contains("listen") else { return }
        let id = url.lastPathComponent
        let t = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "t" }?.value.flatMap(Int.init) ?? 0
        Task {
            guard let asset = try? await env.api.asset(id) else { return }
            env.play([asset])
            try? await Task.sleep(nanoseconds: 800_000_000)
            env.player.seek(toMs: t * 1000)
            env.fullPlayerPresented = true
        }
    }
}
