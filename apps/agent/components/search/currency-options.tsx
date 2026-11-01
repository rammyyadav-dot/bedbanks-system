'use client'

import { createContext, useContext } from 'react'

/** The currencies the server enables for this deployment (ADR 0029), from the Agent context. AED until the server says otherwise. */
export const CurrencyOptionsContext = createContext<readonly string[]>(['AED'])
export const useCurrencyOptions = () => useContext(CurrencyOptionsContext)
