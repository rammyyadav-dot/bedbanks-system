import { supplierSimulationEnabled } from './supply.service'

describe('supplierSimulationEnabled', () => {
  it('is off by default (no env flag set)', () => {
    expect(supplierSimulationEnabled({})).toBe(false)
  })

  it('is on in staging/development when flag is "true"', () => {
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'true', NODE_ENV: 'development' })).toBe(true)
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'true', NODE_ENV: 'test' })).toBe(true)
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'true', NODE_ENV: 'staging' })).toBe(true)
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'true' })).toBe(true)
  })

  it('is forced off in production even if the flag is set', () => {
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'true', NODE_ENV: 'production' })).toBe(false)
  })

  it('refuses any truthy value other than the exact string "true"', () => {
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: '1', NODE_ENV: 'development' })).toBe(false)
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'yes', NODE_ENV: 'development' })).toBe(false)
    expect(supplierSimulationEnabled({ SUPPLIER_SIMULATION_ENABLED: 'TRUE', NODE_ENV: 'development' })).toBe(false)
  })
})
