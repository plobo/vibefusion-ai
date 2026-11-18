import SwiftUI
import VFCore

// MARK: - Tokens (docs/ARCHITECTURE.md §Design system; mirrored in android core/designsystem)

public enum VFColor {
    public static let background = Color(red: 0.035, green: 0.039, blue: 0.063)      // #090A10
    public static let surface = Color(red: 0.075, green: 0.082, blue: 0.122)         // #13151F
    public static let elevated = Color(red: 0.118, green: 0.129, blue: 0.184)        // #1E212F
    public static let primary = Color(red: 0.486, green: 0.416, blue: 1.0)           // #7C6AFF
    public static let secondary = Color(red: 0.204, green: 0.827, blue: 0.769)       // #34D3C4
    public static let accent = Color(red: 1.0, green: 0.553, blue: 0.341)            // #FF8D57
    public static let destructive = Color(red: 1.0, green: 0.333, blue: 0.396)       // #FF5565
    public static let textPrimary = Color.white
    public static let textSecondary = Color.white.opacity(0.68)
    public static let divider = Color.white.opacity(0.08)
    public static let gradient = LinearGradient(colors: [primary.opacity(0.55), background], startPoint: .top, endPoint: .bottom)
    public static func role(_ r: LayerRole) -> Color {
        switch r { case .music: return primary; case .speech: return accent; case .ambience: return secondary; case .percussion: return .pink; case .effect: return .yellow }
    }
}

public enum VFSpacing { public static let xs: CGFloat = 4, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16, xl: CGFloat = 24, xxl: CGFloat = 32 }
public enum VFRadius { public static let s: CGFloat = 6, m: CGFloat = 12, l: CGFloat = 20 }
public enum VFSize {
    public static let artworkSmall: CGFloat = 48, artworkCard: CGFloat = 148, artworkHero: CGFloat = 300
    public static let controlPrimary: CGFloat = 72, controlSecondary: CGFloat = 44, minTouch: CGFloat = 44
}

public func formatDuration(ms: Int) -> String {
    let s = max(0, ms / 1000)
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

public func spokenDuration(ms: Int) -> String {
    let m = max(1, Int((Double(ms) / 60000).rounded()))
    return m >= 60 ? "\(m / 60) hr \(m % 60) min" : "\(m) min"
}

// MARK: - Components

public struct PrimaryButton: View {
    let title: LocalizedStringKey
    let systemImage: String?
    let isLoading: Bool
    let action: () -> Void
    public init(_ title: LocalizedStringKey, systemImage: String? = nil, isLoading: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.systemImage = systemImage; self.isLoading = isLoading; self.action = action
    }
    public var body: some View {
        Button(action: action) {
            HStack(spacing: VFSpacing.s) {
                if isLoading { ProgressView().tint(.white) } else if let systemImage { Image(systemName: systemImage) }
                Text(title).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(VFColor.primary, in: RoundedRectangle(cornerRadius: VFRadius.m))
            .foregroundStyle(.white)
        }
        .disabled(isLoading)
    }
}

public struct SecondaryButton: View {
    let title: LocalizedStringKey
    let systemImage: String?
    let action: () -> Void
    public init(_ title: LocalizedStringKey, systemImage: String? = nil, action: @escaping () -> Void) { self.title = title; self.systemImage = systemImage; self.action = action }
    public var body: some View {
        Button(action: action) {
            Label { Text(title) } icon: { if let systemImage { Image(systemName: systemImage) } }
                .frame(maxWidth: .infinity, minHeight: 46)
                .overlay(RoundedRectangle(cornerRadius: VFRadius.m).stroke(VFColor.textSecondary.opacity(0.5)))
                .foregroundStyle(VFColor.textPrimary)
        }
    }
}

public struct Chip: View {
    let label: String
    let selected: Bool
    let action: () -> Void
    public init(_ label: String, selected: Bool, action: @escaping () -> Void) { self.label = label; self.selected = selected; self.action = action }
    public var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if selected { Image(systemName: "checkmark").font(.caption.bold()) } // state not conveyed by colour alone
                Text(label.capitalized).font(.subheadline.weight(.medium))
            }
            .padding(.horizontal, 14).frame(minHeight: 36)
            .background(selected ? VFColor.primary : VFColor.elevated, in: Capsule())
            .foregroundStyle(.white)
        }
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

public struct ArtworkView: View {
    let url: URL?
    let size: CGFloat
    let seed: String
    public init(url: URL?, size: CGFloat, seed: String) { self.url = url; self.size = size; self.seed = seed }
    public var body: some View {
        AsyncImage(url: url, transaction: Transaction(animation: .easeInOut)) { phase in
            if case .success(let image) = phase { image.resizable().scaledToFill() } else { placeholder }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size > 100 ? VFRadius.m : VFRadius.s))
        .accessibilityHidden(true)
    }
    private var placeholder: some View {
        let hue = Double(abs(seed.hashValue % 360)) / 360
        return LinearGradient(colors: [Color(hue: hue, saturation: 0.6, brightness: 0.6), Color(hue: hue + 0.1, saturation: 0.7, brightness: 0.3)],
                              startPoint: .topLeading, endPoint: .bottomTrailing)
            .overlay(Image(systemName: "waveform").font(.system(size: size * 0.3)).foregroundStyle(.white.opacity(0.7)))
    }
}

