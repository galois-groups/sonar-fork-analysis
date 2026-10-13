plugins {
    alias(libs.plugins.sonar)
}

sonar {
    properties {
        // Analyses the build scripts too, as projects with scanAll do: the Kotlin analyzer's Gradle rules
        // must find the same issues on the fork path.
        property("sonar.gradle.scanAll", true)
    }
}
