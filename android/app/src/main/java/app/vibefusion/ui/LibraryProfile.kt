package app.vibefusion.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.media3.common.util.UnstableApi
import app.vibefusion.BuildConfig
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.*
import app.vibefusion.core.network.*
import app.vibefusion.data.SessionState
import app.vibefusion.data.newIdempotencyKey
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.File

private val clear = @Composable { ListItemDefaults.colors(containerColor = Color.Transparent) }

@UnstableApi
@Composable
fun LibraryScreen() {
    val env = LocalEnv.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val snap by env.library.snapshot.collectAsState()
    val err by env.library.lastError.collectAsState()
    val session by env.session.state.collectAsState()
    var section by remember { mutableIntStateOf(0) }
    var newPlaylist by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { env.library.refresh() }
    ScreenScaffold("Library", back = false, actions = { IconButton(onClick = { scope.launch { env.library.refresh() } }) { Icon(Icons.Default.Refresh, "Refresh library") } }) { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            item {
                ScrollableTabRow(section, edgePadding = 0.dp, containerColor = Color.Transparent) {
                    listOf("Music", "Spoken", "Playlists", "Mixes").forEachIndexed { i, t -> Tab(section == i, { section = i }, text = { Text(t) }) }
                }
            }
            item { ListItem({ Text("Downloads") }, leadingContent = { Icon(Icons.Default.DownloadForOffline, null) }, modifier = Modifier.clickable { nav.navigate("downloads") }, colors = clear()) }
            item { ListItem({ Text("Listening history") }, leadingContent = { Icon(Icons.Default.History, null) }, modifier = Modifier.clickable { nav.navigate("history") }, colors = clear()) }
            if (session == SessionState.GUEST) item { Text("You're browsing as a guest. Create an account in Profile to sync your library across devices.", color = VfColors.TextSecondary) }
            if (snap == null && err != null) item { ErrorState(err!!) { scope.launch { env.library.refresh() } } }
            when (section) {
                0, 1 -> {
                    val list = if (section == 0) snap?.likedMusic.orEmpty() else snap?.savedEpisodes.orEmpty()
                    if (list.isEmpty()) item { EmptyState(if (section == 0) "Like a track to see it here." else "Saved speeches and episodes appear here.") }
                    itemsIndexed(list, key = { _, a -> a.id }) { i, a -> AssetRow(a, list, i) }
                    if (section == 1) items(snap?.followedShows.orEmpty(), key = { "s" + it.id }) { s -> ListItem({ Text(s.title) }, supportingContent = { Text("Following") }, modifier = Modifier.clickable { nav.navigate("show/${s.id}") }, colors = clear()) }
                }
                2 -> {
                    item { ListItem({ Text("New playlist") }, leadingContent = { Icon(Icons.Default.Add, null) }, modifier = Modifier.clickable { newPlaylist = true }, colors = clear()) }
                    items(snap?.playlists.orEmpty(), key = { it.id }) { p -> ListItem({ Text(p.name) }, supportingContent = { Text("${p.itemCount ?: 0} items") }, modifier = Modifier.clickable { nav.navigate("playlist/${p.id}") }, colors = clear()) }
                }
                else -> {
                    if (snap?.mixes.isNullOrEmpty()) item { EmptyState("Mixes you save in AI Studio appear here.") }
                    items(snap?.mixes.orEmpty(), key = { it.id }) { m -> ListItem({ Text(m.name) }, leadingContent = { Icon(Icons.Default.AutoAwesome, null, tint = VfColors.Primary) }, trailingContent = { Text(formatDuration(m.durationMs)) }, modifier = Modifier.clickable { nav.navigate("recipe/${m.id}") }, colors = clear()) }
                }
            }
        }
    }
    if (newPlaylist) {
        var name by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { newPlaylist = false }, title = { Text("New playlist") }, text = { OutlinedTextField(name, { name = it }, label = { Text("Name") }) },
            confirmButton = { TextButton(onClick = {
                newPlaylist = false
                scope.launch { runCatching { apiCall { env.api.createPlaylist(CreatePlaylistBody(name.ifBlank { "My playlist" }), newIdempotencyKey()) } }.onSuccess { env.analytics.track("playlist_created"); env.library.refresh() }.onFailure { env.toast(it.message ?: "Couldn't create playlist") } }
            }) { Text("Create") } },
            dismissButton = { TextButton(onClick = { newPlaylist = false }) { Text("Cancel") } })
    }
}