public struct ArtworkCard: View {
    let title: String
    let subtitle: String?
    let artwork: URL?
    let seed: String
    public init(title: String, subtitle: String?, artwork: URL?, seed: String) { self.title = title; self.subtitle = subtitle; self.artwork = artwork; self.seed = seed }
    public var body: some View {
        VStack(alignment: .leading, spacing: VFSpacing.xs) {
            ArtworkView(url: artwork, size: VFSize.artworkCard, seed: seed)
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(2).foregroundStyle(VFColor.textPrimary)
            if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.caption).lineLimit(1).foregroundStyle(VFColor.textSecondary) }
        }
        .frame(width: VFSize.artworkCard, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

public struct TrackRow: View {
    let asset: Asset
    let isCurrent: Bool
    let trailing: AnyView?
    public init(asset: Asset, isCurrent: Bool = false, trailing: AnyView? = nil) { self.asset = asset; self.isCurrent = isCurrent; self.trailing = trailing }
    public var body: some View {
        HStack(spacing: VFSpacing.m) {
            ArtworkView(url: asset.artwork, size: VFSize.artworkSmall, seed: asset.id)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if isCurrent { Image(systemName: "speaker.wave.2.fill").foregroundStyle(VFColor.secondary).accessibilityLabel("Now playing") }
                    Text(asset.title).font(.body.weight(.medium)).lineLimit(1).foregroundStyle(VFColor.textPrimary)
                }
                HStack(spacing: 6) {
                    Text(asset.creatorName).lineLimit(1)
                    Text("·")
                    Text(asset.assetType.isSpoken ? spokenDuration(ms: asset.durationMs) : formatDuration(ms: asset.durationMs))
                    if asset.capabilities.mix { Image(systemName: "square.stack.3d.up").accessibilityLabel("Cleared for Fusion Studio") }
                    if asset.isExplicit { Image(systemName: "e.square").accessibilityLabel("Explicit") }
                }
                .font(.caption).foregroundStyle(VFColor.textSecondary)
            }
            Spacer(minLength: 0)
            if let trailing { trailing }
        }
        .frame(minHeight: VFSize.minTouch)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

public struct SectionHeader: View {
    let title: String
    public init(_ title: String) { self.title = title }
    public var body: some View {
        Text(title).font(.title3.bold()).foregroundStyle(VFColor.textPrimary).accessibilityAddTraits(.isHeader)
    }
}

public struct SearchField: View {
    @Binding var text: String
    let prompt: LocalizedStringKey
    public init(text: Binding<String>, prompt: LocalizedStringKey) { _text = text; self.prompt = prompt }
    public var body: some View {
        HStack {
            Image(systemName: "magnifyingglass").foregroundStyle(VFColor.textSecondary)
            TextField(prompt, text: $text).textFieldStyle(.plain).autocorrectionDisabled()
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Clear search").foregroundStyle(VFColor.textSecondary)
            }
        }
        .padding(VFSpacing.m)
        .background(VFColor.elevated, in: RoundedRectangle(cornerRadius: VFRadius.m))
    }
}

public enum LoadState<T> {
    case idle, loading, loaded(T), failed(APIError)
    public var value: T? { if case .loaded(let v) = self { return v } else { return nil } }
}

