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

    // Also verify `--spec spec.json` WITHOUT `--audit` (warm session path) confirms both witnesses cleanly.
    const sessionSpec = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/eligibility.tsx', 'src/save.tsx', '--runner', 'playwright', '--spec', 'spec.json',
    ]));
    assert.equal(sessionSpec.operatorExecution, 'session');
    assert.deepEqual(sessionSpec.diagnostics.map(gap => gap.verification), [
      { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
      { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
    ]);

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

test('renders browser form state without pinning subtotal value', async ({ page, context }) => {
  // Also open and explicitly close an extra page mid-test to verify page.close() flushes browser observations before closing.
  const popup = await context.newPage();
  await popup.goto('/checkout?valid=0');
  await expect(popup.locator('#save')).toBeDisabled();
  await popup.close();
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

    // Part D: `--isolated-trials` activates browser-only switches cleanly and kills `!valid` drop.
    const isoClientReport = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/client.ts', '--runner', 'playwright', '--isolated-trials', '--test', 'e2e/shop.spec.ts',
    ]));
    assert.equal(isoClientReport.evaluation, 'evaluated');
    assert.equal(isoClientReport.trials.inWorker, 0);
    assert.ok(isoClientReport.trials.isolated >= 3);
    assert.ok(
      isoClientReport.mutants.some(m => m.rule === 'ignored-operand/v1' && m.status === 'killed'),
      JSON.stringify(isoClientReport.mutants),
    );

    // Part D2: `--mutators full` shares trial execution across overlapping built-in/targeted mutations (`price * qty` -> `price / qty`)
    // and attaches relational-complement / ConditionalExpression diagnostics on Playwright with 100% `--audit` verdict parity.
    const fullSessionReport = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/shipping.ts', 'src/client.ts', '--runner', 'playwright', '--mutators', 'full', '--test', 'e2e/shop.spec.ts',
    ]));
    assert.equal(fullSessionReport.evaluation, 'evaluated');
    assert.equal(fullSessionReport.operatorExecution, 'session');
    const arithFullBuiltin = fullSessionReport.mutants.find(m => m.location.file === 'src/client.ts' && m.mutatorName === 'ArithmeticOperator');
    const arithFullTargeted = fullSessionReport.mutants.find(m => m.location.file === 'src/client.ts' && m.mutatorName === 'arithmetic-swap/v1' && m.replacement === '(price / qty)');
    assert.equal(arithFullBuiltin?.status, 'survived');
    assert.equal(arithFullTargeted?.status, 'survived');
    assert.ok(arithFullBuiltin?.sharedWith, 'Playwright --mutators full should share execution on overlapping arithmetic swap');

    const fullAuditClient = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/client.ts', '--runner', 'playwright', '--mutators', 'full', '--audit', '--test', 'e2e/shop.spec.ts',
    ]));
    const auditMap = new Map(fullAuditClient.mutants.map(m => [`${m.location.start}:${m.location.end}:${m.rule ?? m.mutatorName}:${m.replacement}`, m.status]));
    for (const m of fullSessionReport.mutants.filter(x => x.location.file === 'src/client.ts')) {
      const k = `${m.location.start}:${m.location.end}:${m.rule ?? m.mutatorName}:${m.replacement}`;
      if (auditMap.has(k)) {
        assert.equal(m.status, auditMap.get(k), `Playwright full session vs --audit parity mismatch on ${k}`);
      }
    }

    // Part E: Failed baseline tears down `webServer` + `browserServer` cleanly with zero orphan processes.
    writeFileSync(join(root, 'e2e/failing.spec.ts'), `
import { expect, test } from '@playwright/test';
test('fails during baseline', async ({ page }) => {
  await page.goto('/shipping?yen=4800');
  await expect(page.locator('#badge')).toHaveText('WRONG');
});
`);
    rmSync(bootLog, { force: true });
    const failedRun = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/shipping.ts', '--runner', 'playwright', '--test', 'e2e/failing.spec.ts',
    ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMT_TEST_BOOT_LOG: bootLog } });
    assert.equal(failedRun.status, 1);
    const failedBoots = existsSync(bootLog)
      ? readFileSync(bootLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(Number)
      : [];
    assert.equal(failedBoots.length, 1);
    for (const pid of failedBoots) assert.equal(isPidAlive(pid), false, `failed-baseline server pid ${pid} should be terminated`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bootLog, { force: true });
  }
});

