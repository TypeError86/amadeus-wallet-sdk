import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'coverage/**',
			'*.config.js',
			'*.config.mjs',
			'*.config.ts'
		]
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-non-null-assertion': 'warn',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	}
)
