import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const jsxTranspiler = new Bun.Transpiler({
  loader: "jsx",
  autoImportJSX: true,
  tsconfig: JSON.stringify({
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
    },
  }),
});

const JSX_TAG_REGEX = /<[A-Za-z][A-Za-z0-9_.-]*(\s+[^>]*)?\/?>|<\/[A-Za-z][A-Za-z0-9_.-]*>|<>/;

function isUIPath(cleanPath) {
  return (
    cleanPath.includes("/src/app/(dashboard)/") ||
    cleanPath.includes("/src/shared/components/") ||
    cleanPath.includes("/src/components/")
  );
}

function transpileJsxInJsPlugin() {
  return {
    name: "transpile-jsx-in-js",
    enforce: "pre",
    transform(code, id) {
      const cleanPath = id.split("?")[0];
      if (cleanPath.endsWith(".js") && isUIPath(cleanPath) && JSX_TAG_REGEX.test(code)) {
        return {
          code: jsxTranspiler.transformSync(code),
          map: null,
        };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [transpileJsxInJsPlugin()],
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/dist/**",
      "**/real/**",
      "**/*.real.test.js",
      "**/embeddings.cloud.test.js",
    ],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
    server: {
      deps: {
        inline: ["react-test-renderer"],
      },
    },
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
      { find: /^react$/, replacement: resolve(__dirname, "node_modules/react") },
      { find: /^react\/(.*)/, replacement: resolve(__dirname, "node_modules/react") + "/$1" },
      { find: /^react-dom$/, replacement: resolve(__dirname, "../node_modules/react-dom") },
      { find: /^react-dom\/(.*)/, replacement: resolve(__dirname, "../node_modules/react-dom") + "/$1" },
    ],
    dedupe: ["react", "react-dom"],
  },
});
