import { describe, it, expect } from 'vitest'
import { loadConfig, parseAccountMapping, ConfigError } from './config.js'

describe('parseAccountMapping', () => {
  it('parses a single mapping', () => {
    const result = parseAccountMapping('abc:xyz')
    expect(result).toEqual([
      { redbarkAccountId: 'abc', actualAccountId: 'xyz' },
    ])
  })

  it('parses multiple mappings', () => {
    const result = parseAccountMapping('abc:xyz,def:uvw')
    expect(result).toEqual([
      { redbarkAccountId: 'abc', actualAccountId: 'xyz' },
      { redbarkAccountId: 'def', actualAccountId: 'uvw' },
    ])
  })

  it('trims whitespace', () => {
    const result = parseAccountMapping(' abc : xyz , def : uvw ')
    expect(result).toEqual([
      { redbarkAccountId: 'abc', actualAccountId: 'xyz' },
      { redbarkAccountId: 'def', actualAccountId: 'uvw' },
    ])
  })

  it('throws on invalid format', () => {
    expect(() => parseAccountMapping('invalid')).toThrow()
  })

  it('throws on empty string', () => {
    expect(() => parseAccountMapping('')).toThrow()
  })
})

describe('loadConfig', () => {
  const validEnv = {
    REDBARK_API_KEY: 'rbk_live_test123',
    ACTUAL_SERVER_URL: 'http://localhost:5006',
    ACTUAL_PASSWORD: 'testpass',
    ACTUAL_BUDGET_ID: 'budget-123',
    ACCOUNT_MAPPING: 'acc1:acc2',
  }

  it('loads valid config', () => {
    const config = loadConfig(validEnv)
    expect(config.redbarkApiKey).toBe('rbk_live_test123')
    expect(config.actualServerUrl).toBe('http://localhost:5006')
    expect(config.syncDays).toBe(30)
    expect(config.dryRun).toBe(false)
    expect(config.logLevel).toBe('info')
  })

  it('applies defaults', () => {
    const config = loadConfig(validEnv)
    expect(config.redbarkApiUrl).toBe('https://app.redbark.co')
    expect(config.actualDataDir).toBe('./data')
    expect(config.syncDays).toBe(30)
  })

  it('accepts overrides', () => {
    const config = loadConfig({
      ...validEnv,
      SYNC_DAYS: '60',
      DRY_RUN: 'true',
      LOG_LEVEL: 'debug',
    })
    expect(config.syncDays).toBe(60)
    expect(config.dryRun).toBe(true)
    expect(config.logLevel).toBe('debug')
  })

  it('throws on missing required fields', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
  })

  it('throws on missing API key', () => {
    const { REDBARK_API_KEY, ...rest } = validEnv
    expect(() => loadConfig(rest)).toThrow(ConfigError)
  })
})
