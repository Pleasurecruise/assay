import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/.venv/**", "**/coverage/**", "**/dist/**", "**/node_modules/**"],
    printWidth: 100,
    semi: true,
    singleQuote: false,
    sortPackageJson: true,
    tabWidth: 2,
    trailingComma: "all",
  },
  lint: {
    ignorePatterns: ["**/.venv/**", "**/coverage/**", "**/dist/**", "**/node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/e2e/**/*.test.ts"],
  },
});
