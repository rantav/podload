import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: rootDir
      }
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    settings: {
      react: {
        version: "detect"
      }
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",
      "react-refresh/only-export-components": ["warn", { "allowConstantExport": true }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  }
];