@UnstableApi
@Composable
fun AddToPlaylistDialog(asset: Asset, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val snap by env.library.snapshot.collectAsState()
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Add to playlist") }, confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } }, text = {
        Column {
            if (snap?.playlists.isNullOrEmpty()) Text("Create a playlist in Library first.")
            snap?.playlists.orEmpty().forEach { p ->
                ListItem({ Text(p.name) }, modifier = Modifier.clickable {
                    scope.launch {
                        runCatching { apiCall { env.api.addItem(p.id, AddItemBody(asset.id, p.version)) } }
                            .onSuccess { env.toast("Added to ${p.name}"); env.library.refresh() }
                            .onFailure { env.toast(if ((it as? ApiError)?.code == "VERSION_CONFLICT") "Playlist changed elsewhere — try again." else it.message ?: "Failed"); env.library.refresh() }
                    }
                    onDismiss()
                }, colors = clear())
            }
        }
    })
}

@UnstableApi
@Composable
fun PlaylistScreen(id: String) {
    val env = LocalEnv.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<LoadState<Playlist>>(LoadState.Loading) }
    var conflict by remember { mutableStateOf<String?>(null) }
    var rename by remember { mutableStateOf(false) }
    suspend fun load() { state = try { LoadState.Loaded(apiCall(retries = 1) { env.api.playlist(id) }) } catch (e: ApiError) { LoadState.Failed(e) } }
    /** Optimistic local change, server-authoritative result; version conflicts reload instead of overwriting. */
    fun mutate(optimistic: Playlist? = null, op: suspend (Playlist) -> Playlist) = scope.launch {
        val p = (state as? LoadState.Loaded)?.value ?: return@launch
        optimistic?.let { state = LoadState.Loaded(it) }
        try { state = LoadState.Loaded(apiCall { op(p) }); conflict = null; env.library.refresh() }
        catch (e: ApiError) { if (e.code == "VERSION_CONFLICT") conflict = "Updated on another device — showing the latest version." else env.toast(e.message); load() }
    }
    LaunchedEffect(id) { load() }
    val p = (state as? LoadState.Loaded)?.value
    ScreenScaffold(p?.name ?: "Playlist", actions = {
        IconButton(onClick = { rename = true }) { Icon(Icons.Default.Edit, "Rename") }
        IconButton(onClick = { scope.launch { runCatching { env.api.deletePlaylist(id) }; env.library.refresh(); nav.popBackStack() } }) { Icon(Icons.Default.Delete, "Delete playlist") }
    }) { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            conflict?.let { item { Text(it, color = VfColors.Accent) } }
            item { StateContent(state, { scope.launch { load() } }, isEmpty = { it.items.isEmpty() }, emptyMessage = "This playlist is empty. Use a track's ⋮ menu to add it.") { pl -> PrimaryButton("Play all", icon = Icons.Default.PlayArrow) { env.playback.play(pl.items.mapNotNull { it.asset }) } } }
            itemsIndexed(p?.items.orEmpty(), key = { _, it -> it.id }) { i, item ->
                item.asset?.let { a ->
                    TrackRow(a, trailing = {
                        Row {
                            if (i > 0) IconButton(onClick = {
                                val items = p!!.items.toMutableList().apply { add(i - 1, removeAt(i)) }
                                mutate(p.copy(items = items)) { cur -> env.api.reorder(id, ReorderBody(items.map { it.id }, cur.version)) }
                            }) { Icon(Icons.Default.ArrowUpward, "Move up") }
                            IconButton(onClick = { mutate(p!!.copy(items = p.items - item)) { cur -> env.api.removeItem(id, item.id, cur.version) } }) { Icon(Icons.Default.RemoveCircleOutline, "Remove from playlist") }
                        }
                    }) { env.playback.play(p!!.items.mapNotNull { it.asset }, i) }
                }
            }
        }
    }
    if (rename && p != null) {
        var name by remember { mutableStateOf(p.name) }
        AlertDialog(onDismissRequest = { rename = false }, title = { Text("Rename playlist") }, text = { OutlinedTextField(name, { name = it }) },
            confirmButton = { TextButton(onClick = { rename = false; mutate { cur -> env.api.renamePlaylist(id, RenameBody(name), "\"${cur.version}\"") } }) { Text("Save") } })
    }
}

