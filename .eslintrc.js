module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    { files: ['jest.setup.js'], env: { jest: true } },
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
  },
};
