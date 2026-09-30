import { normalizeOpsDatabaseUrl, withCredentials } from './ops-database-url'

describe('normalizeOpsDatabaseUrl', () => {
  it('drops channel_binding, keeps sslmode and flags pooled hosts', () => {
    const target = normalizeOpsDatabaseUrl('postgresql://owner:pw@ep-x-pooler.c-10.aws.neon.tech/neondb?sslmode=require&channel_binding=require')
    expect(target).toMatchObject({ host: 'ep-x-pooler.c-10.aws.neon.tech', database: 'neondb', pooled: true, local: false })
    expect(target.url).not.toContain('channel_binding')
    expect(target.url).toContain('sslmode=require')
  })

  it('adds sslmode for remote hosts but not local ones', () => {
    expect(normalizeOpsDatabaseUrl('postgresql://o:p@db.example.com/app').url).toContain('sslmode=require')
    expect(normalizeOpsDatabaseUrl('postgresql://o:p@localhost:5432/fbeds_ci').url).not.toContain('sslmode')
  })

  it.each([undefined, '', 'not a url', 'mysql://o:p@h/d', 'postgresql://o:p@h/'])('rejects %p without echoing the input', input => {
    try { normalizeOpsDatabaseUrl(input as string | undefined); throw new Error('should have thrown') } catch (error) {
      expect((error as Error).message).not.toContain('o:p')
      expect((error as Error).message).not.toBe('should have thrown')
    }
  })

  it('swaps credentials without touching host, database or options', () => {
    const swapped = withCredentials('postgresql://owner:pw@h.example.com/neondb?sslmode=require', 'fbeds_hold_expiry_login', 'abc-DEF_123')
    expect(swapped).toBe('postgresql://fbeds_hold_expiry_login:abc-DEF_123@h.example.com/neondb?sslmode=require')
  })
})
