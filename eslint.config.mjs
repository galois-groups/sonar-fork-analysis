import comments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import js from '@eslint/js'
import vitest from '@vitest/eslint-plugin'
import { defineConfig } from 'eslint/config'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import importX from 'eslint-plugin-import-x'
import n from 'eslint-plugin-n'
import prettier from 'eslint-plugin-prettier/recommended'
import regexp from 'eslint-plugin-regexp'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const REQUEST =
  "Use request() from http.ts: it goes through the runner's proxy, gives up on a silent server and keeps tokens off redirects."

const BANNED = {
  warning: {
    object: 'core',
    message: 'Use warn() from warnings.ts: the job summary counts it.'
  },
  setSecret: {
    object: 'core',
    message: 'Use secret() from secrets.ts: the job summary takes it out.'
  },
  downloadTool: { object: 'tc', message: REQUEST }
}

export default defineConfig(
  { ignores: ['coverage', 'dist', 'fixtures'] },
  js.configs.recommended,
  // The rules that use the compiler's types, the closest to Java's Error Prone.
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['__fixtures__/*.ts', 'vite.config.ts']
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    rules: {
      // Given options replace the strict ones, and the rule's lenient defaults fill the rest in.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false
        }
      ]
    }
  },
  { files: ['**/*.{js,mjs}'], extends: [tseslint.configs.disableTypeChecked] },
  // Among others, regular expressions whose running time grows faster than their input.
  regexp.configs['flat/recommended'],
  {
    files: ['src/**', 'scripts/**'],
    // Quadratic in the length of the input; recommended leaves it out, as it can't be fixed in every
    // regular expression, but what reads the artifact must be.
    rules: { 'regexp/no-super-linear-move': 'error' }
  },
  comments.recommended,
  {
    rules: {
      // A suppressed check says why, like NOSONAR.
      '@eslint-community/eslint-comments/require-description': 'error'
    }
  },
  {
    plugins: { 'import-x': importX, n },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()]
    },
    rules: {
      'import-x/no-cycle': 'error',
      // What src imports is bundled into dist and runs in the privileged job.
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            '__tests__/**',
            '__fixtures__/**',
            'scripts/**',
            '*.config.{js,mjs,ts}'
          ]
        }
      ],
      // Checked against package.json's engines, the Node version GitHub runs the action on.
      'n/no-deprecated-api': 'error',
      'n/no-unsupported-features/es-builtins': 'error',
      'n/no-unsupported-features/es-syntax': 'error',
      'n/no-unsupported-features/node-builtins': 'error'
    }
  },
  // A later block's options for a rule replace the earlier ones, so each file the bans allow gets the
  // others again.
  ...Object.entries({
    'src/**': ['warning', 'setSecret', 'downloadTool'],
    'src/warnings.ts': ['setSecret', 'downloadTool'],
    'src/secrets.ts': ['warning', 'downloadTool']
  }).map(([files, properties]) => ({
    files: [files],
    rules: {
      'no-restricted-properties': [
        'error',
        ...properties.map((property) => ({ property, ...BANNED[property] }))
      ]
    }
  })),
  {
    files: ['src/**'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: REQUEST }]
    }
  },
  {
    files: ['src/**'],
    ignores: ['src/http.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { name: '@actions/http-client', message: REQUEST }
      ]
    }
  },
  {
    files: ['__tests__/**', '__fixtures__/**'],
    extends: [vitest.configs.recommended],
    // Tests read JSON and mock arguments loosely, and write mocks of async functions as async: a value
    // of the wrong shape fails the assertion anyway, with the stack to show where.
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      'vitest/no-standalone-expect': [
        'error',
        {
          additionalTestBlockFunctions: [
            'invalidUtf8It',
            'linuxIt',
            'nonRootIt',
            'posixIt',
            'posixIt.each'
          ]
        }
      ]
    }
  },
  prettier
)
