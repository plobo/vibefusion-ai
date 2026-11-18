package app.vibefusion.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.*
import app.vibefusion.core.network.apiCall
import app.vibefusion.data.SessionState
import kotlinx.coroutines.launch
import kotlin.math.abs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(title: String, back: Boolean = true, actions: @Composable RowScope.() -> Unit = {}, content: @Composable (PaddingValues) -> Unit) {
    val nav = LocalNav.current
    Scaffold(
        containerColor = VfColors.Background,
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { if (back) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = VfColors.Background),
            )
        },
        contentWindowInsets = WindowInsets(0),
        content = content,
    )
}

/** Long-press / overflow actions for any asset. */
@UnstableApi
@Composable
fun AssetMenu(asset: Asset, expanded: Boolean, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val liked by env.library.likedIds.collectAsState(initial = emptySet())
    val session by env.session.state.collectAsState()
    var playlistPicker by remember { mutableStateOf(false) }
    DropdownMenu(expanded, onDismiss) {
        DropdownMenuItem({ Text("Play next") }, { env.playback.enqueue(asset, true); env.toast("Playing next"); onDismiss() }, leadingIcon = { Icon(Icons.Default.PlaylistPlay, null) })
        DropdownMenuItem({ Text("Add to queue") }, { env.playback.enqueue(asset, false); env.toast("Added to queue"); onDismiss() }, leadingIcon = { Icon(Icons.Default.QueueMusic, null) })
        val isLiked = asset.id in liked
        DropdownMenuItem({ Text(if (isLiked) "Remove from liked" else "Like") }, { scope.launch { env.library.toggleLike(asset, isLiked) }; onDismiss() }, leadingIcon = { Icon(if (isLiked) Icons.Default.HeartBroken else Icons.Default.FavoriteBorder, null) })
        DropdownMenuItem({ Text("Add to playlist") }, { playlistPicker = true }, leadingIcon = { Icon(Icons.Default.PlaylistAdd, null) })
        DropdownMenuItem({ Text("Details & licence") }, { nav.navigate("asset/${asset.id}"); onDismiss() }, leadingIcon = { Icon(Icons.Default.Info, null) })
        if (asset.capabilities.download && session == SessionState.ACCOUNT) {
            DropdownMenuItem({ Text("Download") }, { scope.launch { env.downloads.download(asset).onFailure { env.toast(it.message ?: "Download failed") } }; onDismiss() }, leadingIcon = { Icon(Icons.Default.Download, null) })
        }
    }
    if (playlistPicker) AddToPlaylistDialog(asset) { playlistPicker = false; onDismiss() }
}

@UnstableApi
@Composable
fun AssetRow(asset: Asset, queue: List<Asset>, index: Int) {
    val env = LocalEnv.current
    val ps by env.playback.state.collectAsState()
    var menu by remember { mutableStateOf(false) }
    Box {
        TrackRow(asset, isCurrent = ps.current?.id == asset.id, trailing = {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More actions for ${asset.title}") }
        }) { env.playback.play(queue, index) }
        AssetMenu(asset, menu) { menu = false }
    }
}

@UnstableApi
@Composable
fun HomeScreen() {
    val nav = LocalNav.current
    val env = LocalEnv.current
    val (state, retry) = rememberLoad { apiCall(retries = 1) { api.home() }.also { analytics.track("catalogue_viewed", "screen" to "home") } }
    val greeting = (state as? LoadState.Loaded)?.value?.greeting ?: "Home"
    ScreenScaffold(greeting, back = false, actions = { IconButton(onClick = { nav.navigate("profile") }) { Icon(Icons.Default.AccountCircle, "Profile and settings") } }) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(VfColors.Elevated).clickable { nav.navigate("search") }.padding(14.dp).semantics { contentDescription = "Search" }) {
                    Icon(Icons.Default.Search, null); Spacer(Modifier.width(8.dp)); Text("Search music, podcasts, speeches", color = VfColors.TextSecondary)
                }
            }
            item {
                StateContent(state, retry) { home ->
                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) { home.decoded().forEach { ShelfView(it) } }
                }
            }
        }
    }
}

