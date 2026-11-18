package app.vibefusion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.util.UnstableApi
import app.vibefusion.Env
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.ApiError
import app.vibefusion.core.model.SearchFilters
import app.vibefusion.core.model.SearchResults
import app.vibefusion.core.network.apiCall
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Debounced (300 ms) search; `mapLatest` cancels the in-flight request on every new keystroke or filter change. */
@OptIn(FlowPreview::class, kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@UnstableApi
@HiltViewModel
class SearchViewModel @Inject constructor(private val env: Env) : ViewModel() {
    val query = MutableStateFlow("")
    val filters = MutableStateFlow(SearchFilters())
    val state = MutableStateFlow<LoadState<SearchResults>?>(null)

    init {
        viewModelScope.launch {
            combine(query.debounce(300).map { it.trim() }.distinctUntilChanged(), filters) { q, f -> q to f }
                .mapLatest { (q, f) ->
                    if (q.length < 2) return@mapLatest null
                    state.value = LoadState.Loading
                    try {
                        val r = apiCall { env.api.search(q, f.content, f.genre, f.mood, f.maxDurationMinutes?.times(60_000), f.language) }
                        env.analytics.track("search_performed", "resultCount" to (r.tracks.size + r.episodes.size + r.speeches.size))
                        LoadState.Loaded(r)
                    } catch (e: ApiError) { LoadState.Failed(e) }
                }
                .collect { state.value = it }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@UnstableApi
@Composable
fun SearchScreen(vm: SearchViewModel = hiltViewModel()) {
    val nav = LocalNav.current
    val q by vm.query.collectAsState()
    val f by vm.filters.collectAsState()
    val state by vm.state.collectAsState()
    var showFilters by remember { mutableStateOf(false) }
    ScreenScaffold("Search", actions = { IconButton(onClick = { showFilters = !showFilters }) { Icon(Icons.Default.FilterList, "Filters") } }) { pad ->
        Column(Modifier.padding(pad).padding(horizontal = 16.dp)) {
            OutlinedTextField(q, { vm.query.value = it }, Modifier.fillMaxWidth(), placeholder = { Text("Artists, songs, episodes, speeches") },
                leadingIcon = { Icon(Icons.Default.Search, null) }, singleLine = true,
                trailingIcon = { if (q.isNotEmpty()) IconButton(onClick = { vm.query.value = "" }) { Icon(Icons.Default.Clear, "Clear search") } })
            if (showFilters) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                    listOf(null to "All", "music" to "Music", "spoken" to "Spoken").forEach { (v, l) -> VfChip(l, f.content == v) { vm.filters.value = f.copy(content = v) } }
                    listOf(5, 15, 30, 60).forEach { m -> VfChip("≤ $m min", f.maxDurationMinutes == m) { vm.filters.value = f.copy(maxDurationMinutes = if (f.maxDurationMinutes == m) null else m) } }
                    GENRES.take(6).forEach { g -> VfChip(g, f.genre == g) { vm.filters.value = f.copy(genre = if (f.genre == g) null else g) } }
                    MOODS.take(4).forEach { m -> VfChip(m, f.mood == m) { vm.filters.value = f.copy(mood = if (f.mood == m) null else m) } }
                    listOf("en" to "English", "fr" to "Français").forEach { (c, l) -> VfChip(l, f.language == c) { vm.filters.value = f.copy(language = if (f.language == c) null else c) } }
                }
            }
            LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                val s = state
                if (s == null) item { Text("Search free music, podcasts, shows, artists and motivational speeches.", color = VfColors.TextSecondary) }
                else item {
                    StateContent(s, { vm.query.value = q.trimEnd() + " " }, isEmpty = { it.isEmpty }, emptyMessage = "No results. Try another word or remove filters.") { r ->
                        Column {
                            listOf("Tracks" to r.tracks, "Speeches" to r.speeches, "Episodes" to r.episodes).forEach { (title, list) ->
                                if (list.isNotEmpty()) { SectionHeader(title); list.forEachIndexed { i, a -> AssetRow(a, list, i) } }
                            }
                            if (r.shows.isNotEmpty()) { SectionHeader("Shows"); r.shows.forEach { sh -> ListItem({ Text(sh.title) }, leadingContent = { Icon(Icons.Default.Mic, null) }, modifier = Modifier.clickableRow { nav.navigate("show/${sh.id}") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent)) } }
                            if (r.artists.isNotEmpty()) { SectionHeader("Artists & speakers"); r.artists.forEach { a -> ListItem({ Text(a.name) }, leadingContent = { Icon(Icons.Default.Person, null) }, modifier = Modifier.clickableRow { nav.navigate("creator/${a.id}") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent)) } }
                            if (r.albums.isNotEmpty()) { SectionHeader("Albums"); r.albums.forEach { a -> ListItem({ Text(a.title) }, supportingContent = { Text(a.creatorName ?: "") }, leadingContent = { Icon(Icons.Default.Album, null) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent)) } }
                        }
                    }
                }
            }
        }
    }
}

fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)
