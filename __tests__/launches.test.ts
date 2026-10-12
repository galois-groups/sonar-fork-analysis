import { describe, expect, it } from 'vitest'
import { allowlist, check, parse } from '../scripts/launches.js'

const hex = (text: string): string =>
  Buffer.from(text).toString('hex').toUpperCase()

let serial = 100
// One event as auditd writes it: the system call, then its arguments, directory and paths.
function exec(
  pid: number,
  ppid: number,
  name: string,
  argv: string[],
  {
    cwd = '/home/runner/work/repo/repo',
    arch = 'c000003e',
    syscall = 59,
    success = 'yes'
  } = {}
): string {
  const msg = `msg=audit(1760000000.000:${++serial}):`
  const quote = (value: string): string =>
    value === '(null)' ? value : /[\s"]/.test(value) ? hex(value) : `"${value}"`
  return [
    `type=SYSCALL ${msg} arch=${arch} syscall=${syscall} success=${success} exit=0 a0=1 a1=2 a2=3 a3=4 items=2 ppid=${ppid} pid=${pid} auid=4294967295 uid=1001 comm="x" exe="/usr/bin/dash" key="sonar-fork-analysis"\x1dARCH=x86_64 SYSCALL=execve`,
    `type=EXECVE ${msg} argc=${argv.length} ${argv.map((value, index) => `a${index}=${quote(value)}`).join(' ')}\x1d`,
    `type=CWD ${msg} cwd=${quote(cwd)}\x1d`,
    `type=PATH ${msg} item=0 name=${quote(name)} inode=1 nametype=NORMAL\x1dOUID="runner"`,
    `type=PATH ${msg} item=1 name="/lib64/ld-linux-x86-64.so.2" inode=2 nametype=NORMAL`,
    `type=PROCTITLE ${msg} proctitle=6A617661`
  ].join('\n')
}

function fork(
  parent: number,
  child: number,
  { arch = 'c000003e', syscall = 56 } = {}
): string {
  return `type=SYSCALL msg=audit(1760000000.000:${++serial}): arch=${arch} syscall=${syscall} success=yes exit=${child} a0=1 a1=2 a2=3 a3=4 items=0 ppid=1 pid=${parent} auid=4294967295 uid=1001 comm="x" exe="/usr/bin/x" key="sonar-fork-analysis"`
}

const NODE = '/home/runner/actions-runner/cached/externals/node24/bin/node'
const action = (pid: number): string =>
  exec(pid, 10, NODE, [NODE, '/home/runner/work/_actions/x/dist/index.js'])
const SCANNER = '/home/runner/work/_temp/sonar-scanner-x/bin/sonar-scanner'
// The action at pid 40 and the scanner it started at 41.
const analysis = [
  action(40),
  fork(40, 41),
  exec(41, 40, SCANNER, ['sh', SCANNER])
].join('\n')

describe('parse', () => {
  it('reads the program, directory and arguments of each start', () => {
    const log = exec(
      20,
      11,
      'bin/run',
      ['bin/run', 'two words', 'quote"d', 'plain'],
      {
        cwd: '/tmp/a dir'
      }
    )
    expect(parse(log).launches).toEqual([
      {
        pid: 20,
        ppid: 11,
        program: '/tmp/a dir/bin/run',
        cwd: '/tmp/a dir',
        argv: ['bin/run', 'two words', 'quote"d', 'plain']
      }
    ])
  })

  it('joins arguments the kernel split into chunks', () => {
    const msg = 'msg=audit(1760000000.000:7):'
    const log = [
      `type=SYSCALL ${msg} arch=c000003e syscall=59 success=yes exit=0 ppid=1 pid=2 exe="/usr/bin/x"`,
      `type=EXECVE ${msg} argc=2 a0="x" a1_len=6 a1[0]="abc"`,
      `type=EXECVE ${msg} a1[1]=${hex('d f')}`,
      `type=PATH ${msg} item=0 name="/usr/bin/x"`
    ].join('\n')
    expect(parse(log).launches[0]?.argv).toEqual(['x', 'abcd f'])
  })

  it('leaves out failed starts and reads 32-bit calls', () => {
    const log = [
      exec(20, 11, '/usr/bin/a', ['a'], { success: 'no' }),
      exec(21, 11, '/usr/bin/b', ['b'], { arch: '40000003', syscall: 11 }),
      fork(21, 22, { arch: '40000003', syscall: 190 })
    ].join('\n')
    const { launches, parents } = parse(log)
    expect(launches.map((launch) => launch.program)).toEqual(['/usr/bin/b'])
    expect(parents.get(22)).toBe(21)
  })
})

describe('allowlist', () => {
  const patterns = allowlist(
    '# comment\n\n${HOME}/.sonar/*/bin/java\n/usr/lib/git-core/**\n/usr/bin/git\n',
    { HOME: '/home/runner' }
  )
  const allowed = (path: string): boolean =>
    patterns.some((pattern) => pattern.test(path))

  it('matches * within one directory and ** across them', () => {
    expect(allowed('/home/runner/.sonar/jre/bin/java')).toBe(true)
    expect(allowed('/home/runner/.sonar/a/b/bin/java')).toBe(false)
    expect(allowed('/usr/lib/git-core/a/b')).toBe(true)
  })

  it('matches whole paths only, with dots taken literally', () => {
    expect(allowed('/usr/bin/git2')).toBe(false)
    expect(allowed('/tmp/usr/bin/git')).toBe(false)
    expect(allowlist('/a.b', {})[0]?.test('/axb')).toBe(false)
  })

  it('skips comments and empty lines', () => {
    expect(allowlist('# /usr/bin/x\n\n', {})).toEqual([])
  })

  it('refuses a placeholder without a value', () => {
    expect(() => allowlist('${MISSING}/x', {})).toThrow('${MISSING}')
  })
})

describe('check', () => {
  const allowed = allowlist(`${SCANNER}\n/usr/bin/git\n/usr/bin/java`, {})

  it('keeps only what the scanner started, at any depth', () => {
    const log = [
      exec(30, 10, '/usr/bin/apt', ['apt']),
      action(40),
      exec(41, 40, '/usr/bin/unzip', ['unzip']),
      exec(42, 40, SCANNER, ['sh', SCANNER]),
      fork(42, 43),
      exec(43, 42, '/usr/bin/git', ['git']),
      // A child that forks again before it starts a program.
      fork(43, 44),
      fork(44, 45),
      exec(45, 44, '/home/runner/work/repo/repo/evil', ['./evil'])
    ].join('\n')
    const result = check(log, allowed)
    expect(result.started.map((launch) => launch.program)).toEqual([
      SCANNER,
      '/usr/bin/git',
      '/home/runner/work/repo/repo/evil'
    ])
    expect(result.unexpected.map((launch) => launch.program)).toEqual([
      '/home/runner/work/repo/repo/evil'
    ])
  })

  it("judges a script by its own path, not its interpreter's", () => {
    const log = [
      analysis,
      fork(41, 42),
      exec(42, 41, './gradlew', ['./gradlew'])
    ].join('\n')
    expect(check(log, allowed).unexpected).toHaveLength(1)
  })

  it('links an orphan to the parent that forked it, in either order', () => {
    // The start reports process 1, which adopted the child after its parent exited.
    const start = exec(42, 1, '/usr/bin/x', ['x'])
    for (const log of [
      [analysis, fork(41, 42), start],
      [analysis, start, fork(41, 42)]
    ]) {
      expect(check(log.join('\n'), allowed).unexpected).toHaveLength(1)
    }
  })

  it("checks what the scanner's own process runs next", () => {
    const log = [
      analysis,
      exec(41, 40, '/usr/bin/bash', ['sh', SCANNER]),
      exec(41, 40, '/usr/bin/java', ['java'])
    ].join('\n')
    const result = check(log, allowed)
    expect(result.started.map((launch) => launch.program)).toEqual([
      SCANNER,
      '/usr/bin/bash',
      '/usr/bin/java'
    ])
    expect(result.unexpected.map((launch) => launch.program)).toEqual([
      '/usr/bin/bash'
    ])
  })

  it('takes the executable when the start names no file', () => {
    const log = [analysis, exec(42, 41, '(null)', ['x'])].join('\n')
    expect(check(log, allowed).unexpected[0]?.program).toBe('/usr/bin/dash')
  })

  it('links a start to its parent without a fork record', () => {
    const log = [analysis, exec(42, 41, '/usr/bin/x', ['x'])].join('\n')
    expect(check(log, allowed).unexpected).toHaveLength(1)
  })

  it('reports container starts anywhere on the machine', () => {
    const log = [analysis, exec(50, 1, '/usr/bin/runc', ['runc', 'run'])].join(
      '\n'
    )
    const result = check(log, allowed)
    expect(result.started.map((launch) => launch.program)).toEqual([SCANNER])
    expect(result.containers.map((launch) => launch.program)).toEqual([
      '/usr/bin/runc'
    ])
  })

  it('fails without a scanner started by the action', () => {
    expect(() => check(action(40), allowed)).toThrow('no scanner')
    const elsewhere = [action(40), exec(41, 30, SCANNER, ['sh', SCANNER])].join(
      '\n'
    )
    expect(() => check(elsewhere, allowed)).toThrow('no scanner')
  })
})
