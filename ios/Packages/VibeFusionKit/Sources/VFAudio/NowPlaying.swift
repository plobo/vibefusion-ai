import Foundation
import MediaPlayer

/// Anything that can respond to lock-screen / headset / CarPlay-style remote commands.
@MainActor
public protocol RemoteControllable: AnyObject {
    func remotePlay()
    func remotePause()
    func remoteToggle()
    func remoteNext()
    func remotePrevious()
    func remoteSeek(toMs: Int)
    func remoteSkip(bySeconds: Double)
    var supportsSkipInterval: Bool { get }
}

/// Routes MPRemoteCommandCenter to whichever engine (standard or fusion) currently owns playback.
@MainActor
public final class RemoteCommandRouter {
    public static let shared = RemoteCommandRouter()
    public weak var target: RemoteControllable? { didSet { configureSkip() } }
    private var installed = false

    public func install() {
        guard !installed else { return }
        installed = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.target?.remotePlay(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.target?.remotePause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.target?.remoteToggle(); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.target?.remoteNext(); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.target?.remotePrevious(); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.target?.remoteSeek(toMs: Int(e.positionTime * 1000)); return .success
        }
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipForwardCommand.addTarget { [weak self] _ in self?.target?.remoteSkip(bySeconds: 30); return .success }
        c.skipBackwardCommand.addTarget { [weak self] _ in self?.target?.remoteSkip(bySeconds: -15); return .success }
        configureSkip()
    }

    private func configureSkip() {
        let c = MPRemoteCommandCenter.shared()
        let skip = target?.supportsSkipInterval ?? false
        c.skipForwardCommand.isEnabled = skip
        c.skipBackwardCommand.isEnabled = skip
        c.nextTrackCommand.isEnabled = !skip
        c.previousTrackCommand.isEnabled = !skip
    }

    public func update(title: String, artist: String?, durationMs: Int, positionMs: Int, rate: Float, artwork: UIImageLike? = nil) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyPlaybackDuration: Double(durationMs) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(positionMs) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: rate,
        ]
        if let artist { info[MPMediaItemPropertyArtist] = artist }
        #if os(iOS)
        if let img = artwork { info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img } }
        #endif
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    public func clear() { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
}

#if os(iOS)
import UIKit
public typealias UIImageLike = UIImage
#else
import AppKit
public typealias UIImageLike = NSImage
#endif
