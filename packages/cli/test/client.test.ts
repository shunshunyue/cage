import { expect, it } from 'vitest';
import { CageClient, CageCommandError, commandData, currentUser, loadMe } from '../../client/src/index.js';

const user = { id: 'one', username: 'one', name: 'One', deptId: 'dept' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('response body failures are typed network results; POST is not retried ambiguously', async () => {
  let writes = 0;
  const client = new CageClient({ fetch: (async url => {
    if (String(url).endsWith('/auth/csrf')) return response({ token: 'token' });
    writes++;
    return { ok: true, text: async () => { throw new Error('read interrupted'); } } as Response;
  }) as typeof fetch });
  expect(await client.get('/broken')).toMatchObject({ ok: false, code: 'NETWORK' });
  writes = 0;
  expect(await client.post('/write')).toMatchObject({ ok: false, code: 'NETWORK' });
  expect(writes).toBe(1);
});

it('session identity is isolated and logout/401 clear identity and capabilities together', async () => {
  let unauthorized = false;
  const first = new CageClient({ fetch: (async url => String(url).endsWith('/auth/csrf') ? response({ token: 't' }) : unauthorized ? response({ code: 'UNAUTHENTICATED' }, 401) : String(url).endsWith('/api/me') ? response({ user, capabilities: ['A.read'] }) : response({ ok: true })) as typeof fetch });
  const second = new CageClient();
  await loadMe(first);
  expect(currentUser(first)).toEqual(user);
  expect(first.can('A.read')).toBe(true);
  expect(currentUser(second)).toBeNull();
  await first.logout();
  expect(first.getSession()).toMatchObject({ user: null, capabilities: [] });
  await loadMe(first);
  unauthorized = true;
  await first.get('/private');
  expect(first.getSession()).toMatchObject({ user: null, capabilities: [] });
});

it('a late identity response cannot restore a cleared session', async () => {
  let finish!: (response: Response) => void;
  const client = new CageClient({ fetch: (() => new Promise(resolve => { finish = resolve; })) as typeof fetch });
  const pending = loadMe(client);
  client.clearSession('account-switch');
  finish(response({ user, capabilities: ['A.read'] }));
  await pending;
  expect(client.getSession()).toMatchObject({ user: null, capabilities: [] });
});

it('an unreadable 401 still clears the session and preserves its HTTP error', async () => {
  const client = new CageClient({ fetch: (async () => ({ status: 401, ok: false, text: async () => { throw new Error('lost body'); } })) as typeof fetch });
  client.setSession(user, ['A.read']);
  expect(await client.get('/private')).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  expect(client.getSession()).toMatchObject({ user: null, capabilities: [] });
});

it('CSRF rejection retries exactly once using the original idempotency key', async () => {
  const writes: RequestInit[] = [];
  let tokens = 0;
  const client = new CageClient({ fetch: (async (url, options) => {
    if (String(url).endsWith('/auth/csrf')) return response({ token: `token-${++tokens}` });
    writes.push(options!);
    return writes.length === 1 ? response({ code: 'FORBIDDEN', detail: 'CSRF' }, 403) : response({ id: 'created' });
  }) as typeof fetch });
  expect(await client.post('/write', {}, { idempotencyKey: 'business-action' })).toMatchObject({ ok: true });
  expect(writes).toHaveLength(2);
  expect(tokens).toBe(2);
  expect(writes.map(write => (write.headers as Record<string, string>)['idempotency-key'])).toEqual(['business-action', 'business-action']);
  expect(writes.map(write => (write.headers as Record<string, string>)['x-csrf-token'])).toEqual(['token-1', 'token-2']);
});

it('cancel and timeout are distinct typed results', async () => {
  const client = new CageClient({ fetch: (async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))) as typeof fetch });
  const abort = new AbortController();
  abort.abort();
  expect(await client.get('/cancel', undefined, { signal: abort.signal })).toMatchObject({ code: 'CANCELLED' });
  expect(await client.get('/timeout', undefined, { timeoutMs: 5 })).toMatchObject({ code: 'TIMEOUT' });
});

it('mutation failures reject with the original typed business result', async () => {
  const failure = { ok: false as const, code: 'DOMAIN_ERROR', domainCode: 'BUDGET_EMPTY', status: 422 };
  await expect(commandData(Promise.resolve(failure))).rejects.toBeInstanceOf(CageCommandError);
  await expect(commandData(Promise.resolve(failure))).rejects.toMatchObject({ result: failure });
  expect(await commandData(Promise.resolve({ ok: true as const, data: 42 }))).toBe(42);
});
