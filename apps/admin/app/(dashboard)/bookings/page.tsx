'use client'

import { Suspense } from 'react'
import { LoadingState } from '@/components/common/LoadingState'
import { BookingsWorkspace } from '@/components/bookings/BookingsWorkspace'

export default function BookingsPage() { return <Suspense fallback={<LoadingState rows={6} />}><BookingsWorkspace /></Suspense> }
