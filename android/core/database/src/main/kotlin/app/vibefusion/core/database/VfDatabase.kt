package app.vibefusion.core.database

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/** Licensed offline copy; only created after the server authorizes `offline_download`. */
@Entity(tableName = "downloads")
data class DownloadEntity(
    @PrimaryKey val assetId: String,
    val title: String,
    val subtitle: String?,
    val artworkUrl: String?,
    val assetType: String,
    val durationMs: Int,
    val filePath: String,
    val mimeType: String,
    val downloadedAt: Long = System.currentTimeMillis(),
)

/** Offline outbox for playback progress (flushed when connectivity returns). */
@Entity(tableName = "pending_progress")
data class PendingProgressEntity(@PrimaryKey val assetId: String, val positionMs: Int, val durationMs: Int, val updatedAt: Long = System.currentTimeMillis())

/** Last-known server responses for offline-first screens (library, home). */
@Entity(tableName = "cached_json")
data class CachedJsonEntity(@PrimaryKey val key: String, val json: String, val updatedAt: Long = System.currentTimeMillis())

/** Liked-asset ids for instant heart state and optimistic updates. */
@Entity(tableName = "likes")
data class LikeEntity(@PrimaryKey val assetId: String)

@Dao
interface DownloadDao {
    @Query("SELECT * FROM downloads ORDER BY downloadedAt DESC") fun observeAll(): Flow<List<DownloadEntity>>
    @Query("SELECT * FROM downloads WHERE assetId = :id") suspend fun get(id: String): DownloadEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(e: DownloadEntity)
    @Query("DELETE FROM downloads WHERE assetId = :id") suspend fun delete(id: String)
    @Query("SELECT * FROM downloads") suspend fun all(): List<DownloadEntity>
}

@Dao
interface ProgressDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(e: PendingProgressEntity)
    @Query("SELECT * FROM pending_progress") suspend fun all(): List<PendingProgressEntity>
    @Query("DELETE FROM pending_progress WHERE assetId = :id") suspend fun delete(id: String)
}

@Dao
interface CacheDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun put(e: CachedJsonEntity)
    @Query("SELECT * FROM cached_json WHERE `key` = :key") suspend fun get(key: String): CachedJsonEntity?
    @Query("DELETE FROM cached_json") suspend fun clear()
}

@Dao
interface LikeDao {
    @Query("SELECT assetId FROM likes") fun observeIds(): Flow<List<String>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun add(e: LikeEntity)
    @Query("DELETE FROM likes WHERE assetId = :id") suspend fun remove(id: String)
    @Query("DELETE FROM likes") suspend fun clear()
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun addAll(e: List<LikeEntity>)
}

@Database(entities = [DownloadEntity::class, PendingProgressEntity::class, CachedJsonEntity::class, LikeEntity::class], version = 1, exportSchema = false)
abstract class VfDatabase : RoomDatabase() {
    abstract fun downloads(): DownloadDao
    abstract fun progress(): ProgressDao
    abstract fun cache(): CacheDao
    abstract fun likes(): LikeDao

    companion object {
        fun create(context: Context): VfDatabase = Room.databaseBuilder(context, VfDatabase::class.java, "vibefusion.db").fallbackToDestructiveMigration().build()
    }
}
