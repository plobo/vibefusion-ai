package app.vibefusion.ui

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.util.UnstableApi
import app.vibefusion.Env
import app.vibefusion.core.audio.FusionEngine
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.*
import app.vibefusion.core.network.*
import app.vibefusion.data.SessionState
import app.vibefusion.data.newIdempotencyKey
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

/** Hands a generated plan from the Studio composer to the editor. */
object PendingPlan { var response: FusionPlanResponse? = null; var prompt: String? = null }

data class EditorState(
    val plan: MixPlan = MixPlan(title = "My fusion session", durationMs = 10 * 60_000, layers = emptyList(), ducking = Ducking(true)),
    val name: String = "My fusion session",
    val prompt: String? = null,
    val planner: String = "manual",
    val recipeId: String? = null,
    val recipeVersion: Int = 0,
    val assets: Map<String, Asset> = emptyMap(),
    val validation: PlanValidation? = null,
    val warnings: List<String> = emptyList(),
    val message: String? = null,
    val busy: Boolean = false,
    val dirty: Boolean = false,
    val prepareProgress: Double? = null,
    val renderProgress: Double? = null,
    val exported: File? = null,
    val exportAttribution: String? = null,
    val shareUrl: String? = null,
) {
    val localIssues get() = MixPlanLocalCheck.issues(plan)
    val canExport get() = recipeId != null && plan.layers.isNotEmpty() && plan.layers.all { assets[it.assetId]?.capabilities?.render == true }
    fun title(l: MixLayer) = assets[l.assetId]?.title ?: "Unavailable audio"
}

@UnstableApi
@HiltViewModel
class MixEditorViewModel @Inject constructor(private val env: Env) : ViewModel() {
    val state = MutableStateFlow(EditorState())
    private var validateJob: Job? = null
    private var loaded = false

    fun init(recipeId: String?) {
        if (loaded) return
        loaded = true
        if (recipeId != null) viewModelScope.launch {
            state.update { it.copy(busy = true) }
            try {
                val r = apiCall(retries = 1) { env.api.recipe(recipeId) }
                state.update { it.copy(plan = r.mixPlan, name = r.name, prompt = r.prompt, planner = r.planner, recipeId = r.id, recipeVersion = r.version,
                    assets = r.assets.orEmpty().associateBy { a -> a.id }, validation = r.validation, busy = false) }
            } catch (e: ApiError) { state.update { it.copy(message = e.message, busy = false) } }
        } else PendingPlan.response?.let { r ->
            state.update { it.copy(plan = r.plan, name = r.plan.title, prompt = PendingPlan.prompt, planner = r.provider, warnings = r.warnings,
                assets = r.assets.associateBy { a -> a.id }, validation = r.validation, dirty = true) }
            PendingPlan.response = null
        }
        scheduleValidation()
    }

    fun rename(n: String) = state.update { it.copy(name = n, dirty = true) }

    fun edit(change: (MixPlan) -> MixPlan) {
        state.update { it.copy(plan = change(it.plan), dirty = true) }
        val p = state.value.plan
        if (env.fusion.isPreparedFor(p)) env.fusion.update(p)
        scheduleValidation()
    }

    fun editLayer(id: String, change: (MixLayer) -> MixLayer) = edit { p -> p.copy(layers = p.layers.map { if (it.id == id) change(it) else it }) }

