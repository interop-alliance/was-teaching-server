import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Shapes that reimplement a helper which exists once in src/. A hit means
 * call the helper instead. Keyed by helper so the file that defines a helper
 * can turn off its own entry (see `restrictedSyntaxExcept` below).
 */
const restrictedSyntax = {
  absoluteUrl: [
    {
      selector:
        "MemberExpression[property.name=/^(toString|href)$/] > NewExpression.object[callee.name='URL'][arguments.length=2]",
      message: 'Use absoluteUrl from lib/paths.ts.'
    }
  ],
  didOfMethodId: [
    {
      selector:
        "MemberExpression[computed=true][property.value=0] > CallExpression.object[callee.property.name='split'][arguments.0.value='#']",
      message: 'Use didOfMethodId from lib/validateDid.ts.'
    }
  ],
  isPlainObject: [
    {
      selector:
        ":not(LogicalExpression) > LogicalExpression:has(BinaryExpression[operator=/^[!=]==$/][left.operator='typeof'][right.value='object']):has(CallExpression[callee.object.name='Array'][callee.property.name='isArray'])",
      message: 'Use isPlainObject from lib/isPlainObject.ts.'
    }
  ],
  pickStamp: [
    {
      selector:
        "ObjectPattern[properties.length=3]:has(Property[key.name='updatedAt']):has(Property[key.name='updatedAtCounter']):has(Property[key.name='originId'])",
      message: 'Use pickStamp from lib/hlc.ts.'
    }
  ],
  isEnoent: [
    {
      selector:
        "BinaryExpression[operator=/^[!=]==$/][right.value='ENOENT']:matches([left.property.name='code'], [left.expression.property.name='code'])",
      message:
        'Use isEnoent / readFileIfPresent / unlinkIfPresent from lib/atomicFile.ts.'
    }
  ],
  rootPrefix: [
    {
      selector: 'Literal[value=/^urn:zcap:root:/]',
      message: 'Use ROOT_PREFIX / rootCapabilityId / rootTargetOf from zcap.ts.'
    },
    {
      selector: 'TemplateElement[value.raw=/^urn:zcap:root:/]',
      message: 'Use ROOT_PREFIX / rootCapabilityId / rootTargetOf from zcap.ts.'
    }
  ],
  asList: [
    {
      selector:
        "ConditionalExpression[test.callee.object.name='Array'][test.callee.property.name='isArray'][alternate.type='ArrayExpression'][alternate.elements.length=1]",
      message: 'Use asList from lib/chainCapability.ts.'
    }
  ],
  nestedTernary: [
    {
      selector: 'ConditionalExpression > ConditionalExpression',
      message:
        'No nested ternaries (CONTRIBUTING.md); use an if-chain or a lookup table.'
    }
  ]
}

/**
 * The `no-restricted-syntax` entry with the named helpers' selectors left
 * out, for the file that defines those helpers.
 * @param helpers {string[]}
 * @returns {Array}
 */
function restrictedSyntaxExcept(...helpers) {
  const selectors = Object.entries(restrictedSyntax)
    .filter(([helper]) => !helpers.includes(helper))
    .flatMap(([, entries]) => entries)
  return ['error', ...selectors]
}

export default defineConfig([
  globalIgnores(['dist', '**/*.min.js']),
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      prettierConfig // must be last in extends
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
      parserOptions: {
        project: ['./tsconfig.dev.json']
      }
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  // Helpers that exist once in src/: a hit means call the helper.
  {
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept() }
  },
  // Each helper's own definition is exempt from its selector.
  {
    files: ['src/lib/paths.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('absoluteUrl') }
  },
  {
    files: ['src/lib/validateDid.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('didOfMethodId') }
  },
  {
    files: ['src/lib/isPlainObject.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('isPlainObject') }
  },
  {
    files: ['src/lib/hlc.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('pickStamp') }
  },
  {
    files: ['src/lib/atomicFile.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('isEnoent') }
  },
  {
    files: ['src/zcap.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('rootPrefix') }
  },
  {
    files: ['src/lib/chainCapability.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntaxExcept('asList') }
  }
])