public struct StateView<T, Content: View>: View {
    let state: LoadState<T>
    let retry: () -> Void
    let emptyCheck: (T) -> Bool
    let emptyMessage: LocalizedStringKey
    @ViewBuilder let content: (T) -> Content
    public init(_ state: LoadState<T>, emptyMessage: LocalizedStringKey = "Nothing here yet", isEmpty: @escaping (T) -> Bool = { _ in false },
                retry: @escaping () -> Void, @ViewBuilder content: @escaping (T) -> Content) {
        self.state = state; self.retry = retry; self.emptyCheck = isEmpty; self.emptyMessage = emptyMessage; self.content = content
    }
    public var body: some View {
        switch state {
        case .idle, .loading:
            ProgressView().controlSize(.large).frame(maxWidth: .infinity, minHeight: 200).accessibilityLabel("Loading")
        case .failed(let e):
            ErrorStateView(error: e, retry: retry)
        case .loaded(let v):
            if emptyCheck(v) { EmptyStateView(message: emptyMessage) } else { content(v) }
        }
    }
}

public struct ErrorStateView: View {
    let error: APIError
    let retry: () -> Void
    public init(error: APIError, retry: @escaping () -> Void) { self.error = error; self.retry = retry }
    public var body: some View {
        VStack(spacing: VFSpacing.m) {
            Image(systemName: error.isOffline ? "wifi.slash" : "exclamationmark.triangle").font(.largeTitle).foregroundStyle(VFColor.accent)
            Text(error.message).multilineTextAlignment(.center).foregroundStyle(VFColor.textSecondary)
            if error.retryable || error.isOffline { Button("Try again", action: retry).buttonStyle(.borderedProminent).tint(VFColor.primary) }
        }
        .padding(VFSpacing.xl).frame(maxWidth: .infinity)
    }
}

public struct EmptyStateView: View {
    let message: LocalizedStringKey
    public init(message: LocalizedStringKey) { self.message = message }
    public var body: some View {
        VStack(spacing: VFSpacing.m) {
            Image(systemName: "music.note.list").font(.largeTitle).foregroundStyle(VFColor.textSecondary)
            Text(message).foregroundStyle(VFColor.textSecondary).multilineTextAlignment(.center)
        }
        .padding(VFSpacing.xl).frame(maxWidth: .infinity)
    }
}

/// Gain slider in dB with an accessible value ("−12 decibels").
public struct GainSlider: View {
    @Binding var gainDb: Double
    let label: String
    public init(gainDb: Binding<Double>, label: String) { _gainDb = gainDb; self.label = label }
    public var body: some View {
        HStack {
            Image(systemName: "speaker.fill").font(.caption).foregroundStyle(VFColor.textSecondary)
            Slider(value: $gainDb, in: -40...6, step: 1)
                .tint(VFColor.primary)
                .accessibilityLabel("\(label) volume")
                .accessibilityValue("\(Int(gainDb)) decibels")
            Text("\(Int(gainDb)) dB").font(.caption.monospacedDigit()).frame(width: 52, alignment: .trailing).foregroundStyle(VFColor.textSecondary)
        }
    }
}

/// One layer on the simplified timeline: a bar positioned by start/duration with fade ramps.
public struct LayerTimelineBar: View {
    let layer: MixLayer
    let sessionMs: Int
    let level: Double
    let title: String
    public init(layer: MixLayer, sessionMs: Int, level: Double, title: String) { self.layer = layer; self.sessionMs = sessionMs; self.level = level; self.title = title }
    public var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let x = w * CGFloat(layer.startMs) / CGFloat(max(1, sessionMs))
            let bw = max(4, w * CGFloat(layer.durationMs) / CGFloat(max(1, sessionMs)))
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4).fill(VFColor.elevated)
                RoundedRectangle(cornerRadius: 4)
                    .fill(VFColor.role(layer.role).opacity(layer.muted == true ? 0.25 : 0.4 + 0.6 * min(1, level * 3)))
                    .frame(width: bw).offset(x: x)
                    .overlay(alignment: .leading) {
                        Text(title).font(.caption2).lineLimit(1).padding(.horizontal, 4).offset(x: x).foregroundStyle(.white)
                    }
            }
        }
        .frame(height: 28)
        .accessibilityElement()
        .accessibilityLabel("\(layer.role.rawValue) layer \(title)")
        .accessibilityValue("starts at \(formatDuration(ms: layer.startMs)), lasts \(formatDuration(ms: layer.durationMs))\(layer.muted == true ? ", muted" : "")")
    }
}

public extension View {
    func vfScreen() -> some View {
        self.scrollContentBackground(.hidden).background(VFColor.background.ignoresSafeArea()).foregroundStyle(VFColor.textPrimary)
    }
}
