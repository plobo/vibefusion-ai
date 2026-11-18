import SwiftUI
import UserNotifications
import VFCore
import VFDesignSystem

struct OnboardingFlow: View {
    enum Step { case welcome, auth, interests, notifications, terms }
    @Environment(AppEnvironment.self) private var env
    @State private var step: Step
    init(startAt: Step = .welcome) { _step = State(initialValue: startAt) }

    var body: some View {
        ZStack {
            VFColor.gradient.ignoresSafeArea()
            switch step {
            case .welcome: WelcomeStep { step = .auth }
            case .auth: AuthStep { step = .interests }
            case .interests: InterestsStep { step = .notifications }
            case .notifications: NotificationStep { step = .terms }
            case .terms: TermsStep { env.onboarded = true }
            }
        }
        .foregroundStyle(VFColor.textPrimary)
        .animation(.easeInOut, value: step)
    }
}

private struct WelcomeStep: View {
    let next: () -> Void
    var body: some View {
        VStack(spacing: VFSpacing.xl) {
            Spacer()
            Image(systemName: "waveform.circle.fill").font(.system(size: 96)).foregroundStyle(VFColor.primary).accessibilityHidden(true)
            Text("VibeFusion AI").font(.largeTitle.bold())
            Text("Stream free, openly licensed music, podcasts and timeless motivational speeches — then fuse them into your own sessions with AI.")
                .multilineTextAlignment(.center).foregroundStyle(VFColor.textSecondary).padding(.horizontal)
            Spacer()
            PrimaryButton("Get started", action: next).padding(.horizontal, VFSpacing.xl)
        }
        .padding(.bottom, VFSpacing.xxl)
    }
}

private struct AuthStep: View {
    @Environment(AppEnvironment.self) private var env
    let next: () -> Void
    @State private var mode = 0
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(spacing: VFSpacing.l) {
                Text(mode == 0 ? "Create your account" : "Welcome back").font(.title.bold()).padding(.top, VFSpacing.xxl)
                Picker("Mode", selection: $mode) { Text("Create account").tag(0); Text("Sign in").tag(1) }.pickerStyle(.segmented)
                if mode == 0 { field("Display name", text: $name).textContentType(.name) }
                field("Email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                SecureField("Password (8+ characters)", text: $password).textContentType(mode == 0 ? .newPassword : .password)
                    .padding(VFSpacing.m).background(VFColor.elevated, in: RoundedRectangle(cornerRadius: VFRadius.m))
                if let error { Text(error).foregroundStyle(VFColor.destructive).font(.callout).accessibilityLabel("Error: \(error)") }
                PrimaryButton(mode == 0 ? "Create account" : "Sign in", isLoading: busy) { Task { await submit() } }
                Button("Continue as guest") { Task { await guest() } }.padding(.top, VFSpacing.s)
                Text("Guests can browse and stream. Create an account to sync your library, download, and save mixes.")
                    .font(.footnote).foregroundStyle(VFColor.textSecondary).multilineTextAlignment(.center)
            }
            .padding(VFSpacing.xl)
        }
    }

    private func field(_ title: LocalizedStringKey, text: Binding<String>) -> some View {
        TextField(title, text: text).autocorrectionDisabled().padding(VFSpacing.m).background(VFColor.elevated, in: RoundedRectangle(cornerRadius: VFRadius.m))
    }

    private func submit() async {
        busy = true; defer { busy = false }
        error = nil
        do {
            let t = mode == 0 ? try await env.api.register(email: email, password: password, displayName: name.isEmpty ? nil : name)
                              : try await env.api.login(email: email, password: password)
            await env.signedIn(t)
            if mode == 1 && env.onboarded { return }
            next()
        } catch let e as APIError { error = e.message } catch { self.error = "Something went wrong." }
    }

    private func guest() async {
        busy = true; defer { busy = false }
        do { await env.signedIn(try await env.api.guest()); next() } catch let e as APIError { error = e.message } catch {}
    }
}

