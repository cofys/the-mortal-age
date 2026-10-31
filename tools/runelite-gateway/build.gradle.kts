plugins { kotlin("jvm") version "2.1.20"; application }
repositories { mavenCentral() }
dependencies {
 implementation("org.apache.commons:commons-compress:1.27.1")
 implementation("net.rsprot:osrs-241-api:1.0.0-ALPHA-20261014")
 implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.18.2")
 implementation("org.slf4j:slf4j-simple:2.0.16")
 testImplementation(kotlin("test-junit5"))
 testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
kotlin { jvmToolchain(21) }
application { mainClass.set("gateway.MainKt") }
tasks.test { useJUnitPlatform() }