    fun addLayer(a: Asset) {
        state.update { it.copy(assets = it.assets + (a.id to a)) }
        val p = state.value.plan
        val role = if (a.isSpoken) LayerRole.SPEECH else if ("ambient" in a.genres && a.tempoBpm == null) LayerRole.AMBIENCE else LayerRole.MUSIC
        val next = (p.layers.mapNotNull { it.id.removePrefix("layer-").toIntOrNull() }.maxOrNull() ?: 0) + 1
        val start = if (role == LayerRole.SPEECH) maxOf(0, p.durationMs / 2 - minOf(a.durationMs, p.durationMs / 2) / 2) else 0
        val dur = if (!a.isSpoken) p.durationMs - start else minOf(a.durationMs, p.durationMs - start)
        edit { plan ->
            plan.copy(
                layers = plan.layers + MixLayer("layer-$next", a.id, role, startMs = start, durationMs = maxOf(1000, dur),
                    gainDb = if (role == LayerRole.SPEECH) 0.0 else -12.0, fadeInMs = if (role == LayerRole.SPEECH) 1500 else 5000,
                    fadeOutMs = if (role == LayerRole.SPEECH) 2500 else 8000, loop = !a.isSpoken && a.durationMs < dur),
                ducking = plan.ducking ?: Ducking(true),
            )
        }
    }

    fun removeLayer(id: String) = edit { p -> p.copy(layers = p.layers.filterNot { it.id == id }, transitions = p.transitions?.filterNot { it.fromLayerId == id || it.toLayerId == id }) }

    /** Server is authoritative: schema, semantics and rights (e.g. rejects layers not cleared for mixing). */
    private fun scheduleValidation() {
        validateJob?.cancel()
        val snapshot = state.value.plan
        if (snapshot.layers.isEmpty()) return
        validateJob = viewModelScope.launch {
            delay(500)
            runCatching { apiCall { env.api.validate(ValidateBody(snapshot)) } }.onSuccess { v ->
                state.update { s -> s.copy(validation = v.toValidation(), assets = s.assets + v.assets.associateBy { it.id }) }
                if (!v.valid) env.analytics.track("fusion_plan_rejected", "layerCount" to snapshot.layers.size)
            }
        }
    }

    fun togglePreview() = viewModelScope.launch {
        val s = state.value
        val engineState = env.fusion.state.value
        if (engineState.phase == FusionEngine.Phase.PLAYING) { env.fusion.pause(); return@launch }
        if (env.fusion.isPreparedFor(s.plan)) { env.fusion.update(s.plan); env.fusion.play(); return@launch }
        state.update { it.copy(busy = true, message = null, prepareProgress = 0.0) }
        try {
            val auth = if (s.recipeId != null && !s.dirty) apiCall { env.api.authorizeRecipe(s.recipeId) } else apiCall { env.api.authorizePreview(PlanBody(s.plan)) }
            if (auth.blockedLayers.isNotEmpty()) state.update { it.copy(message = "Some layers were removed for playback: " + auth.blockedLayers.joinToString(" ") { b -> b.message }) }
            env.playback.pause()
            env.fusion.prepare(auth) { p -> state.update { it.copy(prepareProgress = p) } }
            env.fusion.state.value.error?.let { err -> state.update { it.copy(message = err) }; return@launch }
            env.fusion.play()
            env.analytics.track("fusion_preview_started", "layerCount" to auth.plan.layers.size)
        } catch (e: ApiError) {
            state.update { it.copy(message = e.message) }
        } catch (e: Exception) {
            android.util.Log.e("VibeFusion", "preview failed", e)
            state.update { it.copy(message = "Preview couldn't start: ${e.message ?: e.javaClass.simpleName}") }
        } finally { state.update { it.copy(busy = false, prepareProgress = null) } }
    }

    fun seek(ms: Double) = env.fusion.seek(ms)

    fun save() = viewModelScope.launch {
        val s = state.value
        state.update { it.copy(busy = true) }
        try {
            val plan = s.plan.copy(title = s.name)
            val r = if (s.recipeId != null) apiCall { env.api.updateRecipe(s.recipeId, UpdateRecipeBody(s.name, plan, s.recipeVersion)) }
            else apiCall { env.api.saveRecipe(SaveRecipeBody(s.name, s.prompt, plan, s.planner), newIdempotencyKey()) }
            state.update { it.copy(recipeId = r.id, recipeVersion = r.version, plan = r.mixPlan, validation = r.validation ?: it.validation, dirty = false,
                message = if (r.rightsValidationStatus == "valid") "Saved." else "Saved, but some layers need attention before playback.") }
            env.analytics.track("fusion_recipe_saved", "layerCount" to plan.layers.size)
            env.library.refresh()
        } catch (e: ApiError) {
            state.update { it.copy(message = if (e.code == "VERSION_CONFLICT") "This mix changed on another device. Reopen it to get the latest version." else e.message) }
        } finally { state.update { it.copy(busy = false) } }
    }