test('Playwright warm session reports reachedTests on equality survivor, distinguishes killed comparison tests, and omits reachedTests on unreached edits', () => {
  assert.ok(process.env.PORT, 'Run this fixture with an assigned PORT');
  const root = mkdtempSync(join(tmpdir(), 'tmt-playwright-reached-tests-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pw-reached-tests-e2e', type: 'module' }));
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
    writeFileSync(join(root, 'src/overview.ts'), [
      'export function formatOverview(status: string, count: number): { ready: boolean; hasItems: boolean } {',
      '  const ready = status === "ready";',
      '  const hasItems = count >= 1;',
      '  return { ready, hasItems };',
      '}',
      '',
      'export function unreachedHelper(x: number): number {',
      '  return x + 1;',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'server.mjs'), `
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';

const overviewCode = ts.transpileModule(readFileSync(new URL('./src/overview.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/overview.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(overviewCode);
    return;
  }
  const status = url.searchParams.get('status') ?? 'ready';
  const count = Number(url.searchParams.get('count') ?? 0);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(\`<!doctype html>
    <div id="items"></div>
    <div id="status"></div>
    <script type="module">
      import { formatOverview } from '/overview.js';
      const out = formatOverview(\${JSON.stringify(status)}, \${count});
      document.getElementById('items').textContent = out.hasItems ? 'ITEMS' : 'EMPTY';
      document.getElementById('status').dataset.ready = String(out.ready);
      document.getElementById('status').textContent = 'rendered';
    </script>\`);
});

server.listen(Number(process.env.PORT), '127.0.0.1');
`);

    writeFileSync(join(root, 'e2e/overview.spec.ts'), `
import { expect, test } from '@playwright/test';

test('renders overview items boundary', async ({ page }) => {
  await page.goto('/?status=ready&count=0');
  await expect(page.locator('#items')).toHaveText('EMPTY');
  await page.goto('/?status=ready&count=1');
  await expect(page.locator('#items')).toHaveText('ITEMS');
  await expect(page.locator('#status')).toHaveText('rendered');
});

test('unrelated page load without overview module', async ({ page }) => {
  await page.setContent('<div id="ok">ok</div>');
  await expect(page.locator('#ok')).toHaveText('ok');
});
`);

    const report = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/overview.ts', '--runner', 'playwright', '--mutators', 'full', '--project', 'chromium',
    ]));
    assert.equal(report.operatorExecution, 'session');
    assert.equal(report.evaluation, 'evaluated');

    // 1. Equality survivor: survived without `tests` (failed tests), but with `reachedTests` naming only the reaching Overview test.
    const eqSurvivor = report.mutants.find(
      m => m.location.line === 2 && m.mutatorName === 'EqualityOperator' && m.status === 'survived',
    );
    assert.ok(eqSurvivor, `expected survived EqualityOperator on line 2, got ${JSON.stringify(report.mutants)}`);
    assert.equal(eqSurvivor.evidence, 'reexecuted');
    assert.equal(eqSurvivor.tests, undefined, 'survived mutant must not set `tests` (reserved for killing tests)');
    assert.ok(Array.isArray(eqSurvivor.reachedTests) && eqSurvivor.reachedTests.length === 1);
    assert.equal(eqSurvivor.reachedTests[0].file, 'e2e/overview.spec.ts');
    assert.equal(eqSurvivor.reachedTests[0].name, 'renders overview items boundary');

    // 2. Killed comparison: `tests` names the failing test, distinct from `reachedTests`.
    const killedComparison = report.mutants.find(
      m => m.location.line === 3 && (m.rule === 'comparison-boundary/v1' || m.mutatorName === 'EqualityOperator') && m.status === 'killed',
    );
    assert.ok(killedComparison, 'expected killed comparison on line 3');
    assert.ok(Array.isArray(killedComparison.tests) && killedComparison.tests.length === 1);
    assert.equal(killedComparison.tests[0].name, 'renders overview items boundary');
    assert.ok(Array.isArray(killedComparison.reachedTests) && killedComparison.reachedTests.length === 1);

    // 3. Unreached edit: status is `unreached` with neither `tests` nor `reachedTests`.
    const unreached = report.mutants.find(m => m.location.line === 8 && m.status === 'unreached');
    assert.ok(unreached, 'expected unreached edit on line 8');
    assert.equal(unreached.tests, undefined);
    assert.equal(unreached.reachedTests, undefined);

    // 4. Text output includes compact `(reached by: ...)` hint on the survivor lacking a specialized gap diagnostic.
    const textOutput = exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/overview.ts', '--runner', 'playwright', '--mutators', 'full', '--project', 'chromium', '--format', 'text',
    ]);
    assert.match(textOutput, /EqualityOperator:.*\(reached by: e2e\/overview\.spec\.ts > renders overview items boundary\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Playwright source-rewrite fallback preserves --project and --test filters (single and repeated projects) with unselected specs present, matching warm session scope', () => {
  assert.ok(process.env.PORT, 'Run this fixture with an assigned PORT');
  const root = mkdtempSync(join(tmpdir(), 'tmt-playwright-project-test-filter-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pw-project-test-filter-e2e', type: 'module' }));
    writeFileSync(join(root, 'playwright.config.ts'), `
import { defineConfig } from '@playwright/test';
const port = Number(process.env.PORT);
const baseURL = 'http://127.0.0.1:' + port;
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: { baseURL, browserName: 'chromium' },
  projects: [
    { name: 'chromium' },
    { name: 'chromium-alt' },
  ],
  webServer: { command: 'node server.mjs', url: baseURL, reuseExistingServer: false },
});
`);
    writeFileSync(join(root, 'src/badge.ts'), [
      'export function formatBadge(count: number): string {',
      '  return count >= 1 ? "ACTIVE" : "IDLE";',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'server.mjs'), `
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';

const serveFrozen = process.env.SERVE_FROZEN === '1';
const badgeCode = serveFrozen
  ? 'export function formatBadge(count) { return count >= 1 ? "ACTIVE" : "IDLE"; }'
  : ts.transpileModule(readFileSync(new URL('./src/badge.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/badge.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(badgeCode);
    return;
  }
  const count = Number(url.searchParams.get('count') ?? 1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(\`<!doctype html>
    <div id="badge"></div>
    <script type="module">
      import { formatBadge } from '/badge.js';
      document.getElementById('badge').textContent = formatBadge(\${count});
    </script>\`);
});

server.listen(Number(process.env.PORT), '127.0.0.1');
`);

    writeFileSync(join(root, 'e2e/selected.spec.ts'), `
import { expect, test } from '@playwright/test';

test('checks selected badge', async ({ page }) => {
  await page.goto('/?count=1');
  await expect(page.locator('#badge')).toHaveText('ACTIVE');
  await page.goto('/?count=0');
  await expect(page.locator('#badge')).toHaveText('IDLE');
});
`);

    // Unselected spec intentionally fails so any accidental inclusion causes baseline_error.
    writeFileSync(join(root, 'e2e/unselected.spec.ts'), `
import { expect, test } from '@playwright/test';

test('must not be selected', async () => {
  expect(false).toBe(true);
});
`);

    // 1. Fallback with single --project and single --test: baseline passes with exactly 1 test in 1 project.
    const singleFallbackRun = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/badge.ts',
      '--runner', 'playwright', '--mutators', 'targeted',
      '--project', 'chromium',
      '--test', 'e2e/selected.spec.ts',
    ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, SERVE_FROZEN: '1' } });
    assert.equal(singleFallbackRun.status, 1, `expected exit 1 for unconfirmed frozen fallback, got ${singleFallbackRun.status}\n${singleFallbackRun.stderr}`);
    const singleFallback = JSON.parse(singleFallbackRun.stdout);
    assert.equal(singleFallback.operatorExecution, 'source-rewrite');
    assert.equal(singleFallback.baseline?.status, 'passed');
    assert.equal(singleFallback.baseline?.tests?.length ?? singleFallback.baseline?.tests, 1);
    assert.equal(singleFallback.baseline.tests[0].project, 'chromium');
    assert.equal(singleFallback.baseline.tests[0].file, 'e2e/selected.spec.ts');

    // 2. Fallback with repeated --project flags and single --test: baseline passes with exactly 2 tests (2 projects x 1 spec).
    const multiFallbackRun = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/badge.ts',
      '--runner', 'playwright', '--mutators', 'targeted',
      '--project', 'chromium', '--project', 'chromium-alt',
      '--test', 'e2e/selected.spec.ts',
    ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, SERVE_FROZEN: '1' } });
    assert.equal(multiFallbackRun.status, 1, `expected exit 1 for unconfirmed frozen fallback, got ${multiFallbackRun.status}\n${multiFallbackRun.stderr}`);
    const multiFallback = JSON.parse(multiFallbackRun.stdout);
    assert.equal(multiFallback.operatorExecution, 'source-rewrite');
    assert.equal(multiFallback.baseline?.status, 'passed');
    assert.equal(multiFallback.baseline?.tests?.length ?? multiFallback.baseline?.tests, 2);
    assert.deepEqual(multiFallback.baseline.tests.map(t => t.project).sort(), ['chromium', 'chromium-alt']);
    assert.ok(multiFallback.baseline.tests.every(t => t.file === 'e2e/selected.spec.ts'));

    // 3. Warm session with same --project and --test uses the exact same project and file scope.
    const warmRun = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/badge.ts',
      '--runner', 'playwright', '--mutators', 'targeted',
      '--project', 'chromium',
      '--test', 'e2e/selected.spec.ts',
    ], { ...process.env, SERVE_FROZEN: '0' }));
    assert.equal(warmRun.operatorExecution, 'session');
    assert.equal(warmRun.evaluation, 'evaluated');
    assert.equal(warmRun.baseline?.tests, 1);
    assert.ok(warmRun.mutants.some(m => m.status === 'killed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Playwright flags frozen prebuilt bundle without gap recommendations, reports kills and reachedTests for copied source, and retains unreached for loaded unvisited branches', () => {
  assert.ok(process.env.PORT, 'Run this fixture with an assigned PORT');
  const root = mkdtempSync(join(tmpdir(), 'tmt-playwright-prebuilt-vs-source-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pw-prebuilt-vs-source-e2e', type: 'module' }));
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
    writeFileSync(join(root, 'src/clock.ts'), [
      'export function clockLabel(frozen: boolean, offset: number): string {',
      '  if (frozen) {',
      '    return offset >= 1 ? "FROZEN+" : "FROZEN";',
      '  }',
      '  return offset >= 10 ? "LIVE+" : "LIVE";',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'server.mjs'), `
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ts from 'typescript';

const serveFrozen = process.env.SERVE_FROZEN === '1';
const clockCode = serveFrozen
  ? 'export function clockLabel(frozen, offset) { if (frozen) { return offset >= 1 ? "FROZEN+" : "FROZEN"; } return offset >= 10 ? "LIVE+" : "LIVE"; }'
  : ts.transpileModule(readFileSync(new URL('./src/clock.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/clock.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(clockCode);
    return;
  }
  const offset = Number(url.searchParams.get('offset') ?? 1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(\`<!doctype html>
    <div id="clock"></div>
    <script type="module">
      import { clockLabel } from '/clock.js';
      document.getElementById('clock').textContent = clockLabel(true, \${offset});
    </script>\`);
});

server.listen(Number(process.env.PORT), '127.0.0.1');
`);

    writeFileSync(join(root, 'e2e/clock.spec.ts'), `
import { expect, test } from '@playwright/test';

test('checks frozen clock badge', async ({ page }) => {
  await page.goto('/?offset=1');
  await expect(page.locator('#clock')).toHaveText('FROZEN+');
  await page.goto('/?offset=0');
  await expect(page.locator('#clock')).toHaveText('FROZEN');
});
`);

    // 1. Frozen bundle run: flags unresolved source application and avoids test gap recommendations.
    const frozenJsonRun = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/clock.ts',
      '--runner', 'playwright', '--mutators', 'targeted',
      '--project', 'chromium', '--test', 'e2e/clock.spec.ts',
    ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, SERVE_FROZEN: '1' } });
    assert.equal(frozenJsonRun.status, 1, `expected exit 1 for incomplete frozen bundle run, got ${frozenJsonRun.status}\n${frozenJsonRun.stderr}`);
    const frozenJson = JSON.parse(frozenJsonRun.stdout);
    assert.equal(frozenJson.operatorExecution, 'source-rewrite');
    assert.equal(frozenJson.sessionFallbackReason, 'no-runtime-switch-observations');
    assert.equal(frozenJson.sourceApplication, 'unconfirmed');
    assert.equal(frozenJson.evaluation, 'incomplete');
    assert.equal(frozenJson.diagnostics.length, 0, 'frozen bundle must not emit test gap recommendations');
    assert.ok(frozenJson.mutants.length >= 1);
    assert.ok(frozenJson.mutants.every(m => m.status === 'unevaluated' && m.sourceVerdict === 'survived'));

    const frozenTextRun = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/clock.ts',
      '--runner', 'playwright', '--mutators', 'targeted',
      '--project', 'chromium', '--test', 'e2e/clock.spec.ts',
      '--format', 'text',
    ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, SERVE_FROZEN: '1' } });
    assert.equal(frozenTextRun.status, 1, frozenTextRun.stderr);
    const frozenText = frozenTextRun.stdout;
    assert.match(frozenText, /Warning: no runtime switch observations were recorded and source-rewrite edits may not have reached the app/);
    assert.match(frozenText, /external daemon or serves a prebuilt UI bundle/);
    assert.doesNotMatch(frozenText, /Test gaps:/);

    // 2. Copied-source run: warm session reports kills with reaching test identities,
    //    while the unvisited branch (line 5) retains its existing `unreached` status.
    const sourceJson = JSON.parse(exec(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/clock.ts',
      '--runner', 'playwright', '--mutators', 'targeted',
      '--project', 'chromium', '--test', 'e2e/clock.spec.ts',
    ], { ...process.env, SERVE_FROZEN: '0' }));
    assert.equal(sourceJson.operatorExecution, 'session');
    assert.equal(sourceJson.evaluation, 'evaluated');
    assert.equal(sourceJson.sourceApplication, undefined);
    const killed = sourceJson.mutants.find(m => m.location.line === 3 && m.status === 'killed');
    assert.ok(killed, `expected killed mutant on line 3, got ${JSON.stringify(sourceJson.mutants)}`);
    assert.ok(Array.isArray(killed.reachedTests) && killed.reachedTests.length === 1);
    assert.equal(killed.reachedTests[0].file, 'e2e/clock.spec.ts');
    assert.equal(killed.reachedTests[0].name, 'checks frozen clock badge');

    const unreachedBranch = sourceJson.mutants.find(m => m.location.line === 5 && m.status === 'unreached');
    assert.ok(unreachedBranch, `expected unreached mutant on unvisited branch (line 5), got ${JSON.stringify(sourceJson.mutants)}`);
    assert.equal(unreachedBranch.reachedTests, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