@UnstableApi
@Composable
fun DownloadsScreen() {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    val downloads by env.downloads.downloads.collectAsState(initial = emptyList())
    ScreenScaffold("Downloads", actions = { if (downloads.isNotEmpty()) TextButton(onClick = { scope.launch { env.downloads.removeAll() } }) { Text("Remove all") } }) { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            if (downloads.isEmpty()) item { EmptyState("Downloads are available for audio whose licence allows offline listening.") }
            items(downloads, key = { it.assetId }) { d ->
                val a = Asset(id = d.assetId, title = d.title, subtitle = d.subtitle, artworkUrl = d.artworkUrl, assetType = d.assetType, durationMs = d.durationMs, capabilities = Capabilities(stream = true, download = true))
                TrackRow(a, trailing = { IconButton(onClick = { scope.launch { env.downloads.remove(d.assetId) } }) { Icon(Icons.Default.Delete, "Remove download") } }) { env.playback.play(listOf(a)) }
            }
        }
    }
}

@UnstableApi
@Composable
fun HistoryScreen() {
    val env = LocalEnv.current
    val (state, retry) = rememberLoad { apiCall(retries = 1) { api.recent() }.items }
    ScreenScaffold("Recently played") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp)) {
            item {
                StateContent(state, retry, isEmpty = { it.isEmpty() }, emptyMessage = "Nothing played yet.") { items ->
                    Column {
                        items.forEach { r ->
                            TrackRow(r.asset) { env.playback.play(listOf(r.asset)) }
                            if (!r.completed && r.positionMs > 0) LinearProgressIndicator(progress = { r.positionMs.toFloat() / r.asset.durationMs.coerceAtLeast(1) }, Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@UnstableApi
@Composable
fun ProfileScreen() {
    val env = LocalEnv.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val user by env.session.user.collectAsState()
    val session by env.session.state.collectAsState()
    val prefs by env.session.preferences.collectAsState()
    val quality by env.settings.quality.collectAsState(initial = "auto")
    val dataSaver by env.settings.dataSaver.collectAsState(initial = false)
    val wifiOnly by env.settings.wifiOnly.collectAsState(initial = true)
    val server by env.settings.serverUrl.collectAsState(initial = null)
    val (status, _) = rememberLoad { apiCall { api.fusionStatus() } }
    var confirmDelete by remember { mutableStateOf(false) }
    var upEmail by remember { mutableStateOf("") }
    var upPass by remember { mutableStateOf("") }
    fun save(p: Preferences) = scope.launch { env.session.savePreferences(p) }
    @Composable fun toggle(label: String, value: Boolean, onChange: (Boolean) -> Unit) = Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(value, onChange) }
    ScreenScaffold("Profile") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { SectionHeader("Account") }
            user?.let { u ->
                item {
                    Text(u.displayName, style = MaterialTheme.typography.titleMedium)
                    Text(if (u.isGuest) "Guest" else u.email ?: "", color = VfColors.TextSecondary)
                    Text("Region ${u.territory} · Free — all content is openly licensed", color = VfColors.TextSecondary, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (session == SessionState.GUEST) item {
                OutlinedTextField(upEmail, { upEmail = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(upPass, { upPass = it }, label = { Text("Password") }, modifier = Modifier.fillMaxWidth(), visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                TextButton(onClick = { scope.launch { runCatching { env.session.upgrade(upEmail, upPass) }.onFailure { env.toast(it.message ?: "Couldn't create the account") } } }) { Text("Create account and keep my library") }
            }
            item { TextButton(onClick = { scope.launch { env.playback.pause(); env.fusion.stop(); env.session.signOut() } }) { Text("Sign out", color = VfColors.Destructive) } }
            item { SectionHeader("Taste") }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GENRES.forEach { g -> VfChip(g, g in prefs.genres) { save(prefs.copy(genres = if (g in prefs.genres) prefs.genres - g else prefs.genres + g)) } }
                    MOODS.forEach { m -> VfChip(m, m in prefs.moods) { save(prefs.copy(moods = if (m in prefs.moods) prefs.moods - m else prefs.moods + m)) } }
                    TOPICS.forEach { t -> VfChip(t, t in prefs.speechTopics) { save(prefs.copy(speechTopics = if (t in prefs.speechTopics) prefs.speechTopics - t else prefs.speechTopics + t)) } }
                }
                toggle("Allow explicit content", prefs.explicitAllowed) { save(prefs.copy(explicitAllowed = it)) }
            }
            item { SectionHeader("Audio") }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("auto" to "Automatic", "high" to "High", "data_saver" to "Data saver").forEach { (k, l) -> VfChip(l, quality == k) { scope.launch { env.settings.setQuality(k) } } } }
                toggle("Data saver", dataSaver) { scope.launch { env.settings.setDataSaver(it) } }
                toggle("Download on Wi-Fi only", wifiOnly) { scope.launch { env.settings.setWifiOnly(it) } }
                TextButton(onClick = { scope.launch { env.downloads.removeAll() } }) { Text("Remove all downloads", color = VfColors.Destructive) }
            }
            item { SectionHeader("Privacy") }
            item {
                toggle("Share anonymous usage analytics", prefs.analyticsOptIn) { save(prefs.copy(analyticsOptIn = it)) }
                toggle("Allow AI processing of my prompts", prefs.aiProcessingConsent) { save(prefs.copy(aiProcessingConsent = it)) }
                (status as? LoadState.Loaded)?.value?.let { Text(it.disclosure, style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary) }
                Text("Analytics use a pseudonymous ID and never include prompts, transcripts or your email.", style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary)
                TextButton(onClick = {
                    scope.launch {
                        runCatching {
                            val body = apiCall { env.api.exportData() }.string()
                            val f = File(ctx.cacheDir, "vibefusion-export.json").apply { writeText(body) }
                            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
                            ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Export my data"))
                        }.onFailure { env.toast("Export failed.") }
                    }
                }) { Text("Export my data") }
                TextButton(onClick = { confirmDelete = true }) { Text("Delete account and data", color = VfColors.Destructive) }
            }
            item { SectionHeader("About") }
            item {
                Text("Licences: Creative Commons (BY, BY-SA, BY-ND, CC0) and public-domain music from Internet Archive netlabels; NonCommercial licences are excluded and BY-ND tracks can't be remixed. Speeches are public-domain LibriVox readings. Podcasts stream from publishers' public RSS feeds and are never used in AI mixes.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://vibefusion.app/terms"))) }) { Text("Terms of Service") }
                TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://vibefusion.app/privacy"))) }) { Text("Privacy Policy") }
                TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:support@vibefusion.app"))) }) { Text("Help & feedback") }
                Text("Version ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
            }
            if (BuildConfig.DEBUG) item {
                SectionHeader("Developer")
                var url by remember(server) { mutableStateOf(server ?: "") }
                OutlinedTextField(url, { url = it }, label = { Text("Server URL (blank = ${BuildConfig.API_BASE_URL})") }, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { scope.launch { env.settings.setServerUrl(url); env.toast("Restart the app to use the new server.") } }) { Text("Save server") }
            }
        }
    }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false }, title = { Text("Delete your account?") },
        text = { Text("Your library, playlists, mixes, bookmarks and history will be erased. This can't be undone.") },
        confirmButton = { TextButton(onClick = { confirmDelete = false; scope.launch { runCatching { env.downloads.removeAll(); env.session.deleteAccount() }.onFailure { env.toast("Couldn't delete the account.") } } }) { Text("Delete permanently", color = VfColors.Destructive) } },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } })
}
