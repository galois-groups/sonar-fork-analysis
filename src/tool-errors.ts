import { StringDecoder } from 'node:string_decoder'
import type { BuildTool } from './build-tool.js'
import { redacted } from './secrets.js'

const LINES = 20
const WIDTH = 300
// Enough of a line to match it and cut it, so a hostile one of any length takes no more.
const KEPT = 1_000

type Stream = { decoder: StringDecoder; rest: string; inside: boolean }

// The lines of a tool's output that say why it failed, for the job summary. Maven and Gradle end with
// a block that starts with the cause; the scanners print the cause last.
export class ErrorLines {
  private readonly kept: string[] = []
  private readonly streams: Stream[] = []

  // exec's own line listeners split only at the platform's line ending, which Node's output doesn't
  // use on Windows, and they never get a last line without one.
  readonly stdout = this.listener()
  readonly stderr = this.listener()

  constructor(private readonly tool: BuildTool['name']) {}

  // After the tool exits, with each stream's last line if it had no line ending.
  end(): string[] {
    for (const stream of this.streams) {
      const last = (stream.rest + stream.decoder.end()).slice(0, KEPT)
      stream.rest = ''
      this.add(last, stream)
    }
    return [...this.kept]
  }

  private listener(): (data: Buffer) => void {
    const stream: Stream = {
      decoder: new StringDecoder('utf8'),
      rest: '',
      inside: false
    }
    this.streams.push(stream)
    return (data) => {
      const parts = stream.decoder.write(data).split('\n')
      const last = parts.pop() ?? ''
      for (const part of parts) {
        this.add(stream.rest + part.slice(0, KEPT), stream)
        stream.rest = ''
      }
      stream.rest = (stream.rest + last).slice(0, KEPT)
    }
  }

  private add(line: string, stream: Stream): void {
    const plain = line.trimEnd()
    if (plain === '' || !this.wanted(plain, stream)) return
    // Before the cut, which could leave part of a secret.
    const whole = redacted(plain)
    const cut = whole.length > WIDTH ? `${whole.slice(0, WIDTH)}…` : whole
    if (this.tool === 'maven' || this.tool === 'gradle') {
      if (this.kept.length < LINES) this.kept.push(cut)
    } else {
      this.kept.push(cut)
      if (this.kept.length > LINES) this.kept.shift()
    }
  }

  private wanted(line: string, stream: Stream): boolean {
    switch (this.tool) {
      case 'maven':
        if (line.startsWith('[ERROR] Failed to execute goal '))
          stream.inside = true
        // The block ends with Maven's help links.
        if (!line.startsWith('[ERROR] ') || line.startsWith('[ERROR] -> '))
          stream.inside = false
        return stream.inside
      case 'gradle':
        if (line === '* What went wrong:') {
          stream.inside = true
          return false
        }
        if (line.startsWith('* ')) stream.inside = false
        return stream.inside
      case 'scanner':
        return /^\d{2}:\d{2}:\d{2}\.\d{3} ERROR /.test(line)
      case 'npm':
        return line.startsWith('[ERROR] ')
    }
  }
}

// Its message is the action's own words: the job summary shows it as a sentence.
export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly lines: string[]
  ) {
    super(message)
  }
}
