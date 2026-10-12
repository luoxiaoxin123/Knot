import { describe, it, expect } from 'vitest'
import { checkAccess, ipAllowed, validateAllowlist } from '../src/access.ts'
import type { AccessControl } from '../../shared/types.ts'

const ac = (p: Partial<AccessControl> = {}): AccessControl => ({ enabled: true, expiresAt: 0, maxUses: 0, uses: 0, rateLimitPerHour: 0, ipAllowlist: [], ...p })

describe('access control', () => {
  it('ip allowlist', () => {
    expect(ipAllowed('1.2.3.4', [])).toBe(true)
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8', '1.2.3.4'])).toBe(false)
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true)
    expect(ipAllowed('unknown', ['1.2.3.4'])).toBe(false)
    expect(validateAllowlist(['1.2.3.4', '10.0.0.0/8'])).toBeNull()
    expect(validateAllowlist(['10.0.0.0/33'])).toMatch(/无效/)
    expect(validateAllowlist(['abc'])).toMatch(/无效/)
  })
  it('limits', () => {
    const a = ac({ maxUses: 2 })
    expect(checkAccess('k1', a, '1.1.1.1')).toBeNull()
    expect(checkAccess('k1', a, '1.1.1.1')).toBeNull()
    expect(checkAccess('k1', a, '1.1.1.1')).toMatch(/次数/)
    expect(checkAccess('k2', ac({ enabled: false }), '1.1.1.1')).toMatch(/停用/)
    expect(checkAccess('k3', ac({ expiresAt: Date.now() - 1 }), '1.1.1.1')).toMatch(/过期/)
    const r = ac({ rateLimitPerHour: 1 })
    expect(checkAccess('k4', r, '1.1.1.1')).toBeNull()
    expect(checkAccess('k4', r, '1.1.1.1')).toMatch(/频繁/)
    expect(r.uses).toBe(1)
  })
})
