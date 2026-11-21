import { join } from 'path'
import { tmpdir } from 'os'

/** Portable, writable default; CI may collect artifacts from TEST_ARTIFACT_DIR. */
export const testArtifactDir = () => process.env.TEST_ARTIFACT_DIR ?? join(tmpdir(), 'fbeds-test-artifacts')