@UnstableApi
@Composable
fun ShelfView(shelf: Shelf) {
    val env = LocalEnv.current
    val nav = LocalNav.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionHeader(shelf.title) { if (shelf.id == "daily-motivation") TextButton(onClick = { nav.navigate("motivation") }) { Text("Motivation hub") } }
        when (val items = shelf.items) {
            is ShelfItems.Assets -> if (shelf.id == "daily-motivation" && items.items.isNotEmpty()) FeaturedSpeechCard(items.items.first()) else LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                itemsIndexed(items.items, key = { _, a -> a.id }) { i, a -> ArtworkCard(a.title, a.creatorName, a.artworkUrl, a.id) { env.playback.play(items.items, i) } }
            }
            is ShelfItems.Shows -> LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(items.items, key = { it.id }) { s -> ArtworkCard(s.title, s.creatorName, s.artworkUrl, s.id) { nav.navigate("show/${s.id}") } }
            }
            is ShelfItems.Topics -> LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(items.items, key = { it.id }) { t -> AssistChip(onClick = { nav.catalogue(t.name.replaceFirstChar { c -> c.uppercase() }, genre = t.id) }, label = { Text(t.name.replaceFirstChar { c -> c.uppercase() }) }) }
            }
            is ShelfItems.Mixes -> items.items.forEach { m ->
                ListItem(headlineContent = { Text(m.name) }, leadingContent = { Icon(Icons.Default.AutoAwesome, null, tint = VfColors.Primary) },
                    trailingContent = { Text(formatDuration(m.durationMs)) }, modifier = Modifier.clickable { nav.navigate("recipe/${m.id}") },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent))
            }
        }
    }
}

@UnstableApi
@Composable
fun FeaturedSpeechCard(asset: Asset) {
    val env = LocalEnv.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(VfColors.Surface).clickable { env.playback.play(listOf(asset)) }.padding(12.dp)
            .semantics(mergeDescendants = true) { contentDescription = "Speech of the day: ${asset.title}. Double tap to play." },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Artwork(asset.artworkUrl, asset.id, 88.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("Speech of the day", color = VfColors.Accent, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            Text(asset.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(asset.subtitle ?: asset.creatorName, color = VfColors.TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1)
            Text(spokenDuration(asset.durationMs), color = VfColors.TextSecondary, style = MaterialTheme.typography.labelSmall)
        }
        Icon(Icons.Default.PlayCircle, null, tint = VfColors.Primary, modifier = Modifier.size(44.dp))
    }
}

private fun tagBrush(id: String): Brush {
    val hue = (abs(id.hashCode()) % 360).toFloat()
    return Brush.linearGradient(listOf(Color.hsv(hue, 0.55f, 0.45f), VfColors.Elevated))
}

@UnstableApi
@Composable
fun DiscoverScreen() {
    val nav = LocalNav.current
    val env = LocalEnv.current
    val (genres, retry) = rememberLoad { apiCall(retries = 1) { api.genres() }.items }
    val (moods, _) = rememberLoad { apiCall(retries = 1) { api.moods() }.items }
    val (collections, _) = rememberLoad { apiCall(retries = 1) { api.collections() }.items }
    val (featured, _) = rememberLoad { apiCall(retries = 1) { api.catalogue(type = "music") }.items.also { analytics.track("catalogue_viewed", "screen" to "discover") } }
    ScreenScaffold("Discover", back = false) { pad ->
        LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.padding(pad), contentPadding = PaddingValues(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(VfColors.Elevated).clickable { nav.navigate("search") }.padding(14.dp)) {
                        Icon(Icons.Default.Search, null); Spacer(Modifier.width(8.dp)); Text("Search", color = VfColors.TextSecondary)
                    }
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Brush.horizontalGradient(listOf(VfColors.Accent.copy(alpha = 0.35f), VfColors.Surface)))
                        .clickable { nav.navigate("motivation") }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text("Motivation hub", style = MaterialTheme.typography.titleMedium); Text("Discipline, confidence, resilience and more", color = VfColors.TextSecondary, style = MaterialTheme.typography.bodySmall) }
                        Icon(Icons.Default.LocalFireDepartment, null, tint = VfColors.Accent, modifier = Modifier.size(36.dp))
                    }
                    (collections as? LoadState.Loaded)?.value?.takeIf { it.isNotEmpty() }?.let { cols ->
                        SectionHeader("Curated collections")
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) { items(cols, key = { it.id }) { c -> ArtworkCard(c.title, c.description, c.artworkUrl, c.id) { nav.navigate("collection/${c.slug ?: c.id}") } } }
                    }
                    if (genres is LoadState.Failed) ErrorState((genres as LoadState.Failed).error, retry)
                    SectionHeader("Genres")
                }
            }
            items((genres as? LoadState.Loaded)?.value?.take(12) ?: emptyList(), key = { "g" + it.id }) { t -> TagTile(t) { nav.catalogue(t.name.replaceFirstChar { c -> c.uppercase() }, genre = t.id) } }
            item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) { SectionHeader("Moods") }
            items((moods as? LoadState.Loaded)?.value?.take(12) ?: emptyList(), key = { "m" + it.id }) { t -> TagTile(t) { nav.catalogue(t.name, mood = t.id) } }
            item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) {
                Column {
                    SectionHeader("New & featured")
                    StateContent(featured, retry) { list -> Column { list.forEachIndexed { i, a -> AssetRow(a, list, i) } } }
                }
            }
        }
    }
}

