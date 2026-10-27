import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // custom-server.js requires("./runtime-secrets.cjs") at module load; without it
  // the standalone process throws on startup in production.
  const secretsSource = resolve(projectRoot, "runtime-secrets.cjs");
  const secretsDestination = resolve(standaloneDir, "runtime-secrets.cjs");
  if (existsSync(secretsSource)) {
    cpSync(secretsSource, secretsDestination, { force: true });
    console.log(`[standalone-assets] Copied runtime-secrets.cjs to ${secretsDestination}`);
  }

  // custom-server.js requires ./src/lib/cluster/{supervisor,worker}.js by relative path.
  // Next does not bundle that outside its own graph, so copy the directory verbatim.
  const clusterSource = resolve(projectRoot, "src", "lib", "cluster");
  const clusterDestination = resolve(standaloneDir, "src", "lib", "cluster");
  if (existsSync(clusterSource)) {
    cpSync(clusterSource, clusterDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied src/lib/cluster to ${clusterDestination}`);
  }

  // Next's standalone tracing may omit optional native bindings under @wreq-js
  // (e.g. @wreq-js/binding-linux-x64-gnu). Copy wreq-js and @wreq-js into the
  // standalone node_modules so dynamic import("wreq-js") resolves at runtime.
  for (const pkg of ["wreq-js", "@wreq-js"]) {
    const pkgSource = resolve(projectRoot, "node_modules", pkg);
    const pkgDestination = resolve(standaloneDir, "node_modules", pkg);
    if (existsSync(pkgSource)) {
      cpSync(pkgSource, pkgDestination, { recursive: true, force: true });
      console.log(`[standalone-assets] Copied ${pkg} to ${pkgDestination}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
