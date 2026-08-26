export function createEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...overrides,
  };
}