@Composable
private fun TagTile(t: Tag, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(12.dp)).background(tagBrush(t.id)).clickable(onClick = onClick)
        .semantics { contentDescription = "${t.name}, ${t.assetCount ?: 0} items" }, contentAlignment = Alignment.Center) {
        Text(t.name.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    }
}

@UnstableApi
@Composable
fun CatalogueListScreen(title: String, genre: String?, mood: String?, topic: String?) {
    val env = LocalEnv.current
    var items by remember { mutableStateOf<List<Asset>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var state by remember { mutableStateOf<LoadState<Unit>>(LoadState.Loading) }
    val scope = rememberCoroutineScope()
    suspend fun load(reset: Boolean) {
        try {
            val p = apiCall(retries = 1) { env.api.catalogue(genre = genre, mood = mood, topic = topic, cursor = if (reset) null else cursor) }
            items = if (reset) p.items else items + p.items; cursor = p.nextCursor; state = LoadState.Loaded(Unit)
        } catch (e: app.vibefusion.core.model.ApiError) { if (items.isEmpty()) state = LoadState.Failed(e) }
    }
    LaunchedEffect(genre, mood, topic) { load(true) }
    ScreenScaffold(title, actions = { if (items.isNotEmpty()) IconButton(onClick = { env.playback.play(items) }) { Icon(Icons.Default.PlayArrow, "Play all") } }) { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            item { StateContent(state, { scope.launch { load(true) } }, isEmpty = { items.isEmpty() }, emptyMessage = "No audio here yet.") {} }
            itemsIndexed(items, key = { _, a -> a.id }) { i, a ->
                AssetRow(a, items, i)
                if (i == items.lastIndex && cursor != null) LaunchedEffect(cursor) { load(false) }
            }
        }
    }
}

@UnstableApi
@Composable
fun CollectionScreen(id: String) {
    val env = LocalEnv.current
    val (state, retry) = rememberLoad(id) { apiCall(retries = 1) { api.collection(id) } }
    ScreenScaffold((state as? LoadState.Loaded)?.value?.title ?: "") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            item {
                StateContent(state, retry) { c ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        c.description?.let { Text(it, color = VfColors.TextSecondary) }
                        PrimaryButton("Play all", icon = Icons.Default.PlayArrow) { env.playback.play(c.items.orEmpty()) }
                        c.items.orEmpty().forEachIndexed { i, a -> AssetRow(a, c.items.orEmpty(), i) }
                    }
                }
            }
        }
    }
}

