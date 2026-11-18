package app.vibefusion.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.*
import app.vibefusion.core.network.apiCall
import app.vibefusion.core.network.orThrow
import app.vibefusion.data.SessionState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@UnstableApi
@Composable
fun PodcastsScreen() {
    val nav = LocalNav.current
    var kind by remember { mutableStateOf("podcast") }
    val (state, retry) = rememberLoad { apiCall(retries = 1) { api.podcasts() }.items }
    ScreenScaffold("Podcasts", back = false) { pad ->
        LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.padding(pad), contentPadding = PaddingValues(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        SegmentedButton(kind == "podcast", { kind = "podcast" }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("Podcasts") }
                        SegmentedButton(kind == "speech_series", { kind = "speech_series" }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("Speech series") }
                    }
                    TextButton(onClick = { nav.navigate("motivation") }) { Icon(Icons.Default.LocalFireDepartment, null); Text(" Motivation hub") }
                    StateContent(state, retry, isEmpty = { it.isEmpty() }, emptyMessage = "Shows are still being added.") { shows ->
                        val followed = shows.filter { it.following == true }
                        if (followed.isNotEmpty()) {
                            SectionHeader("Following")
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) { items(followed, key = { "f" + it.id }) { s -> ArtworkCard(s.title, s.creatorName, s.artworkUrl, s.id) { nav.navigate("show/${s.id}") } } }
                        }
                        SectionHeader(if (kind == "podcast") "Browse shows" else "Classic speeches")
                    }
                }
            }
            items((state as? LoadState.Loaded)?.value?.filter { it.showKind == kind } ?: emptyList(), key = { it.id }) { s ->
                ArtworkCard(s.title, "${s.creatorName ?: ""} · ${s.episodeCount ?: 0} episodes", s.artworkUrl, s.id) { nav.navigate("show/${s.id}") }
            }
        }
    }
}

