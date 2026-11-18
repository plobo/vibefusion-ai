plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)

}
android {
    namespace = "app.vibefusion.core.audio"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    api(project(":core:model"))
    api(libs.media3.exoplayer)
    api(libs.media3.session)
    api(libs.media3.common)
    implementation(libs.coroutines.android)
    testImplementation(libs.junit)
}
