package app.vibefusion.ui

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.media3.common.util.UnstableApi
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.vibefusion.Env
import app.vibefusion.MainViewModel
import app.vibefusion.R
import app.vibefusion.core.designsystem.LoadState
import app.vibefusion.core.designsystem.VfColors
import app.vibefusion.core.model.ApiError
import app.vibefusion.data.SessionState
import kotlinx.coroutines.delay

val LocalEnv = staticCompositionLocalOf<Env> { error("Env not provided") }
val LocalNav = staticCompositionLocalOf<NavHostController> { error("Nav not provided") }

/** Loads data for simple screens with retry; re-runs when [keys] change. */
@Composable
fun <T> rememberLoad(vararg keys: Any?, block: suspend Env.() -> T): Pair<LoadState<T>, () -> Unit> {
    val env = LocalEnv.current
    var nonce by remember { mutableIntStateOf(0) }
    val state by produceState<LoadState<T>>(LoadState.Loading, *keys, nonce) {
        value = LoadState.Loading
        value = try { LoadState.Loaded(env.block()) } catch (e: ApiError) { LoadState.Failed(e) }
    }
    return state to { nonce++ }
}

private data class Tab(val route: String, val label: Int, val icon: androidx.compose.ui.graphics.vector.ImageVector)
private val tabs = listOf(
    Tab("home", R.string.tab_home, Icons.Default.Home),
    Tab("discover", R.string.tab_discover, Icons.Default.Explore),
    Tab("studio", R.string.tab_studio, Icons.Default.AutoAwesome),
    Tab("podcasts", R.string.tab_podcasts, Icons.Default.Mic),
    Tab("library", R.string.tab_library, Icons.Default.LibraryMusic),
)

@UnstableApi
@Composable
fun AppRoot(deepLink: Uri? = null, vm: MainViewModel = hiltViewModel()) {
    val env = vm.env
    val session by env.session.state.collectAsState()
    val onboarded by env.settings.onboarded.collectAsState(initial = null)
    CompositionLocalProvider(LocalEnv provides env) {
        Surface(color = VfColors.Background, modifier = Modifier.fillMaxSize()) {
            when {
                session == SessionState.UNKNOWN || onboarded == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                session == SessionState.SIGNED_OUT -> OnboardingFlow(startAtInterests = false)
                onboarded == false -> OnboardingFlow(startAtInterests = true)
                else -> MainScaffold(deepLink)
            }
        }
    }
}

@UnstableApi
@Composable
private fun MainScaffold(deepLink: Uri?) {
    val env = LocalEnv.current
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    var showPlayer by remember { mutableStateOf(false) }
    val backStack by nav.currentBackStackEntryAsState()
    LaunchedEffect(Unit) { env.toasts.collect { snackbar.showSnackbar(it) } }
    LaunchedEffect(deepLink) {
        // Shareable timestamp links: vibefusion://listen/<assetId>?t=<seconds>
        if (deepLink?.host == "listen") {
            val id = deepLink.lastPathSegment ?: return@LaunchedEffect
            val t = deepLink.getQueryParameter("t")?.toLongOrNull() ?: 0
            runCatching { env.api.asset(id) }.getOrNull()?.let { env.playback.play(listOf(it)); delay(1200); env.playback.seekTo(t * 1000); showPlayer = true }
        }
    }
    CompositionLocalProvider(LocalNav provides nav) {
        Scaffold(
            containerColor = VfColors.Background,
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                Column {
                    MiniPlayer(onOpen = { showPlayer = true })
                    NavigationBar(containerColor = VfColors.Surface) {
                        val currentRoot = backStack?.destination?.route
                        tabs.forEach { t ->
                            NavigationBarItem(
                                selected = currentRoot == t.route,
                                onClick = {
                                    nav.navigate(t.route) {
                                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                        launchSingleTop = true; restoreState = true
                                    }
                                },
                                icon = { Icon(t.icon, null) },
                                label = { Text(stringResource(t.label)) },
                            )
                        }
                    }
                }
            },
        ) { pad ->
            NavHost(nav, startDestination = "home", modifier = Modifier.padding(pad)) {
                composable("home") { HomeScreen() }
                composable("discover") { DiscoverScreen() }
                composable("studio") { StudioScreen() }
                composable("podcasts") { PodcastsScreen() }
                composable("library") { LibraryScreen() }
                composable("search") { SearchScreen() }
                composable("motivation") { MotivationScreen() }
                composable("profile") { ProfileScreen() }
                composable("downloads") { DownloadsScreen() }
                composable("history") { HistoryScreen() }
                composable("asset/{id}") { AssetDetailScreen(it.arguments!!.getString("id")!!) }
                composable("creator/{id}") { CreatorScreen(it.arguments!!.getString("id")!!) }
                composable("collection/{id}") { CollectionScreen(it.arguments!!.getString("id")!!) }
                composable("show/{id}") { ShowScreen(it.arguments!!.getString("id")!!) }
                composable("episode/{id}") { EpisodeScreen(it.arguments!!.getString("id")!!) }
                composable("playlist/{id}") { PlaylistScreen(it.arguments!!.getString("id")!!) }
                composable("recipe/{id}") { MixEditorScreen(recipeId = it.arguments!!.getString("id")) }
                composable("editor") { MixEditorScreen(recipeId = null) }
                composable(
                    "catalogue?title={title}&genre={genre}&mood={mood}&topic={topic}",
                    arguments = listOf("title", "genre", "mood", "topic").map { n -> navArgument(n) { type = NavType.StringType; nullable = true } },
                ) { b -> CatalogueListScreen(b.arguments?.getString("title") ?: "", b.arguments?.getString("genre"), b.arguments?.getString("mood"), b.arguments?.getString("topic")) }
            }
        }
        if (showPlayer) FullPlayerSheet(onDismiss = { showPlayer = false })
    }
}

fun NavHostController.catalogue(title: String, genre: String? = null, mood: String? = null, topic: String? = null) =
    navigate("catalogue?title=${Uri.encode(title)}" + (genre?.let { "&genre=${Uri.encode(it)}" } ?: "") + (mood?.let { "&mood=${Uri.encode(it)}" } ?: "") + (topic?.let { "&topic=${Uri.encode(it)}" } ?: ""))
