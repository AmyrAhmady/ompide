import js from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "docs/**", "src-tauri/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: ["function", "export"] },
        {
          blankLine: "always",
          prev: "*",
          next: {
            selector:
              "VariableDeclaration[declarations.0.init.type=/^(ArrowFunctionExpression|FunctionExpression)$/]",
          },
        },
      ],
      "@stylistic/lines-between-class-members": ["error", "always"],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        performance: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  }
);
