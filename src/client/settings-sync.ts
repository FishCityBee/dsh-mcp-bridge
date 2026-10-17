/** Serial writes + optimistic overlays; a failed edit removes only its own patch. */
export class SettingsSync<T extends object> {
  private confirmed?: T
  private edits: { id: number; patch: Partial<T> }[] = []
  private revision = 0
  private readSequence = 0
  private writing: Promise<void> = Promise.resolve()
  constructor(private readonly io: {
    read(): Promise<T>
    write(patch: Partial<T>): Promise<T>
    publish(value: T | undefined, saving: boolean, error: string | null): void
  }) {}
  private publish(error: string | null = null) {
    const value = this.confirmed && Object.assign({}, this.confirmed, ...this.edits.map(e => e.patch))
    this.io.publish(value, this.edits.length > 0, error)
  }
  async load(): Promise<void> {
    const sequence = ++this.readSequence, revision = this.revision
    try {
      const value = await this.io.read()
      if (sequence !== this.readSequence || revision !== this.revision || this.edits.length) return
      this.confirmed = value
      this.publish()
    } catch (error) {
      if (sequence === this.readSequence && revision === this.revision && !this.edits.length) this.publish(`读取配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  save(patch: Partial<T>): Promise<void> {
    const edit = { id: ++this.revision, patch }
    this.edits.push(edit)
    this.publish()
    const operation = this.writing.then(async () => {
      let error: string | null = null
      try { this.confirmed = await this.io.write(patch) } catch (e) { error = `保存失败：${e instanceof Error ? e.message : String(e)}` }
      this.edits = this.edits.filter(e => e.id !== edit.id)
      this.revision++
      this.publish(error)
    })
    this.writing = operation
    return operation
  }
}
