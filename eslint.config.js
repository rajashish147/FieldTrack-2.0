// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.js"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Enforce use of orgTable() from db/query.ts in repository files.
    // orgTable() applies the tenant filter at construction time, making
    // it structurally impossible to omit — the filter is built in.
    files: ["src/modules/**/*repository*.ts", "src/modules/**/*repository*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../config/supabase.js",
              importNames: ["supabaseAnonClient"],
              message:
                "Repository files must use supabaseServiceClient, not supabaseAnonClient. RLS bypass requires the service role — tenant isolation is enforced via orgTable().",
            },
            {
              name: "../../utils/tenant.js",
              importNames: ["enforceTenant"],
              message:
                "Repository files must use orgTable() from '../../db/query.js'. orgTable() applies the tenant filter at construction time.",
            },
            {
              name: "../../utils/tenantQuery.js",
              importNames: ["tenantQuery"],
              message:
                "Repository files must use orgTable() from '../../db/query.js', not tenantQuery(). orgTable() applies the tenant filter at construction time, making it impossible to omit.",
            },
          ],
        },
      ],
    },
  },
);
