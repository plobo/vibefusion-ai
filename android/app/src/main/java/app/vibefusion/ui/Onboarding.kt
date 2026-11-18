package app.vibefusion.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import app.vibefusion.R
import app.vibefusion.core.designsystem.*
import app.vibefusion.core.model.ApiError
import kotlinx.coroutines.launch

val GENRES = listOf("ambient", "electronic", "cinematic", "classical", "piano", "jazz", "chillout", "rock", "hip-hop", "world")
val MOODS = listOf("calm", "uplifting", "energetic", "focus", "relaxed", "reflective")
val TOPICS = listOf("discipline", "confidence", "career", "resilience", "leadership", "fitness", "mindfulness")

@OptIn(ExperimentalLayoutApi::class)
@UnstableApi
@Composable
fun OnboardingFlow(startAtInterests: Boolean) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableIntStateOf(if (startAtInterests) 2 else 0) }
    val notif = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { step = 4 }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(VfColors.Primary.copy(alpha = 0.5f), VfColors.Background))).systemBarsPadding()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            when (step) {
                0 -> {
                    Spacer(Modifier.height(80.dp))
                    Icon(Icons.Default.GraphicEq, null, tint = VfColors.Primary, modifier = Modifier.size(96.dp).align(Alignment.CenterHorizontally))
                    Text("VibeFusion AI", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.CenterHorizontally))
                    Text(stringResource(R.string.welcome_body), color = VfColors.TextSecondary, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(60.dp))
                    PrimaryButton(stringResource(R.string.get_started)) { step = 1 }
                }
                1 -> AuthStep(onDone = { step = 2 })
                2 -> {
                    var g by remember { mutableStateOf(setOf<String>()) }
                    var m by remember { mutableStateOf(setOf<String>()) }
                    var t by remember { mutableStateOf(setOf<String>()) }
                    Text(stringResource(R.string.interests_title), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.interests_body), color = VfColors.TextSecondary)
                    listOf(Triple("Genres", GENRES, g), Triple("Moods", MOODS, m), Triple("Speech topics", TOPICS, t)).forEachIndexed { idx, (title, opts, sel) ->
                        Text(title, style = MaterialTheme.typography.titleMedium)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            opts.forEach { o -> VfChip(o, o in sel) { val n = if (o in sel) sel - o else sel + o; when (idx) { 0 -> g = n; 1 -> m = n; else -> t = n } } }
                        }
                    }
                    PrimaryButton(stringResource(R.string.continue_)) {
                        scope.launch { env.session.savePreferences(env.session.preferences.value.copy(genres = g.toList(), moods = m.toList(), speechTopics = t.toList())) }
                        step = 3
                    }
                    TextButton(onClick = { step = 3 }, Modifier.fillMaxWidth()) { Text(stringResource(R.string.skip)) }
                }
                3 -> {
                    Spacer(Modifier.height(80.dp))
                    Icon(Icons.Default.NotificationsActive, null, tint = VfColors.Secondary, modifier = Modifier.size(64.dp).align(Alignment.CenterHorizontally))
                    Text(stringResource(R.string.notif_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    Text(stringResource(R.string.notif_body), color = VfColors.TextSecondary, textAlign = TextAlign.Center)
                    PrimaryButton(stringResource(R.string.allow_notifications)) {
                        if (Build.VERSION.SDK_INT >= 33) notif.launch(Manifest.permission.POST_NOTIFICATIONS) else step = 4
                    }
                    TextButton(onClick = { step = 4 }, Modifier.fillMaxWidth()) { Text(stringResource(R.string.not_now)) }
                }
                else -> {
                    var accepted by remember { mutableStateOf(false) }
                    Text(stringResource(R.string.terms_title), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                    listOf(R.string.terms_1 to Icons.Default.Verified, R.string.terms_2 to Icons.Default.Public, R.string.terms_3 to Icons.Default.AutoAwesome, R.string.terms_4 to Icons.Default.Shield).forEach { (s, i) ->
                        Row { Icon(i, null, tint = VfColors.Secondary); Spacer(Modifier.width(12.dp)); Text(stringResource(s)) }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.terms_agree), Modifier.weight(1f))
                        Switch(checked = accepted, onCheckedChange = { accepted = it }, modifier = Modifier.semantics { contentDescription = "Agree to terms" })
                    }
                    PrimaryButton(stringResource(R.string.start_listening), enabled = accepted) { scope.launch { env.settings.setOnboarded(true) } }
                }
            }
        }
    }
}

@UnstableApi
@Composable
private fun AuthStep(onDone: () -> Unit) {
    val env = LocalEnv.current
    val scope = rememberCoroutineScope()
    var create by remember { mutableStateOf(true) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun run(block: suspend () -> Unit) = scope.launch {
        busy = true; error = null
        try { block(); onDone() } catch (e: ApiError) { error = e.message } finally { busy = false }
    }
    Spacer(Modifier.height(32.dp))
    Text(stringResource(if (create) R.string.create_account_title else R.string.welcome_back), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        SegmentedButton(create, { create = true }, SegmentedButtonDefaults.itemShape(0, 2)) { Text(stringResource(R.string.create_account)) }
        SegmentedButton(!create, { create = false }, SegmentedButtonDefaults.itemShape(1, 2)) { Text(stringResource(R.string.sign_in)) }
    }
    if (create) OutlinedTextField(name, { name = it }, label = { Text("Display name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
    OutlinedTextField(email, { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth(), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
    OutlinedTextField(password, { password = it }, label = { Text("Password (8+ characters)") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
    error?.let { Text(it, color = VfColors.Destructive) }
    PrimaryButton(stringResource(if (create) R.string.create_account else R.string.sign_in), loading = busy) {
        run { if (create) env.session.register(email.trim(), password, name.ifBlank { null }) else env.session.login(email.trim(), password) }
    }
    TextButton(onClick = { run { env.session.guest() } }, Modifier.fillMaxWidth()) { Text(stringResource(R.string.continue_as_guest)) }
    Text(stringResource(R.string.guest_note), color = VfColors.TextSecondary, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
}
