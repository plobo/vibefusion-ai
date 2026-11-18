import SwiftUI
import VFCore
import VFDesignSystem

struct ProfileView: View {
    @Environment(AppEnvironment.self) private var env
    @AppStorage("vf.audioQuality") private var quality = "auto"
    @AppStorage("vf.dataSaver") private var dataSaver = false
    @AppStorage("vf.downloadOnWifiOnly") private var wifiOnly = true
    @AppStorage("vf.serverURL") private var serverURL = ""
    @State private var prefs = Preferences()
    @State private var confirmDelete = false
    @State private var exportFile: URL?
    @State private var upgradeEmail = ""
    @State private var upgradePassword = ""
    @State private var status: FusionStatus?

    var body: some View {
        Form {
            Section("Account") {
                if let u = env.user {
                    LabeledContent("Name", value: u.displayName)
                    LabeledContent("Account", value: u.isGuest ? "Guest" : (u.email ?? ""))
                    LabeledContent("Region", value: u.territory)
                    LabeledContent("Plan", value: "Free — all content is openly licensed")
                }
                if env.session == .guest {
                    TextField("Email", text: $upgradeEmail).textContentType(.emailAddress).textInputAutocapitalization(.never)
                    SecureField("Password", text: $upgradePassword)
                    Button("Create account and keep my library") {
                        Task { if let t = try? await env.api.upgrade(email: upgradeEmail, password: upgradePassword) { await env.signedIn(t) } else { env.flash("Couldn't create the account.") } }
                    }
                }
                Button("Sign out", role: .destructive) { Task { await env.signOut() } }
            }
            Section("Taste") {
                NavigationLink("Genres, moods & topics") { PreferencesEditor(prefs: $prefs) }
                Toggle("Allow explicit content", isOn: $prefs.explicitAllowed)
            }
            Section("Audio") {
                Picker("Streaming quality", selection: $quality) { Text("Automatic").tag("auto"); Text("High").tag("high"); Text("Data saver").tag("data_saver") }
                Toggle("Data saver", isOn: $dataSaver)
                Toggle("Download on Wi-Fi only", isOn: $wifiOnly)
                Button("Remove all downloads", role: .destructive) { env.downloads.removeAll() }
            }
            Section {
                Toggle("Share anonymous usage analytics", isOn: $prefs.analyticsOptIn)
                Toggle("Allow AI processing of my prompts", isOn: $prefs.aiProcessingConsent)
                if let s = status { Text(s.disclosure).font(.caption).foregroundStyle(VFColor.textSecondary) }
                Button("Export my data") { Task { await exportData() } }
                if let exportFile { ShareLink("Share export file", item: exportFile) }
                Button("Delete account and data", role: .destructive) { confirmDelete = true }
            } header: { Text("Privacy") } footer: {
                Text("Analytics use a pseudonymous ID and never include prompts, transcripts or your email.")
            }
            Section("About") {
                NavigationLink("Content licences & attributions") { LicencesView() }
                Link("Help & feedback", destination: URL(string: "mailto:support@vibefusion.app")!)
                Link("Terms of Service", destination: URL(string: "https://vibefusion.app/terms")!)
                Link("Privacy Policy", destination: URL(string: "https://vibefusion.app/privacy")!)
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
            }
            #if DEBUG
            Section("Developer") {
                TextField("Server URL (blank = \(AppConfig.defaultBaseURL.absoluteString))", text: $serverURL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("Restart the app after changing the server.").font(.caption)
            }
            #endif
        }
        .navigationTitle("Profile")
        .scrollContentBackground(.hidden).background(VFColor.background)
        .task { prefs = env.preferences; status = try? await env.api.fusionStatus() }
        .onChange(of: prefs) { _, p in Task { await env.savePreferences(p) } }
        .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete permanently", role: .destructive) {
                Task {
                    do { try await env.api.deleteAccount(); env.downloads.removeAll(); await env.signOut() } catch { env.flash("Couldn't delete the account. Try again.") }
                }
            }
        } message: { Text("Your library, playlists, mixes, bookmarks and history will be erased. This can't be undone.") }
    }

    private func exportData() async {
        guard let data = try? await env.api.exportData() else { env.flash("Export failed."); return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vibefusion-export.json")
        try? data.write(to: url)
        exportFile = url
    }
}

struct PreferencesEditor: View {
    @Binding var prefs: Preferences
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VFSpacing.l) {
                group("Genres", ["ambient", "electronic", "cinematic", "classical", "piano", "jazz", "chillout", "rock", "hip-hop", "world"], \.genres)
                group("Moods", ["calm", "uplifting", "energetic", "focus", "relaxed", "reflective"], \.moods)
                group("Speech topics", ["discipline", "confidence", "career", "resilience", "leadership", "fitness", "mindfulness"], \.speechTopics)
            }.padding()
        }
        .navigationTitle("Your taste")
        .vfScreen()
    }
    private func group(_ title: String, _ options: [String], _ kp: WritableKeyPath<Preferences, [String]>) -> some View {
        VStack(alignment: .leading) {
            Text(title).font(.headline)
            FlowLayout {
                ForEach(options, id: \.self) { o in
                    Chip(o, selected: prefs[keyPath: kp].contains(o)) {
                        if let i = prefs[keyPath: kp].firstIndex(of: o) { prefs[keyPath: kp].remove(at: i) } else { prefs[keyPath: kp].append(o) }
                    }
                }
            }
        }
    }
}

struct LicencesView: View {
    var body: some View {
        List {
            Section("Where our audio comes from") {
                Text("Music: Creative Commons (BY, BY-SA, BY-ND, CC0) and public-domain releases from Internet Archive netlabels. NonCommercial licences are excluded. BY-ND tracks can be streamed but never remixed.")
                Text("Speeches: public-domain LibriVox recordings of classic texts (e.g. James Allen, Emerson, Marcus Aurelius).")
                Text("Podcasts: streamed from each publisher's public RSS feed. Podcasts are never used in AI mixes.")
                Text("Sound Lab: synthetic loops generated by VibeFusion, used for testing and mixing.")
            }
            Section("Attribution") {
                Text("Each track's attribution is shown on its detail page and in the player, and is embedded alongside exported mixes.")
            }
            Section("Open-source software") {
                Text("Built with Apple frameworks: SwiftUI, AVFoundation, SwiftData.")
            }
        }
        .navigationTitle("Licences")
    }
}