private struct InterestsStep: View {
    @Environment(AppEnvironment.self) private var env
    let next: () -> Void
    @State private var genres: Set<String> = []
    @State private var moods: Set<String> = []
    @State private var topics: Set<String> = []
    let genreOptions = ["ambient", "electronic", "cinematic", "classical", "piano", "jazz", "chillout", "rock", "hip-hop", "world"]
    let moodOptions = ["calm", "uplifting", "energetic", "focus", "relaxed", "reflective"]
    let topicOptions = ["discipline", "confidence", "career", "resilience", "leadership", "fitness", "mindfulness"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                Text("What do you love?").font(.title.bold()).padding(.top, VFSpacing.xxl)
                Text("We'll tune Home and AI Studio to your taste. You can change this anytime.").foregroundStyle(VFColor.textSecondary)
                group("Genres", genreOptions, $genres)
                group("Moods", moodOptions, $moods)
                group("Speech topics", topicOptions, $topics)
                PrimaryButton("Continue") {
                    var p = env.preferences
                    p.genres = Array(genres); p.moods = Array(moods); p.speechTopics = Array(topics)
                    Task { await env.savePreferences(p) }
                    next()
                }
                Button("Skip", action: next).frame(maxWidth: .infinity)
            }
            .padding(VFSpacing.xl)
        }
    }

    private func group(_ title: LocalizedStringKey, _ options: [String], _ sel: Binding<Set<String>>) -> some View {
        VStack(alignment: .leading, spacing: VFSpacing.s) {
            Text(title).font(.headline)
            FlowLayout(spacing: 8) {
                ForEach(options, id: \.self) { o in
                    Chip(o, selected: sel.wrappedValue.contains(o)) {
                        if sel.wrappedValue.contains(o) { sel.wrappedValue.remove(o) } else { sel.wrappedValue.insert(o) }
                    }
                }
            }
        }
    }
}

private struct NotificationStep: View {
    let next: () -> Void
    var body: some View {
        VStack(spacing: VFSpacing.l) {
            Spacer()
            Image(systemName: "bell.badge").font(.system(size: 64)).foregroundStyle(VFColor.secondary).accessibilityHidden(true)
            Text("Daily motivation, on your terms").font(.title2.bold()).multilineTextAlignment(.center)
            Text("Get one gentle reminder a day when a new featured speech is ready. No marketing, ever.")
                .foregroundStyle(VFColor.textSecondary).multilineTextAlignment(.center)
            Spacer()
            PrimaryButton("Allow notifications") {
                Task {
                    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                    next()
                }
            }
            Button("Not now", action: next)
        }
        .padding(VFSpacing.xl)
    }
}

private struct TermsStep: View {
    let done: () -> Void
    @State private var accepted = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                Text("Before you start").font(.title.bold()).padding(.top, VFSpacing.xxl)
                Label("All audio is free and openly licensed: Creative Commons music from Internet Archive netlabels, public-domain LibriVox readings, and podcasts streamed from their publishers' public feeds.", systemImage: "checkmark.seal")
                Label("Availability depends on each licence and your region. Podcasts are stream/download only and can't be remixed.", systemImage: "globe")
                Label("AI Studio sends your prompt and catalogue metadata (never your audio or personal data) to plan a mix. Rendering happens on your device.", systemImage: "wand.and.stars")
                Label("You can export or delete your data anytime in Profile → Privacy.", systemImage: "lock.shield")
                Toggle("I agree to the Terms of Service and Privacy Policy", isOn: $accepted)
                PrimaryButton("Start listening") { if accepted { done() } }.opacity(accepted ? 1 : 0.5).disabled(!accepted)
            }
            .padding(VFSpacing.xl)
        }
    }
}

/// Wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > maxW, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing; rowH = max(rowH, sz.height)
        }
        return CGSize(width: maxW == .infinity ? x : maxW, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing; rowH = max(rowH, sz.height)
        }
    }
}
