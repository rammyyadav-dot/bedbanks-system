import assert from 'node:assert/strict'
import test from 'node:test'
import { clientAddress, trustedProxy } from '../lib/leads/client-address'

const headersOf = (h: Record<string, string>) => (name: string) => h[name] ?? null

test('on an AWS load balancer only the last X-Forwarded-For entry is trusted, and spoofable headers are ignored', () => {
  const get = headersOf({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9', 'x-vercel-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' })
  assert.equal(clientAddress(get, 'aws-alb'), '203.0.113.9')
  assert.equal(clientAddress(headersOf({}), 'aws-alb'), 'unknown')
})

test('the default (Vercel) behaviour is unchanged', () => {
  assert.equal(clientAddress(headersOf({ 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }), 'vercel'), '9.9.9.9')
  assert.equal(clientAddress(headersOf({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), 'vercel'), '1.1.1.1')
})

test('only the exact value aws-alb selects the AWS mode', () => {
  assert.equal(trustedProxy('aws-alb'), 'aws-alb')
  for (const v of [undefined, '', 'AWS-ALB', 'true']) assert.equal(trustedProxy(v), 'vercel')
})

test('behind CloudFront and the ALB the client is the second-to-last X-Forwarded-For entry; spoofed entries to its left are ignored', () => {
  const get = headersOf({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 130.176.0.5', 'x-vercel-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' })
  assert.equal(clientAddress(get, 'aws-cloudfront-alb'), '203.0.113.9')
})

test('CloudFront mode never trusts a lone entry (the request did not pass through CloudFront) and never reads spoofable headers', () => {
  assert.equal(clientAddress(headersOf({ 'x-forwarded-for': '203.0.113.9' }), 'aws-cloudfront-alb'), 'unknown')
  assert.equal(clientAddress(headersOf({ 'x-real-ip': '8.8.8.8', 'x-vercel-forwarded-for': '9.9.9.9' }), 'aws-cloudfront-alb'), 'unknown')
})

test('aws-cloudfront-alb is selected only by its exact value', () => {
  assert.equal(trustedProxy('aws-cloudfront-alb'), 'aws-cloudfront-alb')
  for (const v of ['AWS-CLOUDFRONT-ALB', 'cloudfront', 'aws-cloudfront']) assert.equal(trustedProxy(v), 'vercel')
})