@UnstableApi
@Composable
fun CreatorScreen(id: String) {
    val nav = LocalNav.current
    val (state, retry) = rememberLoad(id) { apiCall(retries = 1) { api.creator(id) } }
    ScreenScaffold((state as? LoadState.Loaded)?.value?.name ?: "") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            item {
                StateContent(state, retry) { c ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(c.creatorType.replaceFirstChar { it.uppercase() }, color = VfColors.Secondary)
                        c.bio?.let { Text(it, color = VfColors.TextSecondary) }
                        if (c.shows.isNotEmpty()) { SectionHeader("Series"); c.shows.forEach { s -> TextButton(onClick = { nav.navigate("show/${s.id}") }) { Text(s.title) } } }
                        SectionHeader("Audio")
                        c.assets.forEachIndexed { i, a -> AssetRow(a, c.assets, i) }
                    }
                }
            }
        }
    }
}

@UnstableApi
@Composable
fun AssetDetailScreen(id: String) {
    val env = LocalEnv.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val liked by env.library.likedIds.collectAsState(initial = emptySet())
    val downloads by env.downloads.downloads.collectAsState(initial = emptyList())
    val inFlight by env.downloads.inFlight.collectAsState()
    val session by env.session.state.collectAsState()
    val (state, retry) = rememberLoad(id) { apiCall(retries = 1) { api.asset(id) } }
    ScreenScaffold("") { pad ->
        Column(Modifier.padding(pad).verticalScroll(rememberScrollState()).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            StateContent(state, retry) { a ->
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Artwork(a.artworkUrl, a.id, 240.dp)
                    Text(a.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    a.creator?.let { c -> TextButton(onClick = { nav.navigate("creator/${c.id}") }) { Text(c.name) } } ?: Text(a.creatorName, color = VfColors.TextSecondary)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PrimaryButton("Play", Modifier.weight(1f), icon = Icons.Default.PlayArrow) { env.playback.play(listOf(a)) }
                        val isLiked = a.id in liked
                        IconButton(onClick = { scope.launch { env.library.toggleLike(a, isLiked) } }) { Icon(if (isLiked) Icons.Default.Favorite else Icons.Default.FavoriteBorder, if (isLiked) "Unlike" else "Like") }
                        if (a.capabilities.download && session == SessionState.ACCOUNT) {
                            val done = downloads.any { it.assetId == a.id }
                            IconButton(onClick = { scope.launch { env.downloads.download(a).onFailure { env.toast(it.message ?: "Download failed") } } }, enabled = !done && a.id !in inFlight) {
                                Icon(if (done) Icons.Default.DownloadDone else Icons.Default.Download, if (done) "Downloaded" else "Download")
                            }
                        }
                    }
                    a.description?.let { Text(it, color = VfColors.TextSecondary) }
                    LicenceCard(a)
                }
            }
        }
    }
}

@Composable
fun LicenceCard(a: Asset) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(VfColors.Surface).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Default.Verified, null); Spacer(Modifier.width(8.dp)); Text("Licence & usage", style = MaterialTheme.typography.titleSmall) }
        a.license?.let { l ->
            Text(l.type.replace('_', ' ').replaceFirstChar { it.uppercase() })
            l.attribution?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary) }
            l.url?.let { u -> TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) }) { Text("View licence") } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf("Stream" to a.capabilities.stream, "Download" to a.capabilities.download, "Mix" to a.capabilities.mix, "Export" to a.capabilities.render).forEach { (n, on) ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "$n ${if (on) "allowed" else "not allowed"}" }) {
                    Icon(if (on) Icons.Default.CheckCircle else Icons.Default.Cancel, null, tint = if (on) VfColors.Secondary else VfColors.TextSecondary, modifier = Modifier.size(16.dp))
                    Text(" $n", style = MaterialTheme.typography.labelSmall, color = if (on) VfColors.Secondary else VfColors.TextSecondary)
                }
            }
        }
    }
}