    /** On-device render, only when every layer is licensed for derivative renders (server re-checks). */
    fun export() = viewModelScope.launch {
        val s = state.value
        val id = s.recipeId ?: return@launch
        state.update { it.copy(busy = true, renderProgress = 0.0) }
        try {
            val auth = apiCall { env.api.render(RenderBody(id), newIdempotencyKey()) }
            val file = env.fusion.export(auth, s.name) { p -> state.update { it.copy(renderProgress = p) } }
            runCatching { env.api.completeRender(auth.jobId, CompleteRenderBody("completed")) }
            state.update { it.copy(exported = file, exportAttribution = auth.attribution, message = "Exported to ${file.parentFile?.name}/${file.name}") }
        } catch (e: ApiError) { state.update { it.copy(message = e.message) } }
        catch (e: Exception) { state.update { it.copy(message = "Export failed: ${e.message}") } }
        finally { state.update { it.copy(busy = false, renderProgress = null) } }
    }

    fun share() = viewModelScope.launch {
        val id = state.value.recipeId ?: return@launch
        runCatching { apiCall { env.api.share(id) } }.onSuccess { r -> state.update { it.copy(shareUrl = r.url) } }.onFailure { e -> state.update { it.copy(message = e.message) } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@UnstableApi
@Composable
fun StudioScreen() {
    val env = LocalEnv.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var prompt by remember { mutableStateOf("") }
    var minutes by remember { mutableFloatStateOf(15f) }
    var mood by remember { mutableStateOf("uplifting") }
    var energy by remember { mutableStateOf("gradual_build") }
    var genres by remember { mutableStateOf(setOf("cinematic", "electronic")) }
    var includeSpeech by remember { mutableStateOf(true) }
    var topic by remember { mutableStateOf("resilience") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val (status, _) = rememberLoad { apiCall { api.fusionStatus() } }
    val (recipes, retryRecipes) = rememberLoad { apiCall { api.recipes() }.items }
    val examples = listOf(
        "Create a 20-minute uplifting session that begins with calm piano, gradually introduces cinematic strings and electronic percussion, and includes a motivational speech near the middle.",
        "A calm 10-minute focus bed with soft ambient pads and gentle rain.",
        "An energetic 15-minute workout mix with a short pep talk about discipline.",
    )
    ScreenScaffold("AI Studio", back = false) { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            (status as? LoadState.Loaded)?.value?.takeIf { !it.aiAvailable }?.let {
                item { Text("AI planning is running in offline mode (deterministic planner). Manual mixing and playback work as normal.", Modifier.clip(RoundedCornerShape(12.dp)).background(VfColors.Surface).padding(12.dp)) }
            }
            item {
                Text("Describe your session", style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(prompt, { prompt = it }, Modifier.fillMaxWidth().heightIn(min = 110.dp).semantics { contentDescription = "Mix prompt" })
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    items(examples) { e ->
                        Text(e, maxLines = 2, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(220.dp).clip(RoundedCornerShape(8.dp)).background(VfColors.Surface)
                            .clickable { prompt = e; Regex("(\\d+)-minute").find(e)?.groupValues?.get(1)?.toFloatOrNull()?.let { minutes = it } }.padding(8.dp)
                            .semantics { contentDescription = "Use example: $e" })
                    }
                }
            }
            item {
                Column(Modifier.clip(RoundedCornerShape(12.dp)).background(VfColors.Surface).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row { Text("Duration", Modifier.weight(1f)); Text("${minutes.toInt()} min") }
                    Slider(minutes, { minutes = it }, valueRange = 1f..60f, steps = 58, modifier = Modifier.semantics { contentDescription = "Session duration"; stateDescription = "${minutes.toInt()} minutes" })
                    Text("Mood"); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("uplifting", "calm", "energetic", "focus", "relaxed").forEach { m -> VfChip(m, mood == m) { mood = m } } }
                    Text("Energy curve"); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("gradual_build" to "Gradual build", "steady" to "Steady", "wind_down" to "Wind down", "peak_middle" to "Peak in middle").forEach { (k, l) -> VfChip(l, energy == k) { energy = k } }
                    }
                    Text("Genres & instruments"); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("ambient", "cinematic", "electronic", "classical", "piano", "jazz", "chillout", "world").forEach { g -> VfChip(g, g in genres) { genres = if (g in genres) genres - g else genres + g } }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) { Text("Include a speech", Modifier.weight(1f)); Switch(includeSpeech, { includeSpeech = it }) }
                    if (includeSpeech) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { TOPICS.forEach { t -> VfChip(t, topic == t) { topic = t } } }
                        Text("Speeches come from public-domain readings. Voice cloning of real people is never used.", style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary)
                    }
                }
            }
            error?.let { item { Text(it, color = VfColors.Destructive) } }
            item {
                PrimaryButton("Generate mix plan", loading = busy, enabled = prompt.isNotBlank(), icon = Icons.Default.AutoAwesome) {
                    scope.launch {
                        busy = true; error = null
                        env.analytics.track("fusion_prompt_submitted")
                        try {
                            val r = apiCall { env.api.plan(FusionRequest(prompt, minutes.toInt() * 60_000, mood, energy, genres.sorted(), includeSpeech, if (includeSpeech) topic else null, constraints = FusionRequest.Constraints(4, true))) }
                            env.analytics.track("fusion_plan_generated", "provider" to r.provider, "layerCount" to r.plan.layers.size)
                            PendingPlan.response = r; PendingPlan.prompt = prompt
                            nav.navigate("editor")
                        } catch (e: ApiError) {
                            error = if (e.code == "AI_UNAVAILABLE" || e.code == "QUOTA_EXCEEDED") "${e.message} You can still build a mix manually." else e.message
                        } finally { busy = false }
                    }
                }
            }
            item { SecondaryButton("Build manually", icon = Icons.Default.Tune) { PendingPlan.response = null; nav.navigate("editor") } }
            (recipes as? LoadState.Loaded)?.value?.takeIf { it.isNotEmpty() }?.let { list ->
                item { SectionHeader("Saved mixes") { IconButton(onClick = retryRecipes) { Icon(Icons.Default.Refresh, "Refresh") } } }
                items(list, key = { it.id }) { r ->
                    ListItem({ Text(r.name) }, supportingContent = { Text("${formatDuration(r.durationMs)} · ${r.mixPlan.layers.size} layers") },
                        trailingContent = { if (r.rightsValidationStatus != "valid") Icon(Icons.Default.Warning, "Needs attention", tint = VfColors.Accent) },
                        modifier = Modifier.clickable { nav.navigate("recipe/${r.id}") }, colors = ListItemDefaults.colors(containerColor = Color.Transparent))
                }
            }
            (status as? LoadState.Loaded)?.value?.let { item { Text(it.disclosure, style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary) } }
        }
    }
}

