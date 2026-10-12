// Reads the kernel audit records of a fork-path analysis: which programs it started, and which of
// them its allowlist doesn't hold.

import { posix } from 'node:path'

export type Launch = {
  pid: number
  ppid: number
  // The file the process asked to run, resolved against its working directory. For a script, the
  // script rather than its interpreter, which the kernel reports as the executable.
  program: string
  cwd: string
  argv: string[]
}

type Records = {
  fields: Map<string, string>
  arguments: Map<number, string[]>
  items: Map<number, string>
  cwd?: string
}

// System call numbers by architecture: 64-bit and 32-bit x86. A process could switch to the 32-bit
// calls to pass unseen, so the rules cover both.
const CALLS: Record<string, { exec: number[]; fork: number[] }> = {
  c000003e: { exec: [59, 322], fork: [56, 57, 58, 435] },
  '40000003': { exec: [11, 358], fork: [2, 120, 190, 435] }
}

// Programs that start containers: they run on behalf of a daemon, outside the analysis' process tree.
const CONTAINERS = /^(?:runc|crun|runsc|conmon|docker-init|containerd-shim.*)$/

// Values the kernel writes unquoted are hexadecimal, unless they are numbers or "(null)": it encodes
// any value holding spaces, quotes or control characters, so a quoted value never holds a quote.
function decode(value: string): string {
  if (value.startsWith('"')) return value.slice(1, -1)
  if (value === '(null)' || !/^(?:[0-9A-F]{2})+$/.test(value)) return value
  return Buffer.from(value, 'hex').toString('utf8')
}

function fields(line: string): Map<string, string> {
  const map = new Map<string, string>()
  // Values never hold spaces, so fields split on them. auditd ends each line with a group separator,
  // followed by its own readable fields, if any.
  for (const field of (line.split('\x1d')[0] ?? '').split(' ')) {
    const equals = field.indexOf('=')
    if (equals > 0) map.set(field.slice(0, equals), field.slice(equals + 1))
  }
  return map
}

function groupEvents(log: string): Map<string, Records> {
  const events = new Map<string, Records>()
  for (const line of log.split('\n')) {
    const serial = /msg=audit\([\d.]+:(\d+)\)/.exec(line)?.[1]
    const type = /(?:^|\s)type=(\w+)/.exec(line)?.[1]
    if (!serial || !type) continue
    let event = events.get(serial)
    if (!event) {
      event = { fields: new Map(), arguments: new Map(), items: new Map() }
      events.set(serial, event)
    }
    const values = fields(line)
    if (type === 'SYSCALL') event.fields = values
    else if (type === 'CWD') event.cwd = decode(values.get('cwd') ?? '')
    else if (type === 'PATH') {
      event.items.set(
        Number(values.get('item')),
        decode(values.get('name') ?? '')
      )
    } else if (type === 'EXECVE') addArguments(event, values)
  }
  return events
}

function addArguments(event: Records, values: Map<string, string>): void {
  for (const [key, value] of values) {
    // Long arguments come in numbered chunks: a1[0]=… a1[1]=…, each encoded on its own.
    const argument = /^a(\d+)(?:\[(\d+)\])?$/.exec(key)
    if (!argument) continue
    const index = Number(argument[1])
    const chunks = event.arguments.get(index) ?? []
    chunks[Number(argument[2] ?? 0)] = decode(value)
    event.arguments.set(index, chunks)
  }
}

export function parse(log: string): {
  launches: Launch[]
  parents: Map<number, number>
} {
  const launches: Launch[] = []
  const forks = new Map<number, number>()
  const starts = new Map<number, number>()
  for (const event of groupEvents(log).values()) {
    const calls = CALLS[event.fields.get('arch') ?? '']
    const call = Number(event.fields.get('syscall'))
    if (!calls || event.fields.get('success') !== 'yes') continue
    const pid = Number(event.fields.get('pid'))
    if (calls.fork.includes(call)) {
      forks.set(Number(event.fields.get('exit')), pid)
    } else if (calls.exec.includes(call)) {
      const cwd = event.cwd ?? '/'
      const name = event.items.get(0)
      const program =
        name && name !== '(null)'
          ? posix.resolve(cwd, name)
          : decode(event.fields.get('exe') ?? '')
      const argv = [...event.arguments.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, chunks]) => chunks.join(''))
      const ppid = Number(event.fields.get('ppid'))
      launches.push({ pid, ppid, program, cwd, argv })
      starts.set(pid, ppid)
    }
  }
  // A start reports the parent at that moment: for an orphan, the process that adopted it. The fork
  // record holds the real parent, so it wins.
  return { launches, parents: new Map([...starts, ...forks]) }
}

// Patterns are absolute paths where * stands for any characters but /, and ** for any characters.
// ${NAME} stands for that environment variable's value.
export function allowlist(
  text: string,
  environment: Record<string, string | undefined>
): RegExp[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const expanded = line.replaceAll(/\$\{(\w+)\}/g, (_, name: string) => {
        const value = environment[name]
        if (!value)
          throw new Error(`The allowlist uses \${${name}}, which is not set.`)
        return value
      })
      const pattern = expanded
        .split(/(\*\*|\*)/)
        .map((part) => {
          if (part === '**') return '.*'
          if (part === '*') return '[^/]*'
          return part.replaceAll(/[\\^$.|?+()[\]{}]/g, String.raw`\$&`)
        })
        .join('')
      return new RegExp(`^${pattern}$`)
    })
}

// The scanner and everything it starts. The scanner runs several programs in its own process. The
// action starts it after its own git and unzip, which stay out. Only a scanner below the action's
// process counts: the one running its dist/index.js.
export function check(
  log: string,
  allowed: RegExp[]
): { started: Launch[]; unexpected: Launch[]; containers: Launch[] } {
  const { launches, parents } = parse(log)
  const below = (pid: number, roots: Set<number>): boolean => {
    const seen = new Set<number>()
    for (
      let parent = parents.get(pid);
      parent !== undefined;
      parent = parents.get(parent)
    ) {
      if (roots.has(parent)) return true
      if (seen.has(parent)) return false
      seen.add(parent)
    }
    return false
  }
  const pids = (list: Launch[]): Set<number> =>
    new Set(list.map((launch) => launch.pid))
  const actions = pids(
    launches.filter((launch) => launch.argv[1]?.endsWith('/dist/index.js'))
  )
  const scanners = launches.filter(
    (launch) =>
      below(launch.pid, actions) &&
      posix.basename(launch.program) === 'sonar-scanner'
  )
  if (scanners.length === 0) {
    throw new Error('The records hold no scanner started by the action.')
  }
  const roots = pids(scanners)
  const started = launches.filter(
    (launch) => roots.has(launch.pid) || below(launch.pid, roots)
  )
  return {
    started,
    unexpected: started.filter(
      (launch) => !allowed.some((pattern) => pattern.test(launch.program))
    ),
    containers: launches.filter((launch) =>
      CONTAINERS.test(posix.basename(launch.program))
    )
  }
}
