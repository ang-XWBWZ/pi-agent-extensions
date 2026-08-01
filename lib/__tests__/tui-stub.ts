export function getKeybindings() {
  return {
    getKeys(_binding: string): string[] {
      return ["ctrl+o"];
    },
  };
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [""];
  if (line.length === 0) return [""];
  const lines: string[] = [];
  for (let offset = 0; offset < line.length; offset += width) {
    lines.push(line.slice(offset, offset + width));
  }
  return lines;
}

export class Text {
  private text: string;

  constructor(
    text: string,
    _paddingX = 0,
    _paddingY = 0,
  ) {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return this.text.split("\n").flatMap((line) => wrapLine(line, width));
  }
}

export class Container {
  private children: Array<{ render(width: number): string[] }> = [];

  clear(): void {
    this.children = [];
  }

  addChild(child: { render(width: number): string[] }): void {
    this.children.push(child);
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

export function truncateToWidth(text: string, width: number, suffix = "..."): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (suffix.length >= width) return suffix.slice(0, width);
  return `${text.slice(0, width - suffix.length)}${suffix}`;
}
