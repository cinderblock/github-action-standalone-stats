// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'dist',
      'lib',
      'node_modules',
      'public',
      'allure-results',
      'vitest.config.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // '@typescript-eslint/no-namespace': 'off',
      // '@typescript-eslint/restrict-template-expressions': 'off',
      // '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  // {
  //   rules: {
  //     'prettier/prettier': 'warn',
  //     'eslint-comments/no-use': 'off',
  //     'import/no-namespace': 'off',
  //     'no-unused-vars': 'off',
  //     '@typescript-eslint/no-unused-vars': 'error',
  //     '@typescript-eslint/explicit-member-accessibility': [
  //       'error',
  //       { accessibility: 'no-public' },
  //     ],
  //     '@typescript-eslint/no-require-imports': 'error',
  //     '@typescript-eslint/array-type': 'error',
  //     '@typescript-eslint/await-thenable': 'error',
  //     '@typescript-eslint/ban-ts-ignore': 'error',
  //     camelcase: 'off',
  //     '@typescript-eslint/camelcase': 'error',
  //     '@typescript-eslint/class-name-casing': 'error',
  //     '@typescript-eslint/explicit-function-return-type': [
  //       'error',
  //       { allowExpressions: true },
  //     ],
  //     '@typescript-eslint/func-call-spacing': ['error', 'never'],
  //     '@typescript-eslint/generic-type-naming': ['error', '^[A-Z][A-Za-z]*$'],
  //     '@typescript-eslint/no-array-constructor': 'error',
  //     '@typescript-eslint/no-empty-interface': 'error',
  //     '@typescript-eslint/no-explicit-any': 'error',
  //     '@typescript-eslint/no-extraneous-class': 'error',
  //     '@typescript-eslint/no-for-in-array': 'error',
  //     '@typescript-eslint/no-inferrable-types': 'error',
  //     '@typescript-eslint/no-misused-new': 'error',
  //     '@typescript-eslint/no-namespace': 'error',
  //     '@typescript-eslint/no-non-null-assertion': 'warn',
  //     '@typescript-eslint/no-unnecessary-qualifier': 'error',
  //     '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  //     '@typescript-eslint/no-useless-constructor': 'error',
  //     '@typescript-eslint/no-var-requires': 'error',
  //     '@typescript-eslint/prefer-for-of': 'warn',
  //     '@typescript-eslint/prefer-function-type': 'warn',
  //     '@typescript-eslint/prefer-includes': 'error',
  //     '@typescript-eslint/prefer-string-starts-ends-with': 'error',
  //     '@typescript-eslint/promise-function-async': 'error',
  //     '@typescript-eslint/require-array-sort-compare': 'error',
  //     '@typescript-eslint/restrict-plus-operands': 'error',
  //     semi: 'off',
  //     '@typescript-eslint/semi': ['error'],
  //     '@typescript-eslint/type-annotation-spacing': 'error',
  //     '@typescript-eslint/unbound-method': 'error',
  //   },
  // },
  prettierConfig,
];
