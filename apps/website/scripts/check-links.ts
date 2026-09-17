import { resolve } from 'node:path'
import { findBrokenInternalLinks } from './link-integrity'
const projectRoot = resolve(import.meta.dirname, '..')
const errors = findBrokenInternalLinks(resolve(projectRoot, 'app'), projectRoot)
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 } else { console.log('Internal link integrity: all declared and literal internal routes resolve.') }
