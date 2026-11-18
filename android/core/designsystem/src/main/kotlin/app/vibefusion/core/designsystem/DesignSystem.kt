package app.vibefusion.core.designsystem

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.vibefusion.core.model.ApiError
import app.vibefusion.core.model.Asset
import app.vibefusion.core.model.LayerRole
import app.vibefusion.core.model.formatDuration
import app.vibefusion.core.model.spokenDuration
import coil.compose.SubcomposeAsyncImage
import kotlin.math.abs

/** Tokens mirrored from iOS VFDesignSystem (docs/ARCHITECTURE.md §Design system). */
object VfColors {
    val Background = Color(0xFF090A10)
    val Surface = Color(0xFF13151F)
    val Elevated = Color(0xFF1E212F)
    val Primary = Color(0xFF7C6AFF)
    val Secondary = Color(0xFF34D3C4)
    val Accent = Color(0xFFFF8D57)
    val Destructive = Color(0xFFFF5565)
    val TextPrimary = Color.White
    val TextSecondary = Color.White.copy(alpha = 0.68f)
    fun role(r: LayerRole) = when (r) {
        LayerRole.MUSIC -> Primary; LayerRole.SPEECH -> Accent; LayerRole.AMBIENCE -> Secondary
        LayerRole.PERCUSSION -> Color(0xFFFF6FB5); LayerRole.EFFECT -> Color(0xFFFFD84D)
    }
}

object VfSpacing { val xs = 4.dp; val s = 8.dp; val m = 12.dp; val l = 16.dp; val xl = 24.dp; val xxl = 32.dp }
object VfSize { val artworkSmall = 48.dp; val artworkCard = 148.dp; val artworkHero = 280.dp; val minTouch = 48.dp; val controlPrimary = 72.dp }

private val scheme = darkColorScheme(
    primary = VfColors.Primary, secondary = VfColors.Secondary, tertiary = VfColors.Accent, error = VfColors.Destructive,
    background = VfColors.Background, surface = VfColors.Surface, surfaceVariant = VfColors.Elevated,
    onPrimary = Color.White, onBackground = Color.White, onSurface = Color.White, onSurfaceVariant = VfColors.TextSecondary,
    surfaceContainer = VfColors.Surface, surfaceContainerHigh = VfColors.Elevated,
)

@Composable
fun VibeFusionTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)

@Composable
fun PrimaryButton(text: String, modifier: Modifier = Modifier, loading: Boolean = false, enabled: Boolean = true, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled && !loading, modifier = modifier.fillMaxWidth().heightIn(min = 50.dp), shape = RoundedCornerShape(12.dp)) {
        if (loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
        else { icon?.let { Icon(it, null); Spacer(Modifier.width(8.dp)) }; Text(text, fontWeight = FontWeight.SemiBold) }
    }
}

@Composable
fun SecondaryButton(text: String, modifier: Modifier = Modifier, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(12.dp)) {
        icon?.let { Icon(it, null); Spacer(Modifier.width(8.dp)) }
        Text(text)
    }
}

/** Selection chip; state is conveyed by a check icon and semantics, not colour alone. */
@Composable
fun VfChip(label: String, selected: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected, onClick = onClick,
        label = { Text(label.replaceFirstChar { it.uppercase() }) },
        leadingIcon = if (selected) ({ Icon(Icons.Default.Check, null, Modifier.size(16.dp)) }) else null,
        modifier = Modifier.heightIn(min = 40.dp),
    )
}

@Composable
fun Artwork(url: String?, seed: String, size: Dp, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(if (size > 100.dp) 12.dp else 6.dp)
    val hue = (abs(seed.hashCode()) % 360).toFloat()
    val placeholder = @Composable {
        Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color.hsv(hue, 0.6f, 0.6f), Color.hsv((hue + 36) % 360, 0.7f, 0.3f)))), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.GraphicEq, null, tint = Color.White.copy(alpha = 0.7f), modifier = Modifier.size(size * 0.3f))
        }
    }
    Box(modifier.size(size).clip(shape).clearAndSetSemantics { }) {
        if (url == null) placeholder() else SubcomposeAsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            loading = { placeholder() }, error = { placeholder() })
    }
}

@Composable
fun ArtworkCard(title: String, subtitle: String?, artworkUrl: String?, seed: String, onClick: () -> Unit) {
    Column(Modifier.width(VfSize.artworkCard).clickable(onClick = onClick).semantics(mergeDescendants = true) { role = Role.Button }) {
        Artwork(artworkUrl, seed, VfSize.artworkCard)
        Spacer(Modifier.height(4.dp))
        Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun TrackRow(asset: Asset, isCurrent: Boolean = false, trailing: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = VfSize.minTouch).clickable(onClick = onClick).padding(vertical = 6.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Artwork(asset.artworkUrl, asset.id, VfSize.artworkSmall)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isCurrent) Icon(Icons.Default.VolumeUp, "Now playing", tint = VfColors.Secondary, modifier = Modifier.size(16.dp).padding(end = 4.dp))
                Text(asset.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                val dur = if (asset.isSpoken) spokenDuration(asset.durationMs) else formatDuration(asset.durationMs)
                Text("${asset.creatorName} · $dur", style = MaterialTheme.typography.bodySmall, color = VfColors.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (asset.capabilities.mix) Icon(Icons.Default.Layers, "Cleared for Fusion Studio", tint = VfColors.TextSecondary, modifier = Modifier.padding(start = 4.dp).size(14.dp))
                if (asset.isExplicit) Icon(Icons.Default.Explicit, "Explicit", tint = VfColors.TextSecondary, modifier = Modifier.padding(start = 4.dp).size(14.dp))
            }
        }
        trailing?.invoke()
    }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).semantics { heading() })
        action?.invoke()
    }
}

