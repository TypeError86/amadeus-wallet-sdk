import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{ ignores: ['dist/**', 'node_modules/**'] },
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'no-restricted-syntax': [
				'error',
				{ selector: "VariableDeclaration[kind='let']", message: 'Use const.' }
			]
		}
	}
)