@UnstableApi
@Composable
fun MixEditorScreen(recipeId: String?, vm: MixEditorViewModel = hiltViewModel()) {
    val env = LocalEnv.current
    val ctx = LocalContext.current
    LaunchedEffect(recipeId) { vm.init(recipeId) }
    val s by vm.state.collectAsState()
    val fs by env.fusion.state.collectAsState()
    val session by env.session.state.collectAsState()
    var picker by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf<String?>(null) }
    val prepared = env.fusion.isPreparedFor(s.plan) && fs.phase != FusionEngine.Phase.IDLE
    val playing = prepared && fs.phase == FusionEngine.Phase.PLAYING
    ScreenScaffold("Editor") { pad ->
        LazyColumn(Modifier.padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { OutlinedTextField(s.name, vm::rename, Modifier.fillMaxWidth(), textStyle = MaterialTheme.typography.titleLarge, label = { Text("Mix name") }) }
            s.prompt?.let { item { Text("“$it”", color = VfColors.TextSecondary, maxLines = 3) } }
            item {
                Column(Modifier.clip(RoundedCornerShape(20.dp)).background(VfColors.Surface).padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        FilledIconButton(onClick = { vm.togglePreview() }, enabled = s.plan.layers.isNotEmpty() && !s.busy, modifier = Modifier.size(56.dp)) {
                            Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "Pause preview" else "Preview mix")
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            when {
                                s.prepareProgress != null -> { Text("Loading layers…", style = MaterialTheme.typography.labelSmall); LinearProgressIndicator(progress = { s.prepareProgress!!.toFloat() }) }
                                s.renderProgress != null -> { Text("Rendering…", style = MaterialTheme.typography.labelSmall); LinearProgressIndicator(progress = { s.renderProgress!!.toFloat() }) }
                                else -> {
                                    Text(if (prepared) "${formatDuration(fs.positionMs.toInt())} / ${formatDuration(s.plan.durationMs)}" else formatDuration(s.plan.durationMs), style = MaterialTheme.typography.titleMedium)
                                    if (prepared && fs.duckActive) Text("Ducking for speech", color = VfColors.Accent, style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                        if (s.busy) CircularProgressIndicator(Modifier.size(24.dp))
                    }
                    if (prepared) Slider(fs.positionMs.toFloat(), { vm.seek(it.toDouble()) }, valueRange = 0f..s.plan.durationMs.toFloat(),
                        modifier = Modifier.semantics { contentDescription = "Session position"; stateDescription = formatDuration(fs.positionMs.toInt()) })
                }
            }
            s.message?.let { item { Text(it, color = VfColors.Accent) } }
            items(s.warnings) { w -> Text("ⓘ $w", style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary) }
            item {
                val general = s.validation?.errors?.filter { it.layerId == null }.orEmpty()
                when {
                    s.localIssues.isNotEmpty() || general.isNotEmpty() -> Column { (s.localIssues + general.map { it.message }).forEach { Text("⚠ $it", color = VfColors.Destructive, style = MaterialTheme.typography.bodySmall) } }
                    s.validation?.valid == true -> Text("✓ Plan is valid and every layer is cleared for mixing.", color = VfColors.Secondary, style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Session length", Modifier.weight(1f))
                    IconButton(onClick = { vm.edit { it.copy(durationMs = maxOf(60_000, it.durationMs - 60_000)) } }) { Icon(Icons.Default.Remove, "Shorter") }
                    Text("${s.plan.durationMs / 60_000} min")
                    IconButton(onClick = { vm.edit { it.copy(durationMs = minOf(120 * 60_000, it.durationMs + 60_000)) } }) { Icon(Icons.Default.Add, "Longer") }
                }
            }
            item {
                SectionHeader("Timeline")
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    s.plan.layers.forEach { l -> LayerTimelineBar(l.startMs, l.durationMs, s.plan.durationMs, l.role, l.muted == true, if (prepared) fs.levels[l.id] ?: 0.0 else 0.3, s.title(l)) }
                }
            }
            items(s.plan.layers, key = { it.id }) { l -> LayerCard(l, s, vm, expanded == l.id) { expanded = if (expanded == l.id) null else l.id } }
            item { SecondaryButton("Add layer", icon = Icons.Default.Add) { if (s.plan.layers.size < 6) picker = true } }
            item {
                Column(Modifier.clip(RoundedCornerShape(12.dp)).background(VfColors.Surface).padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Duck music under speech", Modifier.weight(1f))
                        Switch(s.plan.ducking?.enabled == true, { on -> vm.edit { p -> p.copy(ducking = (p.ducking ?: Ducking(on)).copy(enabled = on)) } })
                    }
                    if (s.plan.ducking?.enabled == true) {
                        val amt = s.plan.ducking?.amountDb ?: 9.0
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Amount")
                            Slider(amt.toFloat(), { v -> vm.edit { p -> p.copy(ducking = p.ducking?.copy(amountDb = Math.round(v).toDouble())) } }, valueRange = 3f..18f,
                                modifier = Modifier.weight(1f).semantics { contentDescription = "Ducking amount"; stateDescription = "${amt.toInt()} decibels" })
                            Text("${amt.toInt()} dB")
                        }
                    }
                }
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(if (s.recipeId == null) "Save recipe" else "Save changes", loading = s.busy, enabled = s.localIssues.isEmpty(), icon = Icons.Default.Save) { vm.save() }
                    if (s.canExport && session == SessionState.ACCOUNT) SecondaryButton("Export audio (on device)", icon = Icons.Default.FileDownload) { vm.export() }
                    else if (s.recipeId != null) Text("Export is available only when every layer is licensed for rendered derivatives.", style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary)
                    s.exported?.let { f ->
                        TextButton(onClick = {
                            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
                            ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("audio/wav").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share export"))
                        }) { Text("Open exported file") }
                        s.exportAttribution?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary) }
                    }
                    if (s.recipeId != null && session == SessionState.ACCOUNT && s.validation?.valid == true) {
                        TextButton(onClick = { vm.share() }) { Icon(Icons.Default.Link, null); Text(" Create share link (recipe only)") }
                        s.shareUrl?.let { u -> TextButton(onClick = { ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, u), "Share")) }) { Text(u) } }
                    }
                }
            }
        }
    }
    if (picker) AssetPickerDialog(onDismiss = { picker = false }) { vm.addLayer(it); picker = false }
}

