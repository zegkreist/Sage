/** @type {import('jest').Config} */
export default {
  rootDir: ".",
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/*.test.js"],
  testTimeout: 60000,
  // Repositório é ESM ("type": "module") — rodar com NODE_OPTIONS=--experimental-vm-modules
  detectOpenHandles: false,
  forceExit: true,
  verbose: true,
};
