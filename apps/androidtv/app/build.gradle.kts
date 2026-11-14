import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/**
 * Release 签名：从 `apps/androidtv/keystore.properties` 读（已 gitignore）。
 * 没有这个文件时退回 debug 签名，保证克隆下来就能 `assembleRelease`，
 * 只是产物不能覆盖安装别人的版本。
 */
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { stream -> load(stream) }
}

android {
    namespace = "org.librextv.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.librextv.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = 20
        versionName = "1.3.11"
    }

    /**
     * 两个形态共用同一套数据层、ViewModel 与播放内核，只把 UI、Activity 与清单分开：
     * - `tv`    ：遥控器 / 横屏 / Leanback 启动器，applicationId 保持 `org.librextv.tv`（老用户可直接覆盖升级）
     * - `phone` ：触摸 / 可旋转 / 常规启动器，applicationId 用 `org.librextv.tv.phone`（可与电视版同机共存）
     *
     * 共用部分放在 `src/main`（data/、cast/、AppViewModel、NavBack、LibreXtvApp、ui/theme/），
     * 各自的界面放 `src/tv`、`src/phone`。改数据层只需要改一处。
     */
    flavorDimensions += "form"
    productFlavors {
        create("tv") {
            dimension = "form"
            applicationId = "org.librextv.tv"
        }
        create("phone") {
            dimension = "form"
            applicationId = "org.librextv.tv.phone"
        }
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                // storeFile 相对 apps/androidtv/ 解析，与 keystore.properties 同目录
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystoreProps.isNotEmpty()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    /**
     * Compose UI 测试跑在 JVM 上（Robolectric），需要能读到 Android 资源。
     * 电视端的焦点/导航类缺陷（H3、T-1、T-2）以前零覆盖，就是因为没有这条通道。
     */
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

/**
 * 默认源清单与仓库根目录的 defaults/sources.json 保持同一份：
 * 构建时复制到 assets，避免两端各维护一份 JSON 走样。
 */
val copyDefaultSources by tasks.registering(Copy::class) {
    from(rootProject.file("../../defaults/sources.json"))
    into(layout.projectDirectory.dir("src/main/assets"))
    rename { "default-sources.json" }
}

tasks.named("preBuild") {
    dependsOn(copyDefaultSources)
}

dependencies {
    testImplementation("junit:junit:4.13.2")

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    // Compose UI 测试（Robolectric 下跑 JVM，不需要真机/模拟器）：
    // 焦点与遥控器按键是电视端最容易回归又最没有测试兜底的一块（见 docs/audit-2026-10-29.md 的 H3/T-1/T-2）
    testImplementation(composeBom)
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    // Compose（Material3 + 自定义电视焦点态：电视端聚焦放大/描边由 TvCard 统一处理）
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")

    // 播放内核：ExoPlayer + HLS
    implementation("androidx.media3:media3-exoplayer:1.5.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.0")
    implementation("androidx.media3:media3-ui:1.5.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
    // ui-test-manifest 提供 ComponentActivity 声明，Robolectric 下 createComposeRule() 依赖它
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
