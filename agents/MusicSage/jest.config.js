/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/tests/**/*.test.js"],
  testTimeout: 30000,
  verbose: true,
  setupFiles: ["../../jest.setup.js"],
};
