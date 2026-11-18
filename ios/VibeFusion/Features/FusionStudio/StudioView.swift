import SwiftUI
import VFCore
import VFDesignSystem

struct StudioView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var prompt = ""
    @State private var minutes = 15.0
    @State private var mood = "uplifting"
    @State private var energy = "gradual_build"
    @State private var genres: Set<String> = ["cinematic", "electronic"]
    @State private var includeSpeech = true
    @State private var speechTopic = "resilience"
    @State private var status: FusionStatus?
    @State private var busy = false
    @State private var error: String?
    @State private var editor: FusionStudioModel?
    @State private var recipes: [MixRecipe] = []

    let examples = [
        "Create a 20-minute uplifting session that begins with calm piano, gradually introduces cinematic strings and electronic percussion, and includes a motivational speech near the middle.",
        "A calm 10-minute focus bed with soft ambient pads and gentle rain.",
        "An energetic 15-minute workout mix with a short pep talk about discipline.",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                if let s = status, !s.aiAvailable {
                    Label("AI planning is running in offline mode (deterministic planner). Manual mixing and playback work as normal.", systemImage: "info.circle")
                        .font(.callout).padding(VFSpacing.m).background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.m))
                }
                composer
                options
                if let error { Text(error).foregroundStyle(VFColor.destructive).font(.callout) }
                PrimaryButton("Generate mix plan", systemImage: "wand.and.stars", isLoading: busy) { Task { await generate() } }
                    .disabled(prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                SecondaryButton("Build manually", systemImage: "slider.horizontal.3") {
                    editor = FusionStudioModel(plan: MixPlan(title: "My fusion session", durationMs: Int(minutes) * 60_000, layers: [], ducking: Ducking(enabled: true)))
                }
                if !recipes.isEmpty {
                    SectionHeader("Saved mixes")
                    ForEach(recipes) { r in
                        NavigationLink(value: Route.recipe(r.id)) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(r.name).font(.headline)
                                    Text("\(formatDuration(ms: r.durationMs)) · \(r.mixPlan.layers.count) layers").font(.caption).foregroundStyle(VFColor.textSecondary)
                                }
                                Spacer()
                                if r.rightsValidationStatus != "valid" { Image(systemName: "exclamationmark.triangle").foregroundStyle(VFColor.accent).accessibilityLabel("Needs attention") }
                            }.frame(minHeight: 44)
                        }.buttonStyle(.plain)
                    }
                }
                if let d = status?.disclosure { Text(d).font(.caption).foregroundStyle(VFColor.textSecondary) }
            }
            .padding(VFSpacing.l)
        }
        .navigationTitle("AI Studio")
        .vfScreen()
        .navigationDestination(item: $editor) { m in MixEditorView(source: .model(m)) }
        .task {
            status = try? await env.api.fusionStatus()
            recipes = (try? await env.api.recipes()) ?? recipes
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: VFSpacing.s) {
            Text("Describe your session").font(.headline)
            TextEditor(text: $prompt)
                .frame(minHeight: 110).padding(8).scrollContentBackground(.hidden)
                .background(VFColor.elevated, in: RoundedRectangle(cornerRadius: VFRadius.m))
                .accessibilityLabel("Mix prompt")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(examples, id: \.self) { e in
                        Button {
                            prompt = e
                            if let r = e.range(of: #"(\d+)-minute"#, options: .regularExpression), let m = Double(e[r].dropLast(7)) { minutes = m }
                        } label: { Text(e).font(.caption).lineLimit(2).frame(width: 220, alignment: .leading).padding(8).background(VFColor.surface, in: RoundedRectangle(cornerRadius: 8)) }
                            .buttonStyle(.plain).accessibilityLabel("Use example: \(e)")
                    }
                }
            }
        }
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: VFSpacing.m) {
            HStack { Text("Duration"); Spacer(); Text("\(Int(minutes)) min").monospacedDigit() }
            Slider(value: $minutes, in: 1...60, step: 1).accessibilityLabel("Session duration").accessibilityValue("\(Int(minutes)) minutes")
            Picker("Mood", selection: $mood) { ForEach(["uplifting", "calm", "energetic", "focus", "relaxed"], id: \.self) { Text($0.capitalized).tag($0) } }
            Picker("Energy curve", selection: $energy) {
                Text("Gradual build").tag("gradual_build"); Text("Steady").tag("steady"); Text("Wind down").tag("wind_down"); Text("Peak in middle").tag("peak_middle")
            }
            Text("Genres & instruments").font(.subheadline.weight(.semibold))
            FlowLayout {
                ForEach(["ambient", "cinematic", "electronic", "classical", "piano", "jazz", "chillout", "world"], id: \.self) { g in
                    Chip(g, selected: genres.contains(g)) { if genres.contains(g) { genres.remove(g) } else { genres.insert(g) } }
                }
            }
            Toggle("Include a speech", isOn: $includeSpeech)
            if includeSpeech {
                Picker("Speech topic", selection: $speechTopic) {
                    ForEach(["resilience", "discipline", "confidence", "career", "leadership", "fitness", "mindfulness"], id: \.self) { Text($0.capitalized).tag($0) }
                }
                Text("Speeches come from public-domain readings. Voice cloning of real people is never used.").font(.caption).foregroundStyle(VFColor.textSecondary)
            }
        }
        .padding(VFSpacing.m).background(VFColor.surface, in: RoundedRectangle(cornerRadius: VFRadius.m))
    }

    private func generate() async {
        busy = true; defer { busy = false }
        error = nil
        await env.analytics.track("fusion_prompt_submitted")
        let req = FusionRequest(prompt: prompt, targetDurationMs: Int(minutes) * 60_000, mood: mood, energyCurve: energy, genres: Array(genres).sorted(),
                                includeSpeech: includeSpeech, speechTopic: includeSpeech ? speechTopic : nil, constraints: .init(maxLayers: 4, allowLoops: true))
        do {
            let r = try await env.api.plan(req)
            let m = FusionStudioModel()
            m.adopt(r, prompt: prompt)
            editor = m
            await env.analytics.track("fusion_plan_generated", ["provider": .string(r.provider), "layerCount": .int(r.plan.layers.count)])
        } catch let e as APIError {
            // AI failure never blocks manual mixing (Scenario F).
            error = e.code == "AI_UNAVAILABLE" || e.code == "QUOTA_EXCEEDED" ? "\(e.message) You can still build a mix manually." : e.message
        } catch {}
    }
}

extension FusionStudioModel: Hashable {
    nonisolated static func == (a: FusionStudioModel, b: FusionStudioModel) -> Bool { a === b }
    nonisolated func hash(into h: inout Hasher) { h.combine(ObjectIdentifier(self)) }
}
