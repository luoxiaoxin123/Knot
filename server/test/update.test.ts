import { describe, expect, it } from 'vitest'
import { compareVersion, parseVersion } from '../src/services/update.ts'

describe('版本比较', () => {
  it('解析版本号', () => {
    expect(parseVersion('v0.1.5')).toEqual({ nums: [0, 1, 5], pre: '' })
    expect(parseVersion('dev')).toBeNull()
    expect(parseVersion('ci-abc123')).toBeNull()
  })
  it('比较大小', () => {
    expect(compareVersion('v0.1.6', 'v0.1.5')).toBeGreaterThan(0)
    expect(compareVersion('v0.2.0', 'v0.1.10')).toBeGreaterThan(0)
    expect(compareVersion('v0.1.10', 'v0.1.9')).toBeGreaterThan(0)
    expect(compareVersion('v0.1.5', 'v0.1.5')).toBe(0)
    expect(compareVersion('v0.1.5', 'v0.1.5-beta.1')).toBeGreaterThan(0)
    expect(compareVersion('v0.1.5-beta.2', 'v0.1.5-beta.10')).toBeLessThan(0)
    expect(compareVersion('v0.1.4', 'v0.1.5')).toBeLessThan(0)
  })
})
