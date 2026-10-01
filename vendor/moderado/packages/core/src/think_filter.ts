export interface StreamFilterToken {
  type: 'reasoning' | 'assistant';
  delta: string;
}

const START_TAG_REGEX = /^<\s*(think|thought|reasoning)(?:\s+[^>]*)?>/i;
const CLOSE_TAG_REGEX = /^<\s*\/\s*(think|thought|reasoning)\s*>/i;

const PARTIAL_START_REGEX = /^<\s*(t(h(i(n(k)?)?|o(u(g(h(t)?)?)?)?)?)?|r(e(a(s(o(n(i(n(g)?)?)?)?)?)?)?)?)?$/i;
const PARTIAL_CLOSE_REGEX = /^<\s*\/\s*(t(h(i(n(k)?)?|o(u(g(h(t)?)?)?)?)?)?|r(e(a(s(o(n(i(n(g)?)?)?)?)?)?)?)?)?$/i;

export class ThinkTagStreamFilter {
  private inThink = false;
  private buffer = '';
  private leadingWhitespaceBuffer = '';
  private hasEmittedContent = false;
  private stripLeadingNewlineAfterThink = false;

  process(chunk: string): StreamFilterToken[] {
    const tokens: StreamFilterToken[] = [];
    let text = this.buffer + chunk;
    this.buffer = '';

    while (text.length > 0) {
      if (!this.inThink) {
        if (this.stripLeadingNewlineAfterThink) {
          text = text.replace(/^[\r\n]+/, '');
          if (text.length > 0 && !/^[\r\n]+$/.test(text)) {
            this.stripLeadingNewlineAfterThink = false;
          }
        }

        // Preamble check: if we haven't emitted anything yet, buffer pure whitespace
        // in case it precedes an immediate <think> tag
        if (!this.hasEmittedContent && !this.stripLeadingNewlineAfterThink) {
          if (/^\s+$/.test(text)) {
            this.leadingWhitespaceBuffer += text;
            break;
          }
          if (/^\s+/.test(text)) {
            const wsMatch = text.match(/^\s+/);
            if (wsMatch) {
              this.leadingWhitespaceBuffer += wsMatch[0];
              text = text.slice(wsMatch[0].length);
            }
          }
        }

        const openIdx = text.indexOf('<');
        if (openIdx === -1) {
          // No '<' found
          if (this.leadingWhitespaceBuffer.length > 0) {
            tokens.push({ type: 'assistant', delta: this.leadingWhitespaceBuffer });
            this.leadingWhitespaceBuffer = '';
            this.hasEmittedContent = true;
          }
          if (text.length > 0) {
            tokens.push({ type: 'assistant', delta: text });
            this.hasEmittedContent = true;
          }
          break;
        }

        if (openIdx > 0) {
          if (this.leadingWhitespaceBuffer.length > 0) {
            tokens.push({ type: 'assistant', delta: this.leadingWhitespaceBuffer });
            this.leadingWhitespaceBuffer = '';
            this.hasEmittedContent = true;
          }
          const prefix = text.slice(0, openIdx);
          if (prefix.length > 0) {
            tokens.push({ type: 'assistant', delta: prefix });
            this.hasEmittedContent = true;
          }
          text = text.slice(openIdx);
        }

        // text starts with '<'
        const match = text.match(START_TAG_REGEX);
        if (match) {
          this.inThink = true;
          this.leadingWhitespaceBuffer = ''; // Discard preamble before think
          text = text.slice(match[0].length);
          continue;
        }

        if (PARTIAL_START_REGEX.test(text)) {
          this.buffer = text;
          break;
        }

        // Not a think tag. Emit '<' as assistant content
        if (this.leadingWhitespaceBuffer.length > 0) {
          tokens.push({ type: 'assistant', delta: this.leadingWhitespaceBuffer });
          this.leadingWhitespaceBuffer = '';
          this.hasEmittedContent = true;
        }
        tokens.push({ type: 'assistant', delta: text[0] });
        this.hasEmittedContent = true;
        text = text.slice(1);
      } else {
        // inThink is true
        const closeIdx = text.indexOf('<');
        if (closeIdx === -1) {
          tokens.push({ type: 'reasoning', delta: text });
          break;
        }

        if (closeIdx > 0) {
          tokens.push({ type: 'reasoning', delta: text.slice(0, closeIdx) });
          text = text.slice(closeIdx);
        }

        // text starts with '<'
        const match = text.match(CLOSE_TAG_REGEX);
        if (match) {
          this.inThink = false;
          this.stripLeadingNewlineAfterThink = true;
          text = text.slice(match[0].length).replace(/^[\r\n]+/, '');
          continue;
        }

        if (PARTIAL_CLOSE_REGEX.test(text)) {
          this.buffer = text;
          break;
        }

        tokens.push({ type: 'reasoning', delta: text[0] });
        text = text.slice(1);
      }
    }

    return tokens;
  }

  flush(): StreamFilterToken[] {
    const tokens: StreamFilterToken[] = [];
    if (this.leadingWhitespaceBuffer.length > 0) {
      if (!this.inThink) {
        tokens.push({ type: 'assistant', delta: this.leadingWhitespaceBuffer });
      }
      this.leadingWhitespaceBuffer = '';
    }
    if (this.buffer.length > 0) {
      if (this.inThink) {
        tokens.push({ type: 'reasoning', delta: this.buffer });
      } else {
        tokens.push({ type: 'assistant', delta: this.buffer });
      }
      this.buffer = '';
    }
    return tokens;
  }
}