@UnstableApi
@Composable
private fun LayerCard(l: MixLayer, s: EditorState, vm: MixEditorViewModel, expanded: Boolean, onExpand: () -> Unit) {
    val issues = s.validation?.errors?.filter { it.layerId == l.id }.orEmpty()
    Column(
        Modifier.clip(RoundedCornerShape(12.dp)).background(VfColors.Surface).border(1.dp, if (issues.isEmpty()) Color.Transparent else VfColors.Destructive, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(VfColors.role(l.role)))
            Column(Modifier.weight(1f).padding(start = 8.dp)) {
                Text(s.title(l), fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(l.role.name.lowercase().replaceFirstChar { it.uppercase() } + if (l.loop) " · loop" else "", style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary)
            }
            RoundToggle("M", l.muted == true, VfColors.Destructive, "Mute") { vm.editLayer(l.id) { it.copy(muted = !(it.muted ?: false)) } }
            Spacer(Modifier.width(6.dp))
            RoundToggle("S", l.solo == true, VfColors.Secondary, "Solo") { vm.editLayer(l.id) { it.copy(solo = !(it.solo ?: false)) } }
            IconButton(onClick = onExpand) { Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.Tune, "Layer settings") }
        }
        GainSlider(l.gainDb, s.title(l)) { g -> vm.editLayer(l.id) { it.copy(gainDb = g) } }
        issues.forEach { Text("⚠ ${it.message}", color = VfColors.Destructive, style = MaterialTheme.typography.bodySmall) }
        if (expanded) {
            val assetDur = s.assets[l.assetId]?.durationMs ?: 0
            MsStepper("Starts at", l.startMs, 5000, s.plan.durationMs - 1000) { v -> vm.editLayer(l.id) { it.copy(startMs = v) } }
            MsStepper("Length", l.durationMs, 5000, s.plan.durationMs) { v -> vm.editLayer(l.id) { it.copy(durationMs = maxOf(1000, v)) } }
            MsStepper("Source offset", l.sourceInMs, 1000, maxOf(0, assetDur - 1000)) { v -> vm.editLayer(l.id) { it.copy(sourceInMs = v) } }
            MsStepper("Fade in", l.fadeInMs, 500, 60_000) { v -> vm.editLayer(l.id) { it.copy(fadeInMs = v) } }
            MsStepper("Fade out", l.fadeOutMs, 500, 60_000) { v -> vm.editLayer(l.id) { it.copy(fadeOutMs = v) } }
            Row(verticalAlignment = Alignment.CenterVertically) { Text("Loop", Modifier.weight(1f)); Switch(l.loop, { on -> vm.editLayer(l.id) { it.copy(loop = on) } }) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Pan")
                Slider(l.pan.toFloat(), { v -> vm.editLayer(l.id) { it.copy(pan = Math.round(v * 10) / 10.0) } }, valueRange = -1f..1f,
                    modifier = Modifier.weight(1f).semantics { contentDescription = "Pan"; stateDescription = "%.1f".format(l.pan) })
            }
            Row { LayerRole.entries.forEach { r -> VfChip(r.name.lowercase(), l.role == r) { vm.editLayer(l.id) { it.copy(role = r) } } ; Spacer(Modifier.width(4.dp)) } }
            TextButton(onClick = { vm.removeLayer(l.id) }) { Icon(Icons.Default.Delete, null, tint = VfColors.Destructive); Text(" Remove layer", color = VfColors.Destructive) }
        }
    }
}

