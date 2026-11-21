import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'cloudrun-python-adk/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
