import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // Several integration-style tests intentionally exercise the process-wide
    // DATA_DIR/fetch configuration. Keep files serialized so one fixture
    // cannot tear down another file's temporary workspace mid-run.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
