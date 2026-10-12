import { describe, it, expect } from 'vitest'
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/twofa.ts'

describe('totp', () => {
  it('RFC 6238 test vector (SHA1)', () => {
    // RFC 6238 附录 B：密钥 "12345678901234567890"，T=59s → 94287082（8 位）
    const secret = Buffer.from('12345678901234567890')
    expect(hotp(secret, 1, 8)).toBe('94287082')
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804')
  })
  it('base32 round trip and verify window', () => {
    const secret = Buffer.from('12345678901234567890')
    const b32 = base32Encode(secret)
    expect(b32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(b32)).toEqual(secret)
    const now = 1_700_000_000_000
    const code = hotp(secret, Math.floor(now / 30_000))
    expect(verifyTotp(b32, code, now)).toBe(Math.floor(now / 30_000))
    expect(verifyTotp(b32, code, now + 30_000)).toBeGreaterThan(0)
    expect(verifyTotp(b32, code, now + 120_000)).toBe(-1)
    expect(verifyTotp(b32, 'abc', now)).toBe(-1)
  })
})