@Composable
private fun MsStepper(label: String, value: Int, step: Int, max: Int, onChange: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        IconButton(onClick = { onChange((value - step).coerceIn(0, maxOf(0, max))) }) { Icon(Icons.Default.Remove, "Decrease $label") }
        Text(formatDuration(value), Modifier.width(56.dp))
        IconButton(onClick = { onChange((value + step).coerceIn(0, maxOf(0, max))) }) { Icon(Icons.Default.Add, "Increase $label") }
    }
}

/** Mix-cleared audio first; anything else is rejected by server validation with an explanation (Scenario D). */
@UnstableApi
@Composable
private fun AssetPickerDialog(onDismiss: () -> Unit, onPick: (Asset) -> Unit) {
    var mixableOnly by remember { mutableStateOf(true) }
    var q by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf("") }
    val (state, retry) = rememberLoad(mixableOnly, submitted) {
        if (submitted.length >= 2) apiCall { api.search(submitted) }.let { r -> (r.tracks + r.speeches + r.episodes).filter { !mixableOnly || it.capabilities.mix } }
        else apiCall { api.catalogue(type = "loop,stem,music,speech", mixable = if (mixableOnly) true else null) }.items
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("Add a layer") },
        text = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) { Text("Only audio cleared for mixing", Modifier.weight(1f)); Switch(mixableOnly, { mixableOnly = it }) }
                OutlinedTextField(q, { q = it; if (it.length >= 2 || it.isEmpty()) submitted = it }, Modifier.fillMaxWidth(), placeholder = { Text("Search") }, singleLine = true)
                LazyColumn(Modifier.heightIn(max = 380.dp)) {
                    item {
                        StateContent(state, retry, isEmpty = { it.isEmpty() }, emptyMessage = "No matching audio.") { list ->
                            Column { list.forEach { a -> TrackRow(a, trailing = { if (!a.capabilities.mix) Text("Not cleared", color = VfColors.Accent, style = MaterialTheme.typography.labelSmall) }) { onPick(a) } } }
                        }
                    }
                }
            }
        },
    )
}
