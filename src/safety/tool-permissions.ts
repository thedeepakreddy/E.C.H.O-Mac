import { AsyncLocalStorage } from 'node:async_hooks';

// A nested dispatcher inherits its caller's grants even outside a recorded run.
// Multiple boundaries intersect; none can widen the caller's authority.
const permissions = new AsyncLocalStorage<readonly ReadonlySet<string>[]>();

export function withToolPermissions<T>(grants: ReadonlySet<string> | undefined, action: () => T): T {
  const inherited = permissions.getStore() ?? [];
  return permissions.run(grants === undefined ? inherited : [...inherited, new Set(grants)], action);
}

export function toolPermitted(name: string, ...grants: (ReadonlySet<string> | undefined)[]): boolean {
  return [...(permissions.getStore() ?? []), ...grants].every(grant => toolGranted(grant,name));
}
/** Explicit external namespace grant; it never grants SDK native tools or Echo's own MCP aliases. */
export function toolGranted(grants: ReadonlySet<string>|undefined,name:string):boolean {
  return grants===undefined || grants.has(name) || (grants.has('mcp__*') && name.startsWith('mcp__') && !name.startsWith('mcp__jarvis__'));
}

export function hasExternalToolGrants(grants: ReadonlySet<string> | undefined): boolean {
  return grants === undefined || [...grants].some(name => name.startsWith('mcp__'));
}
