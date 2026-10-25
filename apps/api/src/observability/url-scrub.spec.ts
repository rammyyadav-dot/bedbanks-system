import { scrubbedUrl, scrubSpanUrlAttributes } from './url-scrub'

describe('scrubbedUrl', () => {
  it('drops the query string and fragment from an absolute URL', () => {
    expect(scrubbedUrl('https://supplier.example.com/v1/search?apiKey=secret&q=dubai#x')).toBe('https://supplier.example.com/v1/search')
  })
  it('drops the query string from a path', () => {
    expect(scrubbedUrl('/api/v1/auth/reset?token=abc')).toBe('/api/v1/auth/reset')
  })
  it('never echoes an unparseable input', () => {
    expect(scrubbedUrl('http://[bad')).toBe('[unparseable-url]')
  })
})

describe('scrubSpanUrlAttributes', () => {
  it('overwrites every url attribute and ignores a missing url', () => {
    const set = jest.fn()
    scrubSpanUrlAttributes({ setAttribute: set }, '/x?token=1')
    expect(set).toHaveBeenCalledWith('http.target', '/x')
    expect(set).toHaveBeenCalledWith('url.full', '/x')
    expect(set).toHaveBeenCalledWith('url.query', '')
    set.mockClear()
    scrubSpanUrlAttributes({ setAttribute: set }, undefined)
    expect(set).not.toHaveBeenCalled()
  })
})