sealed interface LoadState<out T> {
    data object Loading : LoadState<Nothing>
    data class Loaded<T>(val value: T) : LoadState<T>
    data class Failed(val error: ApiError) : LoadState<Nothing>
}

@Composable
fun <T> StateContent(state: LoadState<T>, onRetry: () -> Unit, isEmpty: (T) -> Boolean = { false }, emptyMessage: String = "Nothing here yet", content: @Composable (T) -> Unit) {
    when (state) {
        LoadState.Loading -> Box(Modifier.fillMaxWidth().heightIn(min = 200.dp).semantics { contentDescription = "Loading" }, Alignment.Center) { CircularProgressIndicator() }
        is LoadState.Failed -> ErrorState(state.error, onRetry)
        is LoadState.Loaded -> if (isEmpty(state.value)) EmptyState(emptyMessage) else content(state.value)
    }
}

@Composable
fun ErrorState(error: ApiError, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(if (error.isOffline) Icons.Default.WifiOff else Icons.Default.Warning, null, tint = VfColors.Accent, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(8.dp))
        Text(error.message, color = VfColors.TextSecondary)
        if (error.retryable || error.isOffline) TextButton(onClick = onRetry) { Text("Try again") }
    }
}

@Composable
fun EmptyState(message: String) {
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.QueueMusic, null, tint = VfColors.TextSecondary, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(8.dp))
        Text(message, color = VfColors.TextSecondary)
    }
}

/** Gain slider in dB with an accessible spoken value. */
@Composable
fun GainSlider(gainDb: Double, label: String, onChange: (Double) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Default.VolumeDown, null, tint = VfColors.TextSecondary, modifier = Modifier.size(16.dp))
        Slider(
            value = gainDb.toFloat(), onValueChange = { onChange(Math.round(it).toDouble()) }, valueRange = -40f..6f, steps = 45,
            modifier = Modifier.weight(1f).semantics { contentDescription = "$label volume"; stateDescription = "${gainDb.toInt()} decibels" },
        )
        Text("${gainDb.toInt()} dB", style = MaterialTheme.typography.labelSmall, color = VfColors.TextSecondary, modifier = Modifier.width(52.dp))
    }
}

/** Simplified timeline bar for one layer. */
@Composable
fun LayerTimelineBar(start: Int, duration: Int, sessionMs: Int, role: LayerRole, muted: Boolean, level: Double, title: String) {
    val f0 = start.toFloat() / sessionMs.coerceAtLeast(1)
    val fw = (duration.toFloat() / sessionMs.coerceAtLeast(1)).coerceAtLeast(0.01f)
    Box(
        Modifier.fillMaxWidth().height(28.dp).clip(RoundedCornerShape(4.dp)).background(VfColors.Elevated)
            .semantics { contentDescription = "${role.name.lowercase()} layer $title, starts at ${formatDuration(start)}, lasts ${formatDuration(duration)}${if (muted) ", muted" else ""}" },
    ) {
        Row(Modifier.fillMaxSize()) {
            if (f0 > 0f) Spacer(Modifier.weight(f0))
            Box(
                Modifier.weight(fw.coerceAtMost(1f - f0).coerceAtLeast(0.01f)).fillMaxHeight().clip(RoundedCornerShape(4.dp))
                    .background(VfColors.role(role).copy(alpha = if (muted) 0.25f else (0.4f + 0.6f * (level * 3).toFloat().coerceAtMost(1f)))),
                contentAlignment = Alignment.CenterStart,
            ) { Text(title, style = MaterialTheme.typography.labelSmall, maxLines = 1, modifier = Modifier.padding(horizontal = 4.dp)) }
            val rest = 1f - f0 - fw
            if (rest > 0.001f) Spacer(Modifier.weight(rest))
        }
    }
}

@Composable
fun RoundToggle(text: String, on: Boolean, onColor: Color, description: String, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(CircleShape).background(if (on) onColor else VfColors.Elevated).border(1.dp, Color.White.copy(alpha = 0.1f), CircleShape)
            .clickable(onClick = onClick).semantics { contentDescription = description; stateDescription = if (on) "On" else "Off"; role = Role.Switch },
        contentAlignment = Alignment.Center,
    ) { Text(text, fontWeight = FontWeight.Bold) }
}
