package app.vibefusion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import app.vibefusion.core.audio.FusionEngine
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.*
import app.vibefusion.core.network.BookmarkBody
import app.vibefusion.core.network.apiCall
import kotlinx.coroutines.launch

@UnstableApi
@Composable
fun MiniPlayer(onOpen: () -> Unit) {
    val env = LocalEnv.current
    val ps by env.playback.state.collectAsState()
    val fusionActive by env.fusion.active.collectAsState()
    val fs by env.fusion.state.collectAsState()
    val isFusion = fusionActive && fs.phase != FusionEngine.Phase.IDLE
    val title = if (isFusion) fs.title else ps.current?.title ?: return
    val playing = if (isFusion) fs.phase == FusionEngine.Phase.PLAYING else ps.isPlaying
    val progress = if (isFusion) (fs.positionMs / fs.durationMs.coerceAtLeast(1)).toFloat() else ps.positionMs.toFloat() / ps.durationMs.coerceAtLeast(1)
    Column(Modifier.fillMaxWidth().background(VfColors.Elevated).clickable(enabled = !isFusion, onClick = onOpen)
        .semantics(mergeDescendants = false) { contentDescription = "Now playing: $title" }) {
        LinearProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(2.dp))
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (isFusion) Icon(Icons.Default.AutoAwesome, null, tint = VfColors.Primary, modifier = Modifier.size(40.dp))
            else ps.current?.let { Artwork(it.artworkUrl, it.id, 40.dp) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    if (isFusion) "AI Studio session" else ps.error ?: if (ps.isBuffering) "Buffering…" else ps.current?.creatorName ?: "",
                    style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary, maxLines = 1,
                )
            }
            IconButton(onClick = { if (isFusion) env.fusion.toggle() else env.playback.toggle() }) {
                Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "Pause" else "Play")
            }
            if (!isFusion) IconButton(onClick = { env.playback.next() }) { Icon(Icons.Default.SkipNext, "Next") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@UnstableApi
@Composable
fun FullPlayerSheet(onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val ps by env.playback.state.collectAsState()
    val liked by env.library.likedIds.collectAsState(initial = emptySet())
    val quality by env.settings.quality.collectAsState(initial = "auto")
    var sheet by remember { mutableStateOf<String?>(null) }
    var scrub by remember { mutableStateOf<Float?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = VfColors.Background) {
        val a = ps.current
        if (a == null) { EmptyState("Nothing is playing."); return@ModalBottomSheet }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Artwork(a.artworkUrl, a.id, VfSize.artworkHero)
            Text(a.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 2)
            Text(a.creatorName, color = VfColors.TextSecondary)
            val pos = scrub ?: ps.positionMs.toFloat()
            Slider(value = pos.coerceIn(0f, ps.durationMs.coerceAtLeast(1).toFloat()), onValueChange = { scrub = it }, valueRange = 0f..ps.durationMs.coerceAtLeast(1).toFloat(),
                onValueChangeFinished = { scrub?.let { env.playback.seekTo(it.toLong()) }; scrub = null },
                modifier = Modifier.semantics { contentDescription = "Playback position"; stateDescription = "${formatDuration(pos.toInt())} of ${formatDuration(ps.durationMs.toInt())}" })
            Row(Modifier.fillMaxWidth()) {
                Text(formatDuration(pos.toInt()), style = MaterialTheme.typography.labelSmall); Spacer(Modifier.weight(1f))
                Text("-" + formatDuration((ps.durationMs - pos).toInt()), style = MaterialTheme.typography.labelSmall)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { env.playback.toggleShuffle() }, Modifier.semantics { stateDescription = if (ps.shuffle) "On" else "Off" }) { Icon(Icons.Default.Shuffle, "Shuffle", tint = if (ps.shuffle) VfColors.Secondary else VfColors.TextSecondary) }
                if (a.isSpoken) IconButton(onClick = { env.playback.skip(-15) }) { Icon(Icons.Default.Replay10, "Back 15 seconds", Modifier.size(32.dp)) }
                else IconButton(onClick = { env.playback.previous() }) { Icon(Icons.Default.SkipPrevious, "Previous", Modifier.size(32.dp)) }
                FilledIconButton(onClick = { env.playback.toggle() }, Modifier.size(VfSize.controlPrimary)) {
                    Icon(if (ps.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, if (ps.isPlaying) "Pause" else "Play", Modifier.size(40.dp))
                }
                if (a.isSpoken) IconButton(onClick = { env.playback.skip(30) }) { Icon(Icons.Default.Forward30, "Forward 30 seconds", Modifier.size(32.dp)) }
                else IconButton(onClick = { env.playback.next() }) { Icon(Icons.Default.SkipNext, "Next", Modifier.size(32.dp)) }
                IconButton(onClick = { env.playback.cycleRepeat() }, Modifier.semantics { stateDescription = ps.repeat.name.lowercase() }) {
                    Icon(if (ps.repeat == RepeatMode.ONE) Icons.Default.RepeatOne else Icons.Default.Repeat, "Repeat", tint = if (ps.repeat == RepeatMode.OFF) VfColors.TextSecondary else VfColors.Secondary)
                }
            }
            ps.error?.let { Text(it, color = VfColors.Destructive) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                val isLiked = a.id in liked
                IconButton(onClick = { scope.launch { env.library.toggleLike(a, isLiked) } }) { Icon(if (isLiked) Icons.Default.Favorite else Icons.Default.FavoriteBorder, if (isLiked) "Unlike" else "Like") }
                if (a.isSpoken) {
                    var speedMenu by remember { mutableStateOf(false) }
                    Box {
                        TextButton(onClick = { speedMenu = true }, Modifier.semantics { contentDescription = "Playback speed ${ps.speed}x" }) { Text("${ps.speed}×") }
                        DropdownMenu(speedMenu, { speedMenu = false }) { SPEECH_RATES.forEach { r -> DropdownMenuItem({ Text("$r×") }, { env.playback.setSpeed(r); speedMenu = false }) } }
                    }
                    IconButton(onClick = {
                        scope.launch {
                            runCatching { apiCall { env.api.addBookmark(a.id, BookmarkBody(ps.positionMs.toInt())) } }
                                .onSuccess { env.toast("Bookmarked at ${formatDuration(it.positionMs)}"); env.analytics.track("episode_bookmarked", "assetId" to a.id) }
                                .onFailure { env.toast(it.message ?: "Couldn't bookmark") }
                        }
                    }) { Icon(Icons.Default.BookmarkAdd, "Bookmark this moment") }
                    IconButton(onClick = { sheet = "transcript" }) { Icon(Icons.Default.Subtitles, "Transcript") }
                }
                IconButton(onClick = { sheet = "sleep" }, Modifier.semantics { stateDescription = ps.sleepRemainingSec?.let { "${it / 60} minutes left" } ?: "Off" }) {
                    Icon(if (ps.sleepTimer == SleepTimer.Off) Icons.Default.Bedtime else Icons.Default.BedtimeOff, "Sleep timer")
                }
                IconButton(onClick = { sheet = "queue" }) { Icon(Icons.Default.QueueMusic, "Queue") }
                var qMenu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { qMenu = true }) { Icon(Icons.Default.HighQuality, "Audio quality: $quality") }
                    DropdownMenu(qMenu, { qMenu = false }) {
                        listOf("auto" to "Automatic", "high" to "High", "data_saver" to "Data saver").forEach { (k, l) ->
                            DropdownMenuItem({ Text(l) }, { scope.launch { env.settings.setQuality(k) }; qMenu = false }, trailingIcon = { if (k == quality) Icon(Icons.Default.Check, null) })
                        }
                    }
                }
            }
            a.license?.attribution?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary, textAlign = TextAlign.Center) }
            Spacer(Modifier.height(24.dp))
        }
    }
    when (sheet) {
        "queue" -> QueueSheet { sheet = null }
        "transcript" -> ps.current?.let { TranscriptSheet(it) { sheet = null } }
        "sleep" -> SleepSheet { sheet = null }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@UnstableApi
@Composable
private fun QueueSheet(onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val ps by env.playback.state.collectAsState()
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(Modifier.padding(horizontal = 16.dp).heightIn(max = 520.dp)) {
            item { SectionHeader("Now playing") }
            ps.current?.let { c -> item { TrackRow(c, isCurrent = true) {} } }
            item { SectionHeader("Up next") }
            if (ps.upNext.isEmpty()) item { Text("Your queue is empty.", color = VfColors.TextSecondary) }
            itemsIndexed(ps.upNext) { i, a ->
                TrackRow(a, trailing = {
                    Row {
                        if (i > 0) IconButton(onClick = { env.playback.moveUpNext(i, i - 1) }) { Icon(Icons.Default.ArrowUpward, "Move up") }
                        IconButton(onClick = { env.playback.removeUpNext(i) }) { Icon(Icons.Default.RemoveCircleOutline, "Remove from queue") }
                    }
                }) { env.playback.jumpToUpNext(i) }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@UnstableApi
@Composable
private fun SleepSheet(onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val ps by env.playback.state.collectAsState()
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(16.dp)) {
            SectionHeader(ps.sleepRemainingSec?.let { "Sleep in ${formatDuration(it * 1000)}" } ?: "Sleep timer")
            SleepTimer.presets.forEach { t ->
                val label = when (t) { SleepTimer.Off -> "Off"; SleepTimer.EndOfItem -> "End of episode"; is SleepTimer.Minutes -> "${t.minutes} min" }
                ListItem({ Text(label) }, trailingContent = { if (ps.sleepTimer == t) Icon(Icons.Default.Check, "Selected") },
                    modifier = Modifier.clickable { env.playback.setSleepTimer(t); onDismiss() }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
            }
        }
    }
}

/** Transcript with tap-to-seek and live highlighting. */
@OptIn(ExperimentalMaterial3Api::class)
@UnstableApi
@Composable
fun TranscriptSheet(asset: Asset, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val ps by env.playback.state.collectAsState()
    val (state, retry) = rememberLoad(asset.id) {
        try { apiCall { api.transcript(asset.id) }.segments } catch (e: ApiError) { if (e.status == 404) emptyList() else throw e }
    }
    val list = rememberLazyListState()
    val segs = (state as? LoadState.Loaded)?.value.orEmpty()
    val activeIndex = segs.indexOfLast { it.startMs <= ps.positionMs }
    LaunchedEffect(activeIndex) { if (activeIndex >= 0) list.animateScrollToItem(activeIndex) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        StateContent(state, retry, isEmpty = { it.isEmpty() }, emptyMessage = "No transcript is available for this episode.") {
            LazyColumn(state = list, modifier = Modifier.padding(16.dp).heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                itemsIndexed(segs, key = { _, s -> s.id }) { i, s ->
                    val active = i == activeIndex && ps.current?.id == asset.id
                    Column(Modifier.fillMaxWidth().clickable { env.playback.seekTo(s.startMs.toLong()) }.semantics(mergeDescendants = true) { contentDescription = "${s.text}. Jumps to ${formatDuration(s.startMs)}" }) {
                        Text(formatDuration(s.startMs) + (s.speaker?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
                        Text(s.text, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal, color = if (active) VfColors.TextPrimary else VfColors.TextSecondary)
                    }
                }
            }
        }
    }
}
