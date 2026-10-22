import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_POST_LOGIN_PATH, safePostLoginPath } from './auth/post-login-path';

test('keeps same-origin relative paths', () => {
  assert.equal(safePostLoginPath('/bookings'), '/bookings');
  assert.equal(safePostLoginPath('/hotels/abc?tab=rates'), '/hotels/abc?tab=rates');
});

test('rejects open-redirect and unsafe values', () => {
  for (const value of [
    undefined, null, '', 'bookings', 'https://evil.example', '//evil.example', '/\\evil.example',
    '/\\/evil.example', '/%0d%0aSet-Cookie:x', '/a\nb', 'javascript:alert(1)', '/login', '/login/x', '/api/v1/me', '/',
    '/' + 'a'.repeat(3000),
  ]) {
    assert.equal(safePostLoginPath(value), DEFAULT_POST_LOGIN_PATH, String(value));
  }
});
