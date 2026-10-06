/** Child tools receive a minimal execution environment, never provider credentials. */
export function executionEnvironment(nodeMode = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.NO_COLOR = '1';
  env.NODE_DISABLE_COLORS = '1';
  if (nodeMode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
