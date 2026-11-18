package app.vibefusion.core.model

import kotlin.random.Random

enum class RepeatMode { OFF, ALL, ONE }

/** Pure queue model (shuffle/repeat/next/previous); same semantics as iOS PlaybackQueue. */
data class PlaybackQueue(
    val items: List<Asset> = emptyList(),
    val order: List<Int> = items.indices.toList(),
    val cursor: Int = 0,
    val repeatMode: RepeatMode = RepeatMode.OFF,
    val shuffled: Boolean = false,
) {
    val current: Asset? get() = order.getOrNull(cursor)?.let { items[it] }
    val upNext: List<Asset> get() = order.drop(cursor + 1).map { items[it] }

    /** Returns the new queue, or null when playback should stop. */
    fun next(userInitiated: Boolean): PlaybackQueue? = when {
        items.isEmpty() -> null
        repeatMode == RepeatMode.ONE && !userInitiated -> this
        cursor + 1 < order.size -> copy(cursor = cursor + 1)
        repeatMode != RepeatMode.OFF -> copy(cursor = 0)
        else -> null
    }

    fun previous(): PlaybackQueue = when {
        cursor > 0 -> copy(cursor = cursor - 1)
        repeatMode == RepeatMode.ALL -> copy(cursor = order.size - 1)
        else -> this
    }

    fun withShuffle(on: Boolean, seed: Long = System.currentTimeMillis()): PlaybackQueue {
        if (on == shuffled || items.isEmpty()) return copy(shuffled = on)
        val currentIndex = order.getOrElse(cursor) { 0 }
        return if (on) {
            val rest = items.indices.filter { it != currentIndex }.shuffled(Random(seed))
            copy(order = listOf(currentIndex) + rest, cursor = 0, shuffled = true)
        } else copy(order = items.indices.toList(), cursor = currentIndex, shuffled = false)
    }

    fun cycleRepeat() = copy(repeatMode = RepeatMode.entries[(repeatMode.ordinal + 1) % RepeatMode.entries.size])
}

/** Sleep timer presets shared with iOS. */
sealed interface SleepTimer {
    data object Off : SleepTimer
    data class Minutes(val minutes: Int) : SleepTimer
    data object EndOfItem : SleepTimer
    companion object { val presets = listOf(Off, Minutes(5), Minutes(15), Minutes(30), Minutes(60), EndOfItem) }
}

val SPEECH_RATES = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

/** Audio focus / route policies, kept pure for unit tests. */
object AudioPolicy {
    enum class Action { PAUSE, DUCK, RESUME, NONE }
    fun onFocusLoss(canDuck: Boolean): Action = if (canDuck) Action.DUCK else Action.PAUSE
    fun onFocusGain(wasPlayingBeforeLoss: Boolean): Action = if (wasPlayingBeforeLoss) Action.RESUME else Action.NONE
    fun onBecomingNoisy(isPlaying: Boolean): Action = if (isPlaying) Action.PAUSE else Action.NONE
}

fun formatDuration(ms: Int): String {
    val s = maxOf(0, ms / 1000)
    val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

fun spokenDuration(ms: Int): String {
    val m = maxOf(1, Math.round(ms / 60000.0).toInt())
    return if (m >= 60) "${m / 60} hr ${m % 60} min" else "$m min"
}
