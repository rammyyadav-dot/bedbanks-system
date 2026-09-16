module.exports = {
  rootDir: '../../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/api/test/admin-auth.integration.ts'],
  transform: { '^.+\\.ts$': [require.resolve('ts-jest'), { tsconfig: '<rootDir>/apps/api/tsconfig.json' }] },
  moduleNameMapper: { '^next/(.*)$': '<rootDir>/apps/admin/node_modules/next/$1' },
};
