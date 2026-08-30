export class JsonlBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      lines.push(line);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
    }
    return lines;
  }
}