@UnstableApi
@Composable
fun ShowScreen(id: String) {
    val env = LocalEnv.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val session by env.session.state.collectAsState()
    val (showState, retry) = rememberLoad(id) { apiCall(retries = 1) { api.show(id) } }
    var following by remember { mutableStateOf<Boolean?>(null) }
    var episodes by remember { mutableStateOf<List<Asset>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var epError by remember { mutableStateOf<ApiError?>(null) }
    suspend fun load(reset: Boolean) {
        try { val p = apiCall(retries = 1) { env.api.episodes(id, if (reset) null else cursor) }; episodes = if (reset) p.items else episodes + p.items; cursor = p.nextCursor }
        catch (e: ApiError) { epError = e }
    }
    LaunchedEffect(id) { load(true) }
    val show = (showState as? LoadState.Loaded)?.value
    ScreenScaffold(show?.title ?: "") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                StateContent(showState, retry) { s ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row {
                            Artwork(s.artworkUrl, s.id, 120.dp)
                            Spacer(Modifier.width(12.dp))
                            Column {
                                Text(s.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                                s.creatorName?.let { Text(it, color = VfColors.TextSecondary) }
                                val f = following ?: (s.following == true)
                                OutlinedButton(enabled = session == SessionState.ACCOUNT, onClick = {
                                    following = !f
                                    scope.launch {
                                        runCatching { apiCall { if (f) env.api.unfollow(id) else env.api.follow(id) }.orThrow() }
                                            .onFailure { following = f; env.toast("Couldn't update follow.") }
                                    }
                                }) { Icon(if (f) Icons.Default.Check else Icons.Default.Add, null); Text(if (f) " Following" else " Follow") }
                            }
                        }
                        s.description?.let { Text(it, color = VfColors.TextSecondary, maxLines = 5, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
            epError?.let { e -> item { ErrorState(e) { scope.launch { epError = null; load(true) } } } }
            itemsIndexed(episodes, key = { _, e -> e.id }) { i, e ->
                EpisodeRow(e) { nav.navigate("episode/${e.id}") }
                if (i == episodes.lastIndex && cursor != null) LaunchedEffect(cursor) { load(false) }
            }
        }
    }
}

@UnstableApi
@Composable
private fun EpisodeRow(e: Asset, onOpen: () -> Unit) {
    val env = LocalEnv.current
    Column(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 8.dp)) {
        e.releaseDate?.let { Text(it.take(10), style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary) }
        Text(e.title, style = MaterialTheme.typography.titleSmall, maxLines = 2)
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { env.playback.play(listOf(e)) }) { Icon(Icons.Default.PlayCircle, "Play ${e.title}", tint = VfColors.Primary) }
            val p = e.progress
            when {
                p?.completed == true -> Text("Played", style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
                p != null && p.positionMs > 0 -> {
                    LinearProgressIndicator(progress = { p.positionMs.toFloat() / e.durationMs.coerceAtLeast(1) }, Modifier.width(60.dp))
                    Text("  ${spokenDuration(e.durationMs - p.positionMs)} left", style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
                }
                else -> Text(spokenDuration(e.durationMs), style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
            }
        }
        HorizontalDivider(color = Color.White.copy(alpha = 0.06f))
    }
}

@UnstableApi
@Composable
fun EpisodeScreen(id: String) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val session by env.session.state.collectAsState()
    val (assetState, retry) = rememberLoad(id) { apiCall(retries = 1) { api.asset(id) } }
    val (detailState, _) = rememberLoad(id) { apiCall(retries = 1) { api.episode(id) } }
    var bookmarks by remember { mutableStateOf<List<Bookmark>?>(null) }
    var transcript by remember { mutableStateOf(false) }
    val detail = (detailState as? LoadState.Loaded)?.value
    val marks = bookmarks ?: detail?.bookmarks.orEmpty()
    fun playAt(a: Asset, ms: Int) = scope.launch {
        if (env.playback.state.value.current?.id != a.id) { env.playback.play(listOf(a)); delay(900) }
        env.playback.seekTo(ms.toLong())
    }
    ScreenScaffold("") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                StateContent(assetState, retry) { a ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row {
                            Artwork(a.artworkUrl, a.id, 96.dp); Spacer(Modifier.width(12.dp))
                            Column {
                                Text(a.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                                Text(a.showTitle ?: a.creatorName, color = VfColors.TextSecondary)
                                Text(spokenDuration(a.durationMs), style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
                            }
                        }
                        val resume = detail?.progress?.let { it.positionMs > 0 && !it.completed } == true
                        PrimaryButton(if (resume) "Resume" else "Play", icon = Icons.Default.PlayArrow) { env.playback.play(listOf(a)) }
                        if (a.capabilities.download && session == SessionState.ACCOUNT) SecondaryButton("Download episode", icon = Icons.Default.Download) {
                            scope.launch { env.downloads.download(a).onSuccess { env.toast("Downloaded") }.onFailure { env.toast(it.message ?: "Download failed") } }
                        }
                        if (detail?.chapters?.isNotEmpty() == true) {
                            SectionHeader("Chapters")
                            detail.chapters.forEach { c ->
                                Row(Modifier.fillMaxWidth().clickable { playAt(a, c.startMs) }.heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(formatDuration(c.startMs), color = VfColors.Secondary); Spacer(Modifier.width(12.dp)); Text(c.title)
                                }
                            }
                        }
                        if (marks.isNotEmpty()) {
                            SectionHeader("Your bookmarks")
                            marks.forEach { b ->
                                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Row(Modifier.weight(1f).clickable { playAt(a, b.positionMs) }) {
                                        Icon(Icons.Default.Bookmark, null, tint = VfColors.Accent); Text(" ${formatDuration(b.positionMs)}${b.note?.let { " — $it" } ?: ""}")
                                    }
                                    IconButton(onClick = {
                                        val link = "vibefusion://listen/${a.id}?t=${b.positionMs / 1000}"
                                        ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "${a.title} at ${formatDuration(b.positionMs)}: $link"), "Share"))
                                    }) { Icon(Icons.Default.Share, "Share timestamp link") }
                                    IconButton(onClick = { scope.launch { runCatching { env.api.deleteBookmark(b.id) }; bookmarks = marks - b } }) { Icon(Icons.Default.Delete, "Delete bookmark") }
                                }
                            }
                        }
                        if (detail?.hasTranscript == true) SecondaryButton("Read transcript", icon = Icons.Default.Subtitles) { transcript = true }
                        a.description?.let { SectionHeader("About"); Text(it, color = VfColors.TextSecondary) }
                        LicenceCard(a)
                        if (transcript) TranscriptSheet(a) { transcript = false }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@UnstableApi
@Composable
fun MotivationScreen() {
    var topic by remember { mutableStateOf<String?>(null) }
    val (topics, _) = rememberLoad { apiCall(retries = 1) { api.motivationTopics() }.items }
    val (state, retry) = rememberLoad(topic) { apiCall(retries = 1) { api.motivationFeatured(topic) } }
    val nav = LocalNav.current
    ScreenScaffold("Motivation") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item { VfChip("All", topic == null) { topic = null } }
                    items((topics as? LoadState.Loaded)?.value.orEmpty(), key = { it.id }) { t -> VfChip(t.name, topic == t.id) { topic = t.id } }
                }
            }
            item {
                StateContent(state, retry) { m ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        m.featured?.let { SectionHeader("Daily featured speech"); FeaturedSpeechCard(it) }
                        if (m.short.isNotEmpty()) { SectionHeader("Short inspiration (under 10 min)"); m.short.forEachIndexed { i, a -> AssetRow(a, m.short, i) } }
                        if (m.long.isNotEmpty()) { SectionHeader("Long-form"); m.long.forEachIndexed { i, a -> AssetRow(a, m.long, i) } }
                        if (m.speakers.isNotEmpty()) {
                            SectionHeader("Speakers")
                            m.speakers.forEach { s -> ListItem({ Text(s.name) }, leadingContent = { Icon(Icons.Default.RecordVoiceOver, null) }, modifier = Modifier.clickable { nav.navigate("creator/${s.id}") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent)) }
                        }
                        Text("Speeches are public-domain readings from LibriVox volunteers or openly published podcasts.", style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary)
                    }
                }
            }
        }
    }
}
