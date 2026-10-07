// Test harness only. The production default is AED only (ADR 0029). The existing suites were written when 14 currencies were
// enabled, so they run with that list unless a suite sets SETTLEMENT_CURRENCIES itself first. agent-aed-policy.e2e-spec.ts and
// currency.spec.ts exercise the AED default.
process.env.SETTLEMENT_CURRENCIES ??= 'AED,USD,EUR,INR,GBP,SAR,QAR,OMR,KWD,BHD,SGD,AUD,CAD,JPY'
// Test harness only (ADR 0040): many suites deliberately connect as the disposable owner. The startup identity guard honours `off` solely under NODE_ENV=test;
// suites that prove the guard set DB_RUNTIME_ROLE_GUARD=enforce themselves.
process.env.DB_RUNTIME_ROLE_GUARD ??= 'off'
export {}
