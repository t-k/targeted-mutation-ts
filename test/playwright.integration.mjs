import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function exec(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

function analyzeAudit(root, ...scope) {
  return JSON.parse(exec(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'src/eligibility.tsx', 'src/save.tsx',
    '--runner', 'playwright', '--spec', 'spec.json', '--audit', ...scope]));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('isolated Playwright rewrites reveal an age boundary and a pending submission gap', () => {
  assert.ok(process.env.PORT, 'Run this fixture with an assigned PORT');
  const root = mkdtempSync(join(tmpdir(), 'tmt-playwright-test-'));
  try {
    cpSync('fixtures/playwright', root, { recursive: true });
    exec('git', ['-C', root, 'init', '-q']);
    exec('git', ['-C', root, 'add', '.']);
    exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    const file = join(root, 'src/eligibility.tsx');
    const changed = readFileSync(file, 'utf8').trimEnd() + ' // changed\n';
    writeFileSync(file, changed);

    const full = analyzeAudit(root);
    assert.equal(full.runner, 'playwright');
    const boundary = full.mutants.find(trial => trial.rule === 'comparison-boundary/v1');
    const dropped = full.mutants.find(trial => trial.rule === 'jsx-disabled-drop-left/v1');
    assert.deepEqual([[boundary.operator, boundary.status, boundary.audit.status], [dropped.operator, dropped.status, dropped.audit.status]], [
      ['<', 'survived', 'agreed'], ['||', 'survived', 'agreed'],
    ]);
    assert.deepEqual(full.diagnostics.map(gap => gap.verification), [
      { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
      { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
    ]);
    assert.ok(full.mutants.every(trial => trial.run.tests[0].browser === 'chromium'));
    assert.notEqual(boundary.run.attempt, dropped.run.attempt);

    const scoped = analyzeAudit(root, '--since', 'HEAD');
    assert.equal(scoped.mutants.length, 1);
    assert.equal(scoped.mutants[0].site, boundary.site);
    assert.equal(scoped.mutants[0].status, boundary.status);
    assert.equal(readFileSync(file, 'utf8'), changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Playwright targeted session synthesizes thresholds/margins, separates INPUT vs ASSERTION GAPs across SSR + browser, amortizes webServer startup, and isolates polluted state', () => {
  assert.ok(process.env.PORT, 'Run this fixture with an assigned PORT');
  const root = mkdtempSync(join(tmpdir(), 'tmt-playwright-session-'));
  const bootLog = join(tmpdir(), `tmt-pw-boots-${process.pid}-${Date.now()}.log`);
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pw-targeted-e2e', type: 'module' }));
    writeFileSync(join(root, 'playwright.config.ts'), `
import { defineConfig } from '@playwright/test';
const port = Number(process.env.PORT);
const baseURL = 'http://127.0.0.1:' + port;
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: { baseURL, browserName: 'chromium' },
  projects: [{ name: 'chromium' }],
  webServer: { command: 'node server.mjs', url: baseURL, reuseExistingServer: false },
});
`);

    // 1. Server SSR module: constant-RHS threshold (`yen >= 5000`) + variable-RHS margin (`stock >= reserved`).
    writeFileSync(join(root, 'src/shipping.ts'), [
      'export const qualifiesForFreeShipping = (yen: number) => yen >= 5000;',
      'export const hasMargin = (stock: number, reserved: number) => stock >= reserved;',
    ].join('\n') + '\n');

    // 2. Browser ES module:
    // - `saving || !valid`: `saving` is never true -> INPUT GAP on `(saving, !valid)`; `!valid` -> killed
    // - `price * qty`: evaluated in browser with `(200, 3)` where test only checks status badge -> ASSERTION GAP!
    writeFileSync(join(root, 'src/client.ts'), [
      'export const saveDisabled = (saving: boolean, valid: boolean) => saving || !valid;',
      'export const computeSubtotal = (price: number, qty: number) => price * qty;',
    ].join('\n') + '\n');

    // 3. Unreached module: zero hits in server and browser -> `unreached` without running any E2E trial.
    writeFileSync(join(root, 'src/unused.ts'), 'export const deadCalc = (a: number, b: number) => a + b;\n');

    // 4. Stateful server lock module: dropping `finally` cleanup leaves `serverLocked = true` across requests,
    // which post-trial control catches and isolates cleanly.
    writeFileSync(join(root, 'src/lock.ts'), [
      'let busy = false;',
      'export function runExclusive(unlock: () => void): string {',
      '  if (busy) return "locked";',
      '  busy = true;',
      '  try {',
      '    return "ok";',
      '  } finally {',
      '    unlock();',
      '  }',
      '}',
      'export function clearBusy() { busy = false; }',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'server.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';

if (process.env.TMT_TEST_BOOT_LOG) {
  appendFileSync(process.env.TMT_TEST_BOOT_LOG, process.pid + '\\n');
}

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;

const shippingCode = compile('./src/shipping.ts');
const clientCode = compile('./src/client.ts');
const lockCode = compile('./src/lock.ts');

const { qualifiesForFreeShipping, hasMargin } = await import('data:text/javascript,' + encodeURIComponent(shippingCode));
const { runExclusive, clearBusy } = await import('data:text/javascript,' + encodeURIComponent(lockCode));

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(clientCode);
    return;
  }
  if (url.pathname === '/shipping') {
    const yen = Number(url.searchParams.get('yen') ?? 0);
    const free = qualifiesForFreeShipping(yen);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><div id="badge">' + (free ? 'FREE' : 'PAID') + '</div>',
    );
    return;
  }
  if (url.pathname === '/stock') {
    const stock = Number(url.searchParams.get('stock') ?? 0);
    const reserved = Number(url.searchParams.get('reserved') ?? 0);
    const ok = hasMargin(stock, reserved);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><div id="stock">' + (ok ? 'AVAILABLE' : 'SHORT') + '</div>',
    );
    return;
  }
  if (url.pathname === '/lock') {
    const state = runExclusive(() => clearBusy());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><div id="lock">' + state + '</div>',
    );
    return;
  }
  const valid = url.searchParams.get('valid') === '1';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(\`<!doctype html>
    <button id="save">Save</button>
    <output id="ready"></output>
    <script type="module">
      import { saveDisabled, computeSubtotal } from '/client.js';
      const btn = document.getElementById('save');
      btn.disabled = saveDisabled(false, \${valid});
      const sub = computeSubtotal(200, 3);
      document.getElementById('ready').dataset.computed = String(sub > 0);
      document.getElementById('ready').textContent = 'ready';
    </script>\`);
});

server.listen(Number(process.env.PORT), '127.0.0.1');
`);

    writeFileSync(join(root, 'e2e/shop.spec.ts'), `
import { expect, test } from '@playwright/test';

test('checks shipping at 4800 and 5000 across multiple navigations', async ({ page }) => {
  await page.goto('/shipping?yen=4800');
  await expect(page.locator('#badge')).toHaveText('PAID');
  await page.goto('/shipping?yen=5000');
  await expect(page.locator('#badge')).toHaveText('FREE');
});

test('checks stock margin with varying reservations', async ({ page }) => {
  await page.goto('/stock?stock=15&reserved=10');
  await expect(page.locator('#stock')).toHaveText('AVAILABLE');
  await page.goto('/stock?stock=18&reserved=20');
  await expect(page.locator('#stock')).toHaveText('SHORT');
});

test('renders browser form state without pinning subtotal value', async ({ page }) => {
  await page.goto('/checkout?valid=0');
  await expect(page.locator('#save')).toBeDisabled();
  await page.goto('/checkout?valid=1');
  await expect(page.locator('#save')).toBeEnabled();
  await expect(page.locator('#ready')).toHaveText('ready');
});
`);

    // Part A: Pure warm session (shipping + client + unused — zero server state pollution, so server boots ONCE!).
    const report = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/shipping.ts', 'src/client.ts', 'src/unused.ts', '--runner', 'playwright',
    ], { ...process.env, TMT_TEST_BOOT_LOG: bootLog }));

    assert.equal(report.runner, 'playwright');
    assert.equal(report.operatorExecution, 'session');
    assert.equal(report.evaluation, 'evaluated');
    assert.equal(report.trials.isolated, 0);
    assert.ok(report.trials.inWorker >= 6);

    const boots = readFileSync(bootLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(Number);
    assert.equal(boots.length, 1, 'warm Playwright session should start webServer only once when control passes');
    for (const pid of boots) assert.equal(isPidAlive(pid), false, `server pid ${pid} should be terminated`);

    // Synthesized constant-RHS threshold `4999` + INPUT GAP witness `4999`.
    const thresholdMutant = report.mutants.find(m => m.rule === 'comparison-threshold/v1' && m.replacement === '4999');
    assert.ok(thresholdMutant, 'expected synthesized 4999 threshold mutant');
    assert.equal(thresholdMutant.status, 'survived');
    const thresholdGap = report.diagnostics.find(d => d.kind === 'INPUT GAP' && d.witness?.input === 4999);
    assert.ok(thresholdGap, 'expected INPUT GAP naming witness 4999');

    // Synthesized variable-RHS margin `((reserved) - 1)`.
    const marginMutant = report.mutants.find(m => m.rule === 'comparison-margin/v1');
    assert.ok(marginMutant, 'expected synthesized comparison-margin/v1 mutant');
    assert.equal(marginMutant.status, 'survived');

    // Browser-side INPUT GAP (`saving || !valid` -> `(saving, !valid)`) and killed right-drop.
    const browserInputGap = report.diagnostics.find(d => d.kind === 'INPUT GAP' && d.location.file === 'src/client.ts' && d.rule === 'ignored-operand/v1');
    assert.ok(browserInputGap, 'expected browser INPUT GAP on saving || !valid');
    assert.match(browserInputGap.missing, /saving/);
    const killedRight = report.mutants.find(m => m.location.file === 'src/client.ts' && m.rule === 'ignored-operand/v1' && m.status === 'killed');
    assert.ok(killedRight, 'expected right-operand drop in browser to be killed');

    // Browser-side ASSERTION GAP (`price * qty` diverged in `renders browser form state` with operands 200, 3).
    const browserAssertionGap = report.diagnostics.find(d => d.kind === 'ASSERTION GAP' && d.location.file === 'src/client.ts' && d.rule === 'arithmetic-swap/v1');
    assert.ok(browserAssertionGap, 'expected browser ASSERTION GAP on computeSubtotal(200, 3)');
    assert.ok(browserAssertionGap.tests.some(t => t.name.includes('renders browser form state')));
    assert.deepEqual(browserAssertionGap.example?.operands, ['200', '3']);

    // Unreached module marked `unreached` without running trials.
    const unusedMutants = report.mutants.filter(m => m.location.file === 'src/unused.ts');
    assert.ok(unusedMutants.length >= 2);
    assert.ok(unusedMutants.every(m => m.status === 'unreached'));

    // Part B: `--deterministic` skips eligible comparison trials via Lean `tmt-decide` (`evidence: "predicted"`).
    const detReport = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/shipping.ts', '--runner', 'playwright', '--deterministic',
      '--test', 'e2e/shop.spec.ts',
    ]));
    const predictedThreshold = detReport.mutants.find(m => m.rule === 'comparison-threshold/v1' && m.replacement === '4999');
    assert.ok(predictedThreshold);
    assert.equal(predictedThreshold.evidence, 'predicted');
    assert.equal(predictedThreshold.status, 'survived');

    // Part C: Stateful server lock pollution -> post-trial control catches dirty server and isolates cleanly!
    writeFileSync(join(root, 'e2e/lock.spec.ts'), `
import { expect, test } from '@playwright/test';

test('acquires and releases exclusive server lock', async ({ page }) => {
  await page.goto('/lock');
  await expect(page.locator('#lock')).toHaveText('ok');
});
`);
    rmSync(bootLog, { force: true });
    const lockReport = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/lock.ts', '--runner', 'playwright', '--test', 'e2e/lock.spec.ts',
    ], { ...process.env, TMT_TEST_BOOT_LOG: bootLog }));
    assert.equal(lockReport.evaluation, 'evaluated');
    const cleanupMutant = lockReport.mutants.find(m => m.rule === 'cleanup-dropped/v1');
    assert.ok(cleanupMutant, 'expected cleanup-dropped/v1 mutant');
    // On a single clean request `/lock` returns "ok", while the post-trial control run sees "locked" and forces an isolated run (`survived` with `fallback: "control-differs"`).
    assert.equal(cleanupMutant.status, 'survived');
    assert.equal(cleanupMutant.fallback, 'control-differs');
    const lockBoots = existsSync(bootLog)
      ? readFileSync(bootLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(Number)
      : [];
    for (const pid of lockBoots) assert.equal(isPidAlive(pid), false, `isolated server pid ${pid} should be terminated`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bootLog, { force: true });
  }
});
