const mockSet = jest.fn();
const mockGet = jest.fn();
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/headers', () => ({ cookies: jest.fn(async () => ({ set: mockSet, get: mockGet })) }));
jest.mock('next/navigation', () => ({ redirect: jest.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }) }));

import { loginAction, logoutAction } from '../../admin/lib/auth/actions';
import { getSession } from '../../admin/lib/auth/session';
import { parseSessionCookie } from '../../admin/lib/auth/session-cookie';

const rawToken = 'a'.repeat(64);
const sessionHeader = `fbeds_session=${rawToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`;
const mockFetch = jest.fn();
const identity = { user: { id: 'u1', email: 'admin@example.test', name: 'Admin', status: 'ACTIVE' }, memberships: [] };
const response = (data: unknown, status = 200, cookie?: string) => new Response(JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: { code: 'UNAUTHORIZED', message: 'Denied' } }), { status, headers: cookie ? { 'Set-Cookie': cookie } : {} });
const form = () => { const f = new FormData(); f.set('email', 'admin@example.test'); f.set('password', 'password'); return f; };

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockReturnValue(undefined);
  global.fetch = mockFetch;
});

describe('Admin server authentication integration', () => {
  it('preserves Next.js dynamic-rendering control flow', async () => {
    const control = new Error('DYNAMIC_SERVER_USAGE');
    jest.requireMock('next/headers').cookies.mockRejectedValueOnce(control);
    await expect(getSession()).rejects.toBe(control);
  });
  it('transfers the API cookie into the server cookie store before redirecting', async () => {
    mockFetch.mockResolvedValue(response(identity, 200, sessionHeader));
    await expect(loginAction({ error: null }, form())).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockSet).toHaveBeenCalledWith('fbeds_session', rawToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 28800 });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3002/api/v1/auth/login', expect.objectContaining({ method: 'POST', cache: 'no-store', headers: expect.objectContaining({ Origin: 'http://localhost:3001', 'Content-Type': 'application/json' }) }));
  });
  it('never sets a cookie for rejected credentials and only returns a safe error', async () => {
    mockFetch.mockResolvedValue(response(null, 401));
    expect(await loginAction({ error: null }, form())).toEqual({ error: 'Invalid email or password.' });
    expect(mockSet).not.toHaveBeenCalled();
  });
  it('does not redirect or return a token when Set-Cookie is missing', async () => {
    mockFetch.mockResolvedValue(response(identity));
    const result = await loginAction({ error: null }, form());
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(rawToken);
    expect(mockSet).not.toHaveBeenCalled();
  });
  it('forwards cookies explicitly and bypasses session caching', async () => {
    mockGet.mockReturnValue({ value: rawToken });
    mockFetch.mockResolvedValue(response(identity));
    expect(await getSession()).toEqual(identity);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), expect.objectContaining({ cache: 'no-store', headers: expect.objectContaining({ Cookie: `fbeds_session=${rawToken}` }) }));
  });
  it('revokes before deleting the host-only Admin cookie', async () => {
    mockGet.mockReturnValue({ value: rawToken });
    mockFetch.mockResolvedValue(response({ loggedOut: true }));
    await expect(logoutAction()).rejects.toThrow('REDIRECT:/login');
    expect(mockSet).toHaveBeenCalledWith('fbeds_session', '', expect.objectContaining({ httpOnly: true, secure: true, path: '/', maxAge: 0 }));
    expect(mockFetch.mock.invocationCallOrder[0]).toBeLessThan(mockSet.mock.invocationCallOrder[0]);
  });
  it('keeps the cookie and reports failure if revocation fails', async () => {
    mockGet.mockReturnValue({ value: rawToken });
    mockFetch.mockRejectedValue(new Error('network unavailable'));
    await expect(logoutAction()).rejects.toThrow('Sign out failed');
    expect(mockSet).not.toHaveBeenCalled();
  });
  it('allows repeated logout with no cookie', async () => {
    await expect(logoutAction()).rejects.toThrow('REDIRECT:/login');
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('distinguishes unavailable API from invalid identity', async () => {
    mockGet.mockReturnValue({ value: rawToken });
    mockFetch.mockResolvedValueOnce(response(null, 401));
    await expect(getSession()).resolves.toBeNull();
    mockFetch.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(getSession()).rejects.toThrow('Authentication service unavailable');
  });
  it.each([
    sessionHeader.replace('HttpOnly;', ''), sessionHeader.replace('Secure;', ''),
    sessionHeader.replace('Max-Age=28800', 'Max-Age=0'), sessionHeader.replace(rawToken, 'bad'),
  ])('rejects unsafe cookie attributes', (header) => {
    expect(() => parseSessionCookie([header], 'fbeds_session')).toThrow();
  });
  it('rejects ambiguous cookies', () => expect(() => parseSessionCookie([sessionHeader, sessionHeader], 'fbeds_session')).toThrow());
});
