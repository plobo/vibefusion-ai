import Foundation
import SwiftData
import Observation

/// A licensed offline copy. Only created when the server authorizes `offline_download` for the asset.
@Model
public final class DownloadRecord {
    @Attribute(.unique) public var assetId: String
    public var title: String
    public var subtitle: String?
    public var artworkUrl: String?
    public var assetType: String
    public var durationMs: Int
    public var fileName: String
    public var downloadedAt: Date

    public init(asset: Asset, fileName: String) {
        assetId = asset.id; title = asset.title; subtitle = asset.creatorName; artworkUrl = asset.artworkUrl
        assetType = asset.assetType.rawValue; durationMs = asset.durationMs; self.fileName = fileName; downloadedAt = Date()
    }

    public var asAsset: Asset {
        var a = Asset(id: assetId, title: title, assetType: AssetType(rawValue: assetType) ?? .music, durationMs: durationMs,
                      capabilities: Capabilities(stream: true, download: true), subtitle: subtitle, artworkUrl: artworkUrl)
        a.isActive = true
        return a
    }
}

/// Offline outbox for playback progress so resume works after connectivity returns.
@Model
public final class PendingProgress {
    @Attribute(.unique) public var assetId: String
    public var positionMs: Int
    public var durationMs: Int
    public var updatedAt: Date
    public init(assetId: String, positionMs: Int, durationMs: Int) {
        self.assetId = assetId; self.positionMs = positionMs; self.durationMs = durationMs; updatedAt = Date()
    }
}

public enum VFPersistence {
    public static func makeContainer(inMemory: Bool = false) throws -> ModelContainer {
        let config = ModelConfiguration(isStoredInMemoryOnly: inMemory)
        return try ModelContainer(for: DownloadRecord.self, PendingProgress.self, configurations: config)
    }
}

/// Licence-gated downloads stored in Application Support (excluded from backup).
@MainActor
@Observable
public final class DownloadManager {
    public private(set) var inFlight: Set<String> = []
    public private(set) var downloadedIds: Set<String> = []
    public var lastError: APIError?
    private let api: VibeFusionAPIProtocol
    private let context: ModelContext
    private let dir: URL
    private let session: URLSession

    public init(api: VibeFusionAPIProtocol, context: ModelContext, session: URLSession = .shared) {
        self.api = api
        self.context = context
        self.session = session
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutable = base; try? mutable.setResourceValues(values)
        dir = base
        downloadedIds = Set(records().map(\.assetId))
    }

    public func records() -> [DownloadRecord] {
        (try? context.fetch(FetchDescriptor<DownloadRecord>(sortBy: [SortDescriptor(\.downloadedAt, order: .reverse)]))) ?? []
    }

    public func localURL(for assetId: String) -> URL? {
        guard let r = records().first(where: { $0.assetId == assetId }) else { return nil }
        let url = dir.appendingPathComponent(r.fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Download only if the asset's licence permits it — UI hides the control otherwise; server re-checks.
    public func download(_ asset: Asset) async {
        guard asset.capabilities.download, !inFlight.contains(asset.id), localURL(for: asset.id) == nil else { return }
        inFlight.insert(asset.id)
        defer { inFlight.remove(asset.id) }
        do {
            let grant = try await api.authorize(assetId: asset.id, context: "offline_download")
            guard let url = URL(string: grant.url) else { return }
            let (tmp, resp) = try await session.download(from: url)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw APIError.network("Download failed.") }
            let ext = grant.mimeType.contains("wav") ? "wav" : "mp3"
            let name = "\(asset.id).\(ext)"
            let dest = dir.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            context.insert(DownloadRecord(asset: asset, fileName: name))
            try context.save()
            downloadedIds.insert(asset.id)
        } catch let e as APIError {
            lastError = e
        } catch {
            lastError = .network("Download failed. Try again on a stable connection.")
        }
    }

    public func remove(_ assetId: String) {
        for r in records() where r.assetId == assetId {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(r.fileName))
            context.delete(r)
        }
        try? context.save()
        downloadedIds.remove(assetId)
    }

    public func removeAll() { for r in records() { remove(r.assetId) } }
}
