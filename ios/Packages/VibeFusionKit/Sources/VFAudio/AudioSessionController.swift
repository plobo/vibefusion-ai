import AVFoundation
import Foundation

/// Audio-session policy decisions, kept pure for tests.
public enum AudioSessionPolicy {
    public enum InterruptionAction: Equatable { case pause, resume, none }
    /// After an interruption ends, resume only if the system says we should and we were playing before.
    public static func onInterruptionEnded(shouldResume: Bool, wasPlaying: Bool) -> InterruptionAction {
        shouldResume && wasPlaying ? .resume : .none
    }
    /// Headphones/Bluetooth disconnected → pause (never blast audio from the speaker).
    public static func onRouteChange(reasonOldDeviceUnavailable: Bool) -> InterruptionAction {
        reasonOldDeviceUnavailable ? .pause : .none
    }
}

/// Configures AVAudioSession for background playback and forwards interruption / route / reset events.
public final class AudioSessionController: @unchecked Sendable {
    public static let shared = AudioSessionController()

    public var onInterruptionBegan: (() -> Void)?
    public var onInterruptionEnded: ((_ shouldResume: Bool) -> Void)?
    public var onOldRouteUnavailable: (() -> Void)?
    public var onMediaServicesReset: (() -> Void)?
    private var observers: [NSObjectProtocol] = []

    private init() {
        #if os(iOS)
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] n in
            guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began { self?.onInterruptionBegan?() } else {
                let opts = AVAudioSession.InterruptionOptions(rawValue: n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                self?.onInterruptionEnded?(opts.contains(.shouldResume))
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] n in
            let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            if AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable { self?.onOldRouteUnavailable?() }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
            self?.activate()
            self?.onMediaServicesReset?()
        })
        #endif
    }

    public func activate() {
        #if os(iOS)
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [])
            try s.setActive(true)
        } catch {
            // longFormAudio is unavailable on some configurations; fall back to a plain playback category.
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        #endif
    }
}
