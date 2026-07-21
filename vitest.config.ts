import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The black-box test spawns the built server and talks over HTTP; give it room.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
