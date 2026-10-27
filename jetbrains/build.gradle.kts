import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    kotlin("jvm") version "2.4.21"
    kotlin("plugin.serialization") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(25)
    compilerOptions {
        // Interface default methods stay JVM defaults: no generated bridges overriding the platform's deprecated /
        // experimental defaults (ToolWindowFactory, StatusBarWidget), which verifyPlugin reported as usages.
        jvmDefault.set(org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode.NO_COMPATIBILITY)
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    // kotlinx.serialization-json ships with the IDE (lib/intellij.libraries.kotlinx.serialization.json.jar);
    // compile against the bundled version (1.9.0) but don't ship a second copy.
    compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        create(
            providers.gradleProperty("platformType"),
            providers.gradleProperty("platformVersion"),
        )
        // JCEF (JBCefBrowser / JBCefJSQuery) ships as the bundled "Web Browser (JCEF)" plugin in 2026.2.
        bundledPlugin("com.intellij.modules.jcef")
        testFramework(TestFrameworkType.Platform)
    }
}

tasks.test {
    // CoreProcessTest drives the VS Code fake core (`node vscode/test/fakeCore.mjs`), so the tests need Node.js >= 20:
    // found via LOCALPILOT_TEST_NODE, then PATH (node / node.exe), then ~/.nvm; without it those tests are skipped.
    systemProperty("localpilot.sandboxProfile", layout.projectDirectory.file("../sandbox/no-network.sb").asFile.absolutePath)
    systemProperty("localpilot.fakeCore", layout.projectDirectory.file("../vscode/test/fakeCore.mjs").asFile.absolutePath)
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            create(
                IntelliJPlatformType.fromCode(providers.gradleProperty("platformType").get()),
                providers.gradleProperty("platformVersion").get(),
            )
        }
    }
}

tasks.prepareSandbox {
    // The release core ships loose in the plugin, at lib/bin/<triple>/localpilot-core[.exe], where
    // resolveBinaryPath() looks for it (LocalPilotCore.pluginRoot() = the parent of the jar's lib/). Source: what
    // scripts/build-core.sh wrote to ../dist/core/<triple>/. buildPlugin zips this sandbox directory, so runIde and the
    // zip both get it; with no dist/core (CI, tests) nothing is copied and the coreBinaryPath setting is needed instead.
    from(layout.projectDirectory.dir("../dist/core")) {
        include("*/localpilot-core", "*/localpilot-core.exe")
        filePermissions { unix("rwxr-xr-x") }
        into(pluginName.map { "$it/lib/bin" })
    }
    // The no-network sandbox profile, a real file for `sandbox-exec -f`: lib/sandbox/no-network.sb (Sandbox.profilePath).
    from(layout.projectDirectory.file("../sandbox/no-network.sb")) {
        into(pluginName.map { "$it/lib/sandbox" })
    }
}

tasks.buildPlugin {
    // Keep the core's executable bit in the zip (LocalPilotCore also restores it at start-up if an installer drops it).
    filesMatching("**/lib/bin/*/localpilot-core") { permissions { unix("rwxr-xr-x") } }
}
