// CAPPZ Mesh for Android: the mesh web app in a WebView, with Google Nearby Connections as its radio.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.cappz.mesh"
    compileSdk = 34
    defaultConfig {
        applicationId = "ai.cappz.mesh"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "15.13.0"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    // The web app is copied in at build time from packages/cappz-mesh-node/web (run `npm run mesh -- web-build` first).
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/meshweb"))
}

val copyMeshWeb by tasks.registering(Copy::class) {
    from("../../../cappz-mesh-node/web") { include("index.html", "app.js") }
    into(layout.buildDirectory.dir("generated/meshweb/web"))
}
tasks.named("preBuild") { dependsOn(copyMeshWeb) }

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.gms:play-services-nearby:19.3.0")
}
